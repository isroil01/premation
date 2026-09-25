/**
 * The export supervisor — desktop export as a job queue OWNED BY MAIN, with
 * each job rendered in a hidden BrowserWindow of its own.
 *
 * This is T2 step 2 of docs/NATIVE_CORE_PLAN.md. Step 1 (raw RGBA to ffmpeg
 * over `render:streamChunk`, hardware encoders) is reused unchanged: the hidden
 * window runs the SAME `src/core/cli/headlessRender.ts` the `premation render`
 * CLI runs, so its frames leave through the same sink into the same ffmpeg
 * child that main already owns. What moves here is the QUEUE — which job is
 * running, what it has got to, what happens when something dies.
 *
 * Why a window per job, and why main holds the state:
 *
 *  - **A renderer crash cannot kill a render.** The editor window is not
 *    involved once a job is queued: the spec and a snapshot of the project on
 *    disk are all a job needs, and both live outside the editor's process.
 *    Close the editor, crash it, reload it — the hidden window keeps drawing.
 *  - **A render crash cannot kill the editor.** An OOM on an 8K comp takes
 *    down the hidden window's renderer process and nothing else. The job goes
 *    to `failed` with the reason, the window is destroyed, its ffmpeg child is
 *    killed and its staging dir removed. The editor is not told anything it
 *    has to survive; it is told a job failed.
 *  - **Never a reused JS context.** `restoreDocument` MERGES (see
 *    packages/render-worker/electron/main.cjs), so a second job in the same
 *    window would inherit the first job's comps and timelines. One window, one
 *    job, destroyed at the end whatever the outcome.
 *
 * The queue is persisted to `<userData>/export-queue.json` (temp-then-rename,
 * like every other file this app writes) so it survives a restart. A job that
 * was ACTIVE when the process died comes back `failed` — a streamed encode has
 * nothing to resume from — and can be retried from its snapshot with one call.
 *
 * Everything Electron-specific is injected (`SupervisorDeps`), which is what
 * lets `exportProcess.test.ts` run the state machine against a fake window and
 * a fake disk. The real wiring is `createExportSupervisor` at the bottom.
 */

import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { writeFileAtomic } from './atomicWrite';
import { hiddenRenderWebPreferences, rendererEntry } from './cliRender';
import { handle, on } from './ipcGuard';
import {
  engineIneligible,
  startEngineExport,
  type EngineExportCallbacks,
  type EngineExportRun,
} from './engineExport';
import { resolveEngineExecutable } from './engineSupervisor';
import { resolveFfmpegBinary } from './ffmpegBinary';

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

/** The statuses in which a job holds a window. */
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
   * Which renderer is producing (or produced) the current attempt: `engine`
   * (premation-engine --export, F1) or `chromium` (a hidden window). Absent on
   * records written before F1 and on jobs that have not started.
   */
  renderer?: 'engine' | 'chromium';
}

export type ExportQueueEvent =
  | { type: 'snapshot'; jobs: ExportJobRecord[] }
  | { type: 'job'; job: ExportJobRecord };

/** What the hidden window is handed when it asks for its job — the CLI's own shape. */
export type WorkerTask = { kind: 'render'; job: Omit<ExportJobSpec, 'label' | 'totalFrames'> };

/** What the hidden window reports when it is finished — the CLI's own shape. */
export type WorkerReport =
  | { ok: true; outPath: string; frames: number; warnings?: string[] }
  | { ok: false; message: string };

/** A hidden window, as the supervisor sees it. The real one wraps BrowserWindow. */
export interface WorkerWindow {
  /** The `webContents.id` — how a worker's IPC is matched to its job. */
  readonly id: number;
  load(): Promise<void>;
  destroy(): void;
  isDestroyed(): boolean;
  /** `gone` = renderer process died, `unresponsive` = hung, `fail-load` = the app did not load. */
  on(event: 'gone' | 'unresponsive' | 'fail-load', cb: (detail: string) => void): void;
}

/**
 * F1: runs a job in premation-engine instead of a window (electron/engineExport.ts).
 * Injected so the state machine is tested against a fake engine.
 */
export interface EngineLauncher {
  /** Why this spec renders in a window (null = the engine may take it). */
  ineligible(spec: ExportJobSpec): string | null;
  start(jobId: string, spec: ExportJobSpec, cb: EngineExportCallbacks): EngineExportRun;
}

export interface SupervisorDeps {
  createWindow(): WorkerWindow;
  /** F1: the engine path; absent/null = every job renders in a window (the default). */
  engine?: EngineLauncher | null;
  /** The queue file. `read` resolves null when there is none yet. */
  persist: { read(): Promise<string | null>; write(text: string): Promise<void> };
  /** Create the job's snapshot directory and return the project path inside it. */
  prepareSnapshot(id: string): Promise<string>;
  /** Delete a job's snapshot directory (best-effort). */
  removeSnapshot(id: string): Promise<void>;
  /**
   * Kill the ffmpeg children and remove the staging dirs of every render job
   * a window created (`render:beginJob` is keyed by sender). Called whenever a
   * window is torn down before its job completed.
   */
  abortRenderJobsOwnedBy(webContentsId: number): void | Promise<void>;
  /** Windows rendering at once. Default 1 (`MOTION_EXPORT_MAX_CONCURRENT`). */
  maxConcurrent?: number;
  /** How long a window has to boot and ask for its job. */
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
 * shows it — rather than queueing a job that fails minutes later in a window
 * nobody can see.
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

/** A running job: its window or its engine process, and its clocks. */
interface Run {
  jobId: string;
  /** The hidden window rendering it (the Chromium path). */
  win: WorkerWindow | null;
  /** The engine job rendering it (F1); replaced by `win` when it falls back. */
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
  /** webContents id → job id, so a worker can only ever reach its own job. */
  private readonly bySender = new Map<number, string>();
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
   * ended is failed with a stated reason: its window, its ffmpeg child and its
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

  /** Jobs holding a window right now. */
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

    const run: Run = { jobId: job.id, win: null, engine: null, watchdog: null, renderStartedAt: null, lastEmitAt: 0, settled: false };
    this.runs.set(job.id, run);
    const engine = this.deps.engine;
    const why = engine ? engine.ineligible(job.spec) : 'off';
    if (engine && why === null) {
      this.startEngine(job, run, engine);
      return;
    }
    if (engine && why !== 'off') this.log(`job ${job.id}: rendering in a window (${why})`);
    this.startWindow(job, run);
  }

  /** F1: the job in premation-engine; a `fallback` outcome continues it in a window. */
  private startEngine(job: ExportJobRecord, run: Run, engine: EngineLauncher): void {
    job.renderer = 'engine';
    let started = false;
    const handle = engine.start(job.id, job.spec, {
      started: () => {
        if (run.settled || run.engine !== handle) return;
        started = true;
        this.kick(run);
      },
      progress: (fraction) => {
        if (run.settled || run.engine !== handle) return;
        this.progressOf(job, run, fraction);
      },
    });
    run.engine = handle;
    // Preflight + GPU start share the window path's boot clock.
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
          // Not delivered, nothing to undo: the same attempt continues on the
          // Chromium path, which is the reference renderer.
          this.log(`job ${job.id}: engine → window (${outcome.kind === 'fallback' ? outcome.reason : 'unknown'})${started ? ' after it had started' : ''}`);
          run.engine = null;
          run.renderStartedAt = null;
          job.progress = freshProgress(job.spec.totalFrames);
          job.status = 'preparing';
          this.startWindow(job, run);
      }
    });
  }

  private startWindow(job: ExportJobRecord, run: Run): void {
    job.renderer = 'chromium';
    let win: WorkerWindow;
    try {
      win = this.deps.createWindow();
    } catch (err) {
      this.settle(job, 'failed', `Could not open a render window: ${(err as Error).message}`);
      return;
    }
    run.win = win;
    this.bySender.set(win.id, job.id);

    // Every window event is ignored once this run has settled: a renderer
    // that dies AFTER reporting success (the window is being destroyed) must
    // not rewrite a completed job as failed.
    win.on('gone', (reason) => {
      if (run.settled) return;
      this.settle(
        job,
        'failed',
        `The export renderer stopped unexpectedly (${reason}). `
          + 'A very large composition can exhaust memory; try a smaller scale or a shorter range.',
      );
    });
    win.on('unresponsive', () => {
      if (!run.settled) this.settle(job, 'failed', 'The export renderer stopped responding.');
    });
    win.on('fail-load', (detail) => {
      if (!run.settled) this.settle(job, 'failed', `The editor could not be loaded (${detail}).`);
    });

    this.arm(run, this.bootTimeoutMs, () =>
      this.settle(
        job,
        'failed',
        `The export renderer did not start within ${Math.round(this.bootTimeoutMs / 1000)}s. `
          + 'This usually means no GPU is available.',
      ));

    this.persist();
    this.emitJob(job);
    this.log(`job ${job.id} started (${job.spec.label})`);
    win.load().catch((err) => this.settle(job, 'failed', `The render window could not load: ${(err as Error).message}`));
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

  /** The hidden window asks for its job. Null when this sender has none. */
  takeJob(senderId: number): WorkerTask | null {
    const jobId = this.bySender.get(senderId);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    const run = jobId ? this.runs.get(jobId) : undefined;
    if (!job || !run || run.settled) return null;
    this.kick(run);
    if (job.status === 'preparing') {
      job.status = 'rendering';
      this.persist();
      this.emitJob(job);
    }
    const { label: _label, totalFrames: _total, ...request } = job.spec;
    void _label; void _total;
    return { kind: 'render', job: request };
  }

  /** A progress report from the hidden window. */
  reportProgress(senderId: number, fraction: unknown): void {
    const jobId = this.bySender.get(senderId);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    const run = jobId ? this.runs.get(jobId) : undefined;
    if (!job || !run || run.settled) return;
    this.progressOf(job, run, fraction);
  }

  /** Progress from either renderer: restart the stall clock, update the rate, emit (coalesced). */
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

  /** The hidden window's one terminal report. */
  reportDone(senderId: number, report: unknown): void {
    const jobId = this.bySender.get(senderId);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    const run = jobId ? this.runs.get(jobId) : undefined;
    if (!job || !run || run.settled) return;
    const r = report as WorkerReport | null;
    if (!r || typeof r !== 'object') {
      this.settle(job, 'failed', 'The export renderer finished without saying what happened.');
      return;
    }
    if (!r.ok) {
      this.settle(job, 'failed', typeof r.message === 'string' ? r.message : 'Export failed.');
      return;
    }
    job.progress = { ...job.progress, fraction: 1, frame: job.spec.totalFrames, etaSec: 0 };
    if (Array.isArray(r.warnings) && r.warnings.length > 0) job.warnings = r.warnings.map(String);
    if (job.spec.bitDepth === 16) {
      // The window path has 8 bits per channel and nothing more to give.
      job.warnings = [...(job.warnings ?? []), 'Rendered at 8 bits per channel: 16-bit output needs the engine, which could not render this job.'];
    }
    this.settle(job, 'completed');
  }

  /**
   * Every exit goes through here: the window is destroyed, its render jobs in
   * main are torn down unless it completed, the record is written, listeners
   * are told, and the next job starts.
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
      const win = run.win;
      if (win) {
        this.bySender.delete(win.id);
        // ffmpeg first, window second: a window destroyed mid-chunk leaves
        // main's stream waiting on a pipe nobody will write to again.
        if (status !== 'completed') {
          void Promise.resolve(this.deps.abortRenderJobsOwnedBy(win.id)).catch(() => undefined);
        }
        try {
          win.destroy();
        } catch {
          /* already gone */
        }
      }
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
  'export:subscribe',
  'export:chooseOutputPath',
  'export:workerJob',
  'export:workerProgress',
  'export:workerDone',
] as const;

/** The push channel: `ExportQueueEvent`s to every subscribed editor window. */
export const EXPORT_EVENT_CHANNEL = 'export:event';

/**
 * Wire the supervisor to the renderer.
 *
 * Two audiences on one module: the EDITOR (enqueue, cancel, subscribe …) and
 * the hidden WORKER windows (workerJob, workerProgress, workerDone). The worker
 * channels dispatch by `event.sender.id`, so a window can only ever reach the
 * job that was created for it — the same isolation the render-worker service
 * uses, and the reason there is no job id in those messages.
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
  handle('export:subscribe', (e: IpcMainInvokeEvent) => {
    const wc = e.sender;
    if (!subscribers.has(wc)) {
      subscribers.add(wc);
      wc.once('destroyed', () => subscribers.delete(wc));
    }
    return supervisor.list();
  });
  handle('export:chooseOutputPath', (_e, defaultName: string) => chooseOutputPath(String(defaultName ?? 'export.mp4')));

  handle('export:workerJob', (e: IpcMainInvokeEvent) => {
    const task = supervisor.takeJob(e.sender.id);
    if (!task) throw new Error('This window has no export job.');
    return task;
  });
  on('export:workerProgress', (e, fraction: unknown) => supervisor.reportProgress(e.sender.id, fraction));
  on('export:workerDone', (e, report: unknown) => supervisor.reportDone(e.sender.id, report));
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

/** A hidden BrowserWindow with exactly the CLI's preferences, wrapped for the supervisor. */
function electronWorkerWindow(): WorkerWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: hiddenRenderWebPreferences(),
  });
  const wc = win.webContents;
  return {
    id: wc.id,
    on(event, cb) {
      if (event === 'gone') wc.on('render-process-gone', (_e, details) => cb(details.reason));
      else if (event === 'unresponsive') win.on('unresponsive', () => cb('unresponsive'));
      else wc.on('did-fail-load', (_e, code, description) => cb(`${code} ${description}`));
    },
    load() {
      const entry = rendererEntry();
      return 'url' in entry ? win.loadURL(entry.url) : win.loadFile(entry.file, { hash: '/render' });
    },
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
    isDestroyed: () => win.isDestroyed(),
  };
}

/** Where the queue file and the per-job snapshots live. */
export function exportRoot(): string {
  return path.join(app.getPath('userData'), 'export-jobs');
}

/** Build the real supervisor: userData paths, real windows, real disk. */
export function createExportSupervisor(opts: {
  abortRenderJobsOwnedBy(webContentsId: number): void | Promise<void>;
}): ExportSupervisor {
  const root = exportRoot();
  const queueFile = path.join(root, 'export-queue.json');
  return new ExportSupervisor({
    createWindow: electronWorkerWindow,
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
    abortRenderJobsOwnedBy: opts.abortRenderJobsOwnedBy,
    maxConcurrent: positiveInt(process.env.MOTION_EXPORT_MAX_CONCURRENT, 1),
    engine: exportEngineEnabled(process.env) ? createEngineLauncher(root) : null,
  });
}

/** F1's flag: engine export jobs are opt-in until they flip on golden parity (CLAUDE.md). */
export function exportEngineEnabled(env: Record<string, string | undefined>): boolean {
  return env.PREMATION_EXPORT_ENGINE === '1';
}

/** The real engine launcher: premation-engine from the usual places, ffmpeg as the Chromium path finds it. */
function createEngineLauncher(root: string): EngineLauncher {
  const enginePath = resolveEngineExecutable({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath ?? '',
    appPath: app.getAppPath(),
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
  return {
    ineligible: (spec) => engineIneligible(spec, enginePath),
    start: (jobId, spec, cb) => startEngineExport(jobId, spec, cb, deps),
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
