/**
 * The export supervisor — desktop export as a job queue OWNED BY MAIN, each
 * job rendered by its own `premation-engine --export` process
 * (electron/engineExport.ts; NATIVE_CORE_PLAN F1).
 *
 * The C++ engine is the only renderer (docs/TS_ENGINE_REMOVAL.md phase 4):
 * the hidden-window (Chromium / TypeScript) render path and its worker IPC are
 * gone. A spec the engine cannot write, or a frame its preflight refuses,
 * FAILS the job with the engine's reason instead of continuing in a window.
 *
 * Why main holds the state:
 *
 *  - **An editor crash cannot kill a render.** The editor is not involved once
 *    a job is queued: the spec and a snapshot of the project on disk are all a
 *    job needs, and both live outside the editor's process.
 *  - **A render crash cannot kill the editor.** An engine that dies takes its
 *    own ffmpeg child with it (a Windows job object); the job goes to `failed`
 *    with the reason and its staging dir is removed.
 *
 * The queue is persisted to `<userData>/export-queue.json` (temp-then-rename,
 * like every other file this app writes) so it survives a restart. A job that
 * was ACTIVE when the process died comes back `failed` — a streamed encode has
 * nothing to resume from — and can be retried from its snapshot with one call.
 *
 * Everything Electron-specific is injected (`SupervisorDeps`), which is what
 * lets `exportProcess.test.ts` run the state machine against a fake engine and
 * a fake disk. The real wiring is `createExportSupervisor` at the bottom.
 */

import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { writeFileAtomic } from './atomicWrite';
import { handle } from './ipcGuard';
import {
  engineIneligible,
  startEngineExport,
  type EngineExportCallbacks,
  type EngineExportRun,
} from './engineExport';
import { resolveEngineExecutable } from './engineSupervisor';
import { EncoderProbe } from './encoderProbe';
import { resolveFfmpegBinary } from './ffmpegBinary';
import { isHwVideoEncoder } from './ffmpegEncodeArgs';

/*
  ★ The three payload shapes below are DUPLICATED in src/types/motionEditor.d.ts
  (`ExportJobSpec`, `ExportJobRecord`, `ExportQueueEvent`) — for the reason
  renderResume.ts gives for its own pair: the two sides of the IPC boundary are
  separate TypeScript projects that cannot import one another. Keep them in
  step; `exportSupervisorClient.ts` validates what it receives.
*/

/** Where a job is in its life. Terminal states: completed, failed, cancelled. */
export type ExportJobStatus =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** The statuses in which a job holds an engine process. */
export const ACTIVE_STATUSES: ReadonlySet<ExportJobStatus> = new Set(['preparing', 'rendering', 'encoding']);
/** The statuses a job can be retried from. */
export const RETRYABLE_STATUSES: ReadonlySet<ExportJobStatus> = new Set(['failed', 'cancelled']);
/** The statuses a job can be removed from the list in. */
export const TERMINAL_STATUSES: ReadonlySet<ExportJobStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * What one job renders. This IS the CLI's `HeadlessRenderRequest` (the
 * renderer-side type in src/core/cli/headlessRender.ts) plus two fields the
 * queue needs for display: `label` and `totalFrames`. Nothing here is a
 * second serialization of the document — `projectPath` names a project ON
 * DISK, exactly as `premation render <project>` does, and the hidden window
 * opens it through the same `openPath` the editor and the CLI use.
 */
export interface ExportJobSpec {
  /** Absolute path of the snapshot the editor wrote for this job (or a saved project). */
  projectPath: string;
  /** Composition id or name. Absent: the project's first real comp. */
  comp?: string;
  /** Absolute path the finished file is delivered to (overwritten). */
  outPath: string;
  format: string;
  startFrame?: number;
  endFrame?: number;
  fps?: number;
  width?: number;
  height?: number;
  quality?: 'high' | 'medium' | 'draft';
  proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
  transparent?: boolean;
  videoEncoder?: string;
  chapters?: unknown;
  /**
   * Bits per channel handed to the encoder. 16 renders through the engine
   * (F1: `-pix_fmt rgba64le` from a half-float surface) and only for mov
   * (ProRes is 10-bit); a job that falls back to the window renders at 8 and
   * says so in its warnings.
   */
  bitDepth?: 8 | 16;
  /** mov only — an HDR ProRes master (the hdr10 / hlg formats are the MP4 deliveries). */
  hdr?: 'pq' | 'hlg';
  /** HEVC (libx265) or H.264 High 10 for hdr10 / hlg — resolved by the supervisor's probe. */
  hdrEncoder?: 'libx265' | 'libx264';
  /** HDR10 static metadata overrides (nits). */
  hdrMastering?: { maxCll?: number; maxFall?: number; displayMaxNits?: number; displayMinNits?: number };
  /** What the UI calls this job — "Promo → promo.mp4". */
  label: string;
  /** Frames in the range, for progress. */
  totalFrames: number;
}

export interface ExportJobProgress {
  fraction: number;
  frame: number;
  totalFrames: number;
  /** Rendered frames per second since the render started; null until measurable. */
  fps: number | null;
  /** Seconds to go at the current rate; null until measurable. */
  etaSec: number | null;
}

export interface ExportJobRecord {
  id: string;
  spec: ExportJobSpec;
  status: ExportJobStatus;
  /** Higher runs first; ties by creation time. */
  priority: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: ExportJobProgress;
  error?: string;
  warnings?: string[];
  /** How many times this job has been started. 1 on its first run. */
  attempts: number;
  /**
   * Which renderer produced the attempt: `engine` (premation-engine --export).
   * `chromium` survives only on records written before phase 4 (the hidden
   * window path is gone). Absent on jobs that have not started.
   */
  renderer?: 'engine' | 'chromium';
}

export type ExportQueueEvent =
  | { type: 'snapshot'; jobs: ExportJobRecord[] }
  | { type: 'job'; job: ExportJobRecord };

/**
 * Runs a job in premation-engine (electron/engineExport.ts). Injected so the
 * state machine is tested against a fake engine.
 */
export interface EngineLauncher {
  /** Why the engine cannot render this spec (null = it can); the job then fails with it. */
  ineligible(spec: ExportJobSpec): string | null;
  start(jobId: string, spec: ExportJobSpec, cb: EngineExportCallbacks): EngineExportRun;
}

export interface SupervisorDeps {
  /** The engine that renders every job. */
  engine: EngineLauncher;
  /** The queue file. `read` resolves null when there is none yet. */
  persist: { read(): Promise<string | null>; write(text: string): Promise<void> };
  /** Create the job's snapshot directory and return the project path inside it. */
  prepareSnapshot(id: string): Promise<string>;
  /** Delete a job's snapshot directory (best-effort). */
  removeSnapshot(id: string): Promise<void>;
  /** Jobs rendering at once. Default 1 (`MOTION_EXPORT_MAX_CONCURRENT`). */
  maxConcurrent?: number;
  /** How long an engine job has to pass its preflight and start rendering. */
  bootTimeoutMs?: number;
  /** How long a job may make no progress before it is declared stuck. */
  stallTimeoutMs?: number;
  now?(): number;
  log?(message: string): void;
}

/** Same clocks as the CLI, for the same reasons (see cliRender.ts). */
export const DEFAULT_BOOT_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000;

/** Progress events per job are coalesced to this interval; status changes are never delayed. */
const PROGRESS_EMIT_INTERVAL_MS = 250;

/** The message a job interrupted by the process ending is failed with. */
export const INTERRUPTED_MESSAGE = 'The app closed while this export was running. Retry to render it again.';

/** Round to what the UI shows, so a JSON file on disk is not full of 0.3333333. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Validate a spec that arrived over IPC. Throws with a sentence — the renderer
 * shows it — rather than queueing a job that fails minutes later where nobody
 * can see.
 */
export function validateSpec(raw: unknown): ExportJobSpec {
  if (!raw || typeof raw !== 'object') throw new Error('An export job needs a spec.');
  const s = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = s[k];
    if (typeof v !== 'string' || v.length === 0) throw new Error(`Export job: "${k}" must be a non-empty string.`);
    return v;
  };
  const optNum = (k: string): number | undefined => {
    const v = s[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Export job: "${k}" must be a number.`);
    return v;
  };
  const optStr = (k: string): string | undefined => {
    const v = s[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw new Error(`Export job: "${k}" must be a string.`);
    return v;
  };
  const projectPath = str('projectPath');
  const outPath = str('outPath');
  if (!path.isAbsolute(projectPath) || !path.isAbsolute(outPath)) {
    throw new Error('Export job: paths must be absolute.');
  }
  const totalFrames = optNum('totalFrames') ?? 0;
  const quality = optStr('quality');
  if (quality !== undefined && !['high', 'medium', 'draft'].includes(quality)) {
    throw new Error('Export job: unknown quality.');
  }
  const prores = optStr('proresProfile');
  if (prores !== undefined && !['proxy', 'lt', '422', 'hq', '4444'].includes(prores)) {
    throw new Error('Export job: unknown ProRes profile.');
  }
  const out: ExportJobSpec = {
    projectPath,
    outPath,
    format: str('format'),
    label: optStr('label') ?? path.basename(outPath),
    totalFrames: Math.max(1, Math.floor(totalFrames)),
  };
  const comp = optStr('comp');
  if (comp !== undefined) out.comp = comp;
  for (const k of ['startFrame', 'endFrame', 'fps', 'width', 'height'] as const) {
    const v = optNum(k);
    if (v !== undefined) out[k] = v;
  }
  if (quality !== undefined) out.quality = quality as ExportJobSpec['quality'];
  if (prores !== undefined) out.proresProfile = prores as ExportJobSpec['proresProfile'];
  if (typeof s['transparent'] === 'boolean') out.transparent = s['transparent'];
  const enc = optStr('videoEncoder');
  if (enc !== undefined) out.videoEncoder = enc;
  if (Array.isArray(s['chapters']) && s['chapters'].length > 0) out.chapters = s['chapters'];
  const depth = optNum('bitDepth');
  if (depth !== undefined) {
    if (depth !== 8 && depth !== 16) throw new Error('Export job: "bitDepth" must be 8 or 16.');
    if (depth === 16 && out.format !== 'mov') throw new Error('Export job: 16-bit output is written as mov (ProRes) only.');
    out.bitDepth = depth;
  }
  const hdr = optStr('hdr');
  if (hdr !== undefined) {
    if (hdr !== 'pq' && hdr !== 'hlg') throw new Error('Export job: "hdr" must be pq or hlg.');
    if (out.format !== 'mov') throw new Error('Export job: "hdr" is a mov (ProRes) option; the MP4 deliveries are the hdr10 and hlg formats.');
    out.hdr = hdr;
  }
  const m = s['hdrMastering'];
  if (m && typeof m === 'object') {
    const mm: NonNullable<ExportJobSpec['hdrMastering']> = {};
    for (const k of ['maxCll', 'maxFall', 'displayMaxNits', 'displayMinNits'] as const) {
      const v = (m as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10000) mm[k] = v;
    }
    out.hdrMastering = mm;
  }
  return out;
}

/** The order the queue runs in: priority first, then first-come. */
export function compareQueued(a: ExportJobRecord, b: ExportJobRecord): number {
  return b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/** Progress at the start of a run. */
function freshProgress(totalFrames: number): ExportJobProgress {
  return { fraction: 0, frame: 0, totalFrames, fps: null, etaSec: null };
}

/** A running job: its engine process, and its clocks. */
interface Run {
  jobId: string;
  /** The engine job rendering it. */
  engine: EngineExportRun | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  /** When the first frame was reported — the rate is measured from here. */
  renderStartedAt: number | null;
  lastEmitAt: number;
  settled: boolean;
}

export class ExportSupervisor {
  private readonly jobs = new Map<string, ExportJobRecord>();
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(event: ExportQueueEvent) => void>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly bootTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private persistChain: Promise<void> = Promise.resolve();
  /** Set while the app is quitting: nothing new starts. */
  private draining = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 1);
    this.bootTimeoutMs = deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    this.stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((m) => console.log(`[export] ${m}`));
  }

  // ── Persistence ────────────────────────────────────────────────────────

  /**
   * Read the queue back from disk. A job that was active when the process
   * ended is failed with a stated reason: its engine, its ffmpeg child and its
   * half-written stream are gone, and pretending it is still rendering would
   * be a progress bar with nothing behind it.
   */
  async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await this.deps.persist.read();
    } catch {
      raw = null;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log('the export queue file was unreadable and was ignored');
      return;
    }
    const list = parsed && typeof parsed === 'object' ? (parsed as { jobs?: unknown }).jobs : null;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const job = readRecord(item);
      if (!job) continue;
      if (ACTIVE_STATUSES.has(job.status)) {
        job.status = 'failed';
        job.error = INTERRUPTED_MESSAGE;
        job.finishedAt = this.now();
      }
      this.jobs.set(job.id, job);
    }
    this.persist();
  }

  private persist(): void {
    const text = JSON.stringify({ version: 1, jobs: this.list() });
    // Serialised: two writes racing through temp-then-rename can land out of
    // order, and the older queue would then be the one on disk.
    this.persistChain = this.persistChain
      .then(() => this.deps.persist.write(text))
      .catch((err) => this.log(`could not write the export queue: ${(err as Error).message}`));
  }

  /** Resolves once every persist issued so far has landed — for tests and quit. */
  flushed(): Promise<void> {
    return this.persistChain;
  }

  // ── The queue ──────────────────────────────────────────────────────────

  /**
   * What a job may ask for here: every job renders in the engine, and a mov
   * job may ask for 16 bits per channel (rgba64le from the engine's
   * half-float surface).
   */
  capabilities(): { engineExport: boolean; bitDepth16: boolean } {
    return { engineExport: true, bitDepth16: true };
  }

  list(): ExportJobRecord[] {
    return [...this.jobs.values()].map((j) => ({ ...j, spec: { ...j.spec }, progress: { ...j.progress } }));
  }

  get(id: string): ExportJobRecord | undefined {
    return this.jobs.get(id);
  }

  /** Reserve an id and a snapshot directory for a job the editor is about to write. */
  async reserve(): Promise<{ id: string; projectPath: string }> {
    const id = `exp-${this.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    const projectPath = await this.deps.prepareSnapshot(id);
    return { id, projectPath };
  }

  enqueue(rawSpec: unknown, id?: string, priority = 0): ExportJobRecord {
    const spec = validateSpec(rawSpec);
    const jobId = typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : `exp-${this.now().toString(36)}`;
    if (this.jobs.has(jobId)) throw new Error(`Export job "${jobId}" already exists.`);
    const job: ExportJobRecord = {
      id: jobId,
      spec,
      status: 'queued',
      priority: Number.isFinite(priority) ? Math.trunc(priority) : 0,
      createdAt: this.now(),
      progress: freshProgress(spec.totalFrames),
      attempts: 0,
    };
    this.jobs.set(jobId, job);
    this.persist();
    this.emitJob(job);
    this.dispatch();
    return job;
  }

  /** Stop a job. Resolves false when there was nothing to stop. */
  cancel(id: string, reason = 'Cancelled.'): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      this.settle(job, 'cancelled', reason);
      return true;
    }
    if (ACTIVE_STATUSES.has(job.status)) {
      this.settle(job, 'cancelled', reason);
      return true;
    }
    return false;
  }

  /** Re-queue a failed or cancelled job with the same spec. */
  retry(id: string): ExportJobRecord | null {
    const job = this.jobs.get(id);
    if (!job || !RETRYABLE_STATUSES.has(job.status)) return null;
    job.status = 'queued';
    delete job.error;
    delete job.warnings;
    delete job.startedAt;
    delete job.finishedAt;
    job.progress = freshProgress(job.spec.totalFrames);
    this.persist();
    this.emitJob(job);
    this.dispatch();
    return job;
  }

  setPriority(id: string, priority: number): boolean {
    const job = this.jobs.get(id);
    if (!job || !Number.isFinite(priority)) return false;
    job.priority = Math.trunc(priority);
    this.persist();
    this.emitJob(job);
    return true;
  }

  /** Drop a finished job from the list and delete its snapshot. */
  async remove(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || !TERMINAL_STATUSES.has(job.status)) return false;
    this.jobs.delete(id);
    this.persist();
    await this.deps.removeSnapshot(id).catch(() => undefined);
    this.emit({ type: 'snapshot', jobs: this.list() });
    return true;
  }

  /** Jobs rendering right now. */
  activeCount(): number {
    return this.runs.size;
  }

  /** Jobs that are running or waiting to. */
  pendingCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === 'queued' || ACTIVE_STATUSES.has(j.status)) n++;
    return n;
  }

  /** Called once, the next time nothing is running or queued. */
  onIdle(cb: () => void): void {
    if (this.pendingCount() === 0) {
      cb();
      return;
    }
    this.idleWaiters.push(cb);
  }

  /** Stop everything — the app is quitting. Nothing starts after this. */
  cancelAll(reason: string): void {
    this.draining = true;
    for (const job of [...this.jobs.values()]) {
      if (job.status === 'queued' || ACTIVE_STATUSES.has(job.status)) this.settle(job, 'cancelled', reason);
    }
  }

  subscribe(listener: (event: ExportQueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Running ────────────────────────────────────────────────────────────

  /** Start as many queued jobs as the concurrency allows. */
  dispatch(): void {
    if (this.draining) return;
    while (this.runs.size < this.maxConcurrent) {
      const next = [...this.jobs.values()].filter((j) => j.status === 'queued').sort(compareQueued)[0];
      if (!next) break;
      this.start(next);
    }
  }

  private start(job: ExportJobRecord): void {
    job.status = 'preparing';
    job.startedAt = this.now();
    job.attempts += 1;
    job.progress = freshProgress(job.spec.totalFrames);
    delete job.error;

    const run: Run = { jobId: job.id, engine: null, watchdog: null, renderStartedAt: null, lastEmitAt: 0, settled: false };
    this.runs.set(job.id, run);
    const engine = this.deps.engine;
    const why = engine.ineligible(job.spec);
    if (why !== null) {
      this.settle(job, 'failed', `This export cannot be rendered: ${why}.`);
      return;
    }
    this.startEngine(job, run, engine);
  }

  /** The job in premation-engine. */
  private startEngine(job: ExportJobRecord, run: Run, engine: EngineLauncher): void {
    job.renderer = 'engine';
    const handle = engine.start(job.id, job.spec, {
      started: () => {
        if (run.settled || run.engine !== handle) return;
        this.kick(run);
      },
      progress: (fraction) => {
        if (run.settled || run.engine !== handle) return;
        this.progressOf(job, run, fraction);
      },
    });
    run.engine = handle;
    this.arm(run, this.bootTimeoutMs, () =>
      this.settle(job, 'failed', `The export engine did not start rendering within ${Math.round(this.bootTimeoutMs / 1000)}s.`));
    this.persist();
    this.emitJob(job);
    this.log(`job ${job.id} started in the engine (${job.spec.label})`);
    void handle.done.then((outcome) => {
      if (run.settled || run.engine !== handle) return;
      switch (outcome.kind) {
        case 'completed':
          job.progress = { ...job.progress, fraction: 1, frame: job.spec.totalFrames, etaSec: 0 };
          this.settle(job, 'completed');
          return;
        case 'failed':
          this.settle(job, 'failed', outcome.message);
          return;
        case 'cancelled':
          // Only a cancel of ours ends it this way, and that settled the run first.
          this.settle(job, 'cancelled', 'Cancelled.');
          return;
        case 'fallback':
        default:
          // The engine is the only renderer: what it cannot render is a failure, with its reason.
          this.settle(job, 'failed', `The engine could not render this export: ${outcome.kind === 'fallback' ? outcome.reason : 'unknown reason'}.`);
      }
    });
  }

  private arm(run: Run, ms: number, onFire: () => void): void {
    if (run.watchdog) clearTimeout(run.watchdog);
    run.watchdog = setTimeout(onFire, ms);
  }

  /** Every sign of life restarts the stall clock. */
  private kick(run: Run): void {
    const job = this.jobs.get(run.jobId);
    this.arm(run, this.stallTimeoutMs, () =>
      job && this.settle(
        job,
        'failed',
        `The export made no progress for ${Math.round(this.stallTimeoutMs / 60000)} minutes and was stopped.`,
      ));
  }

  /** Progress from the engine: restart the stall clock, update the rate, emit (coalesced). */
  private progressOf(job: ExportJobRecord, run: Run, fraction: unknown): void {
    this.kick(run);
    const f = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
    const now = this.now();
    if (run.renderStartedAt === null) run.renderStartedAt = now;
    const total = job.spec.totalFrames;
    const frame = Math.min(total, Math.round(f * total));
    const elapsedSec = (now - run.renderStartedAt) / 1000;
    const fps = elapsedSec > 0.5 && frame > 0 ? frame / elapsedSec : null;
    const etaSec = fps ? (total - frame) / fps : null;
    job.progress = {
      fraction: f,
      frame,
      totalFrames: total,
      fps: fps === null ? null : round2(fps),
      etaSec: etaSec === null ? null : Math.round(etaSec),
    };
    let statusChanged = false;
    if (job.status === 'preparing') { job.status = 'rendering'; statusChanged = true; }
    // The last frame has been handed to the sink; what remains is the encoder
    // draining and the file moving into place.
    if (f >= 1 && job.status === 'rendering') { job.status = 'encoding'; statusChanged = true; }
    if (statusChanged || now - run.lastEmitAt >= PROGRESS_EMIT_INTERVAL_MS) {
      run.lastEmitAt = now;
      this.emitJob(job);
    }
  }

  /**
   * Every exit goes through here: an unfinished engine job is stopped, the
   * record is written, listeners are told, and the next job starts.
   */
  private settle(job: ExportJobRecord, status: 'completed' | 'failed' | 'cancelled', error?: string): void {
    // A finished job is finished. Belt to the per-run guard above: nothing —
    // a stray timer, a late event — may move a job out of a terminal state
    // except `retry`, which does not come through here.
    if (TERMINAL_STATUSES.has(job.status)) return;
    const run = this.runs.get(job.id);
    if (run) {
      if (run.settled) return;
      run.settled = true;
      if (run.watchdog) clearTimeout(run.watchdog);
      this.runs.delete(job.id);
      // An engine job: its process takes its own ffmpeg child down with it.
      if (run.engine && status !== 'completed') run.engine.cancel();
    }
    job.status = status;
    job.finishedAt = this.now();
    if (error !== undefined) job.error = error;
    else delete job.error;
    this.persist();
    this.emitJob(job);
    this.log(`job ${job.id} ${status}${error ? `: ${error}` : ''}`);
    this.dispatch();
    if (this.pendingCount() === 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const cb of waiters) cb();
    }
  }

  private emitJob(job: ExportJobRecord): void {
    this.emit({ type: 'job', job: { ...job, spec: { ...job.spec }, progress: { ...job.progress } } });
  }

  private emit(event: ExportQueueEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* a listener's failure is not the queue's */
      }
    }
  }
}

/** One record off disk, or null if it is not one. Tolerant: the file is hand-editable. */
function readRecord(v: unknown): ExportJobRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !r['id']) return null;
  let spec: ExportJobSpec;
  try {
    spec = validateSpec(r['spec']);
  } catch {
    return null;
  }
  const status = typeof r['status'] === 'string' && (
    ['queued', 'preparing', 'rendering', 'encoding', 'completed', 'failed', 'cancelled'] as string[]
  ).includes(r['status'])
    ? (r['status'] as ExportJobStatus)
    : 'queued';
  const num = (k: string): number | undefined =>
    typeof r[k] === 'number' && Number.isFinite(r[k] as number) ? (r[k] as number) : undefined;
  const p = r['progress'] && typeof r['progress'] === 'object' ? (r['progress'] as Record<string, unknown>) : {};
  const progress: ExportJobProgress = {
    fraction: typeof p['fraction'] === 'number' ? p['fraction'] : 0,
    frame: typeof p['frame'] === 'number' ? p['frame'] : 0,
    totalFrames: spec.totalFrames,
    fps: typeof p['fps'] === 'number' ? p['fps'] : null,
    etaSec: typeof p['etaSec'] === 'number' ? p['etaSec'] : null,
  };
  const out: ExportJobRecord = {
    id: r['id'],
    spec,
    status,
    priority: num('priority') ?? 0,
    createdAt: num('createdAt') ?? 0,
    progress,
    attempts: num('attempts') ?? 0,
  };
  const startedAt = num('startedAt');
  if (startedAt !== undefined) out.startedAt = startedAt;
  const finishedAt = num('finishedAt');
  if (finishedAt !== undefined) out.finishedAt = finishedAt;
  if (typeof r['error'] === 'string') out.error = r['error'];
  if (Array.isArray(r['warnings'])) out.warnings = r['warnings'].map(String);
  if (r['renderer'] === 'engine' || r['renderer'] === 'chromium') out.renderer = r['renderer'];
  return out;
}

// ── IPC ─────────────────────────────────────────────────────────────────

/** The channels this module registers. Pinned by ipcRegistration.test.ts. */
export const EXPORT_IPC_CHANNELS = [
  'export:reserve',
  'export:enqueue',
  'export:cancel',
  'export:retry',
  'export:setPriority',
  'export:remove',
  'export:list',
  'export:capabilities',
  'export:subscribe',
  'export:chooseOutputPath',
] as const;

/** The push channel: `ExportQueueEvent`s to every subscribed editor window. */
export const EXPORT_EVENT_CHANNEL = 'export:event';

/**
 * Wire the supervisor to the editor (enqueue, cancel, subscribe …).
 */
export function registerExportSupervisorIpc(
  supervisor: ExportSupervisor,
  chooseOutputPath: (defaultName: string) => Promise<string | null> = defaultChooseOutputPath,
): void {
  const subscribers = new Set<WebContents>();
  supervisor.subscribe((event) => {
    for (const wc of subscribers) {
      if (wc.isDestroyed()) {
        subscribers.delete(wc);
        continue;
      }
      wc.send(EXPORT_EVENT_CHANNEL, event);
    }
  });

  handle('export:reserve', () => supervisor.reserve());
  handle('export:enqueue', (_e, req: { id?: string; spec: unknown; priority?: number }) =>
    supervisor.enqueue(req?.spec, req?.id, typeof req?.priority === 'number' ? req.priority : 0));
  handle('export:cancel', (_e, id: string) => supervisor.cancel(String(id)));
  handle('export:retry', (_e, id: string) => supervisor.retry(String(id)));
  handle('export:setPriority', (_e, id: string, priority: number) => supervisor.setPriority(String(id), Number(priority)));
  handle('export:remove', (_e, id: string) => supervisor.remove(String(id)));
  handle('export:list', () => supervisor.list());
  handle('export:capabilities', () => supervisor.capabilities());
  handle('export:subscribe', (e: IpcMainInvokeEvent) => {
    const wc = e.sender;
    if (!subscribers.has(wc)) {
      subscribers.add(wc);
      wc.once('destroyed', () => subscribers.delete(wc));
    }
    return supervisor.list();
  });
  handle('export:chooseOutputPath', (_e, defaultName: string) => chooseOutputPath(String(defaultName ?? 'export.mp4')));
}

/** The save dialog an export's destination is picked in — BEFORE the render, unlike the in-process path. */
async function defaultChooseOutputPath(defaultName: string): Promise<string | null> {
  const ext = path.extname(defaultName).replace('.', '') || 'mp4';
  const res = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
}

// ── Electron wiring ─────────────────────────────────────────────────────

/** Where the queue file and the per-job snapshots live. */
export function exportRoot(): string {
  return path.join(app.getPath('userData'), 'export-jobs');
}

/** Build the real supervisor: userData paths, the real engine, real disk. */
export function createExportSupervisor(): ExportSupervisor {
  const root = exportRoot();
  const queueFile = path.join(root, 'export-queue.json');
  return new ExportSupervisor({
    persist: {
      read: () => readFile(queueFile, 'utf8').catch(() => null),
      write: (text) => writeFileAtomic(queueFile, text, { mkdirp: true }),
    },
    prepareSnapshot: async (id) => {
      const dir = path.join(root, id);
      await mkdir(dir, { recursive: true });
      return path.join(dir, 'project.motion');
    },
    removeSnapshot: (id) => rm(path.join(root, id), { recursive: true, force: true }),
    maxConcurrent: positiveInt(process.env.MOTION_EXPORT_MAX_CONCURRENT, 1),
    engine: createEngineLauncher(root),
  });
}

/** The real engine launcher: premation-engine from the usual places, ffmpeg as main finds it. */
function createEngineLauncher(root: string): EngineLauncher {
  const enginePath = resolveEngineExecutable({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath ?? '',
    // As main's EngineHost: development runs `electron dist-electron/main.js`,
    // whose app path is dist-electron — the repo root (native/build) is one up.
    appPath: app.isPackaged ? app.getAppPath() : path.join(__dirname, '..'),
    platform: process.platform,
    vars: process.env,
    exists: existsSync,
  });
  const deps = {
    enginePath,
    ffmpegPath: () => resolveFfmpegBinary({ vars: process.env, resourcesPath: process.resourcesPath ?? '', platform: process.platform, exists: existsSync }),
    workDirFor: (id: string) => path.join(root, id, 'engine'),
    log: (m: string) => console.log(`[export/engine] ${m}`),
  };
  const probe = new EncoderProbe({ bin: deps.ffmpegPath });
  return {
    ineligible: (spec) => engineIneligible(spec, enginePath),
    start: (jobId, spec, cb) => {
      let handle: ReturnType<typeof startEngineExport> | null = null;
      let abandon = false;
      const done = (async () => {
        let next = spec;
        if (spec.format === 'mp4' && isHwVideoEncoder(spec.videoEncoder)) {
          const resolved = await probe.resolveVideoEncoder(spec.videoEncoder);
          if (resolved.fallbackReason) deps.log(`job ${jobId}: ${resolved.fallbackReason}`);
          next = { ...spec, videoEncoder: resolved.encoder };
        }
        if (spec.format === 'hdr10' || spec.format === 'hlg') {
          // HEVC carries the HDR10 metadata; without libx265 the stream is H.264 High 10, tagged.
          const hdrEncoder = (await probe.has('libx265')) ? 'libx265' as const : 'libx264' as const;
          if (hdrEncoder === 'libx264') deps.log(`job ${jobId}: ffmpeg has no libx265 — H.264 High 10, no HDR10 mastering SEI`);
          next = { ...next, hdrEncoder };
        }
        if (abandon) return { kind: 'cancelled' as const };
        handle = startEngineExport(jobId, next, cb, deps);
        return handle.done;
      })();
      return {
        cancel(): void {
          abandon = true;
          handle?.cancel();
        },
        done,
      };
    },
  };
}

/**
 * Quitting with exports running: ask.
 *
 * The simpler of the two designs the plan allows — cancel on quit, with a
 * confirmation — rather than "keep rendering after the window closes and quit
 * when done". The dialog is native and synchronous because `before-quit` is
 * synchronous: an awaited dialog would let the quit proceed underneath it.
 * "Keep rendering" cancels the quit; the editor window stays (or, if it was
 * already closed, the app runs headless until the queue drains — see
 * `keepAliveForExports`).
 */
export function installExportQuitGuard(supervisor: ExportSupervisor): void {
  let confirmed = false;
  app.on('before-quit', (event) => {
    if (confirmed) return;
    const active = supervisor.pendingCount();
    if (active === 0) return;
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Cancel exports and quit', 'Keep rendering'],
      defaultId: 1,
      cancelId: 1,
      message: `${active} export${active === 1 ? ' is' : 's are'} still rendering.`,
      detail: 'Quitting now stops them; nothing is written for a cancelled export. You can retry them from the Export panel later.',
    });
    if (choice === 1) {
      event.preventDefault();
      return;
    }
    confirmed = true;
    supervisor.cancelAll('The app was quit.');
  });
}

/**
 * Whether the process should stay up with no visible window.
 *
 * `window-all-closed` counts hidden windows too, so it fires between one
 * export's window being destroyed and the next one opening. When jobs remain,
 * the caller returns without quitting and this arranges the quit for when the
 * queue drains — unless a window has been opened again by then.
 */
export function keepAliveForExports(supervisor: ExportSupervisor, quit: () => void): boolean {
  if (supervisor.pendingCount() === 0) return false;
  supervisor.onIdle(() => {
    if (BrowserWindow.getAllWindows().length === 0) quit();
  });
  return true;
}
