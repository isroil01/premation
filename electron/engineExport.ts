/**
 * F1 — an export job rendered by the ENGINE (docs/NATIVE_CORE_PLAN.md Phase F).
 *
 * The export supervisor (exportProcess.ts) runs a job either in a hidden
 * Chromium window (the TypeScript renderer, today's path) or here: one
 * `premation-engine --export JOB.json` process per job, which opens the
 * project snapshot itself, renders the range with several frames in flight and
 * pipes raw RGBA straight into its own ffmpeg child. Nothing crosses Electron
 * but a few JSON lines, so main never touches a pixel.
 *
 * ── One encode, two renderers ─────────────────────────────────────────────
 *
 * The ffmpeg command line is built HERE, by the same `buildEncodeArgs` +
 * `rawVideoInput` + `tagSrgb` the Chromium path's `render:openStream` uses, and
 * handed to the engine after its preflight — the engine never builds one. So
 * "which renderer ran" can only show in the file if the pixels differ.
 *
 * ── When the engine does not run a job ───────────────────────────────────
 *
 *  - Off unless `PREMATION_EXPORT_ENGINE=1` (CLAUDE.md: every native
 *    replacement ships behind a flag with the TypeScript path intact).
 *  - Ineligible specs (`engineIneligible`): JPEG sequences, chapters that are
 *    not already resolved `{startMs,endMs,title}` records, or no engine
 *    executable — the window path, unchanged. PNG and EXR sequences, resolved
 *    chapters, and a probed hardware encoder run in the engine. A hardware
 *    encoder that will not initialise falls back to libx264 before the job starts.
 *  - The engine's PREFLIGHT builds every frame of the range with the C++ scene
 *    builder first; one frame that uses a feature the builder has not ported
 *    (or audio it does not mix) reports `fallback`, and the supervisor renders
 *    the job in the window instead. So do a GPU that will not start, a pass
 *    that cannot be honoured mid-render, and an engine that CRASHES: its
 *    ffmpeg child dies with it (a Windows job object), nothing was delivered,
 *    and the same attempt continues on the Chromium path.
 *  - A failure of the export itself (the encoder, the disk) fails the job, as
 *    it would on the window path.
 *
 * Electron-free: spawn and the file system are injected, so the protocol is
 * tested against a fake engine (engineExport.test.ts).
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildEncodeArgs, rawVideoInput, type EncodeFormat, type VideoEncoder } from './ffmpegEncodeArgs';

/** The spec fields an engine job reads (a subset of exportProcess.ts `ExportJobSpec`). */
export interface EngineExportSpec {
  projectPath: string;
  comp?: string;
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
  /** 16 = rgba64le from the engine's half-float surface (mov only). */
  bitDepth?: 8 | 16;
}

export type EngineExportOutcome =
  | { kind: 'completed'; frames: number; stats?: Record<string, unknown> }
  | { kind: 'fallback'; reason: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

export interface EngineExportRun {
  /** Stop the job; `done` then resolves `cancelled`. Idempotent. */
  cancel(): void;
  readonly done: Promise<EngineExportOutcome>;
}

export interface EngineExportCallbacks {
  /** Frames handed to the encoder, as a fraction of the range. */
  progress(fraction: number): void;
  /** The engine passed its preflight and is rendering. */
  started?(info: EnginePreflight): void;
}

/** What a successful preflight reports (export_job.hpp). */
export interface EnginePreflight {
  frames: number;
  width: number;
  height: number;
  fps: number;
  alpha: boolean;
  /** Bits per channel of the raw frames (8 = rgba, 16 = rgba64le). */
  depth: 8 | 16;
  audio: string | null;
  comp: string;
  compName: string;
}

export interface EngineExportDeps {
  /** premation-engine, or null when it is not built/installed. */
  enginePath: string | null;
  /** The ffmpeg the Chromium path would use (FFMPEG_PATH, bundled, PATH). */
  ffmpegPath(): string;
  /** A fresh working directory for one job (created by the launcher). */
  workDirFor(jobId: string): string;
  spawn?: typeof nodeSpawn;
  fs?: {
    mkdir(p: string): Promise<void>;
    writeFile(p: string, text: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
    rm(p: string): Promise<void>;
  };
  log?(message: string): void;
}

/** The formats the engine path writes: the raw pipe, plus zipped image sequences. */
const ENGINE_FORMATS: ReadonlySet<string> = new Set<string>(['mp4', 'webm', 'mov', 'gif', 'png-sequence', 'jpg-sequence', 'exr-sequence']);

function isSequence(format: string): boolean {
  return format === 'png-sequence' || format === 'jpg-sequence' || format === 'exr-sequence';
}

function resolvedChapters(raw: unknown): Array<{ startMs: number; endMs: number; title: string }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{ startMs: number; endMs: number; title: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const c = item as { startMs?: unknown; endMs?: unknown; title?: unknown };
    if (typeof c.startMs !== 'number' || typeof c.endMs !== 'number' || typeof c.title !== 'string') return null;
    out.push({ startMs: c.startMs, endMs: c.endMs, title: c.title });
  }
  return out;
}

/** Exit codes premation-engine --export documents (native/engine/src/export/export_job.hpp). */
export const EXPORT_EXIT = { ok: 0, failed: 1, fallback: 3, cancelled: 4, usage: 64 } as const;

/**
 * Why `spec` must render in the window, or null when the engine may take it.
 * Pure — the supervisor asks before it starts anything.
 */
export function engineIneligible(spec: EngineExportSpec, enginePath: string | null): string | null {
  if (!enginePath) return 'premation-engine is not available';
  if (!ENGINE_FORMATS.has(spec.format)) return `the engine does not write "${spec.format}"`;
  if (Array.isArray(spec.chapters) && spec.chapters.length > 0 && !resolvedChapters(spec.chapters)) return 'chapters are formatted by the editor';
  return null;
}

function videoEncoderOf(spec: EngineExportSpec): VideoEncoder {
  if (spec.format !== 'mp4') return 'libx264';
  const e = spec.videoEncoder;
  if (e === 'h264_nvenc' || e === 'hevc_nvenc' || e === 'h264_qsv' || e === 'h264_videotoolbox' || e === 'libx264') return e;
  return 'libx264';
}

/** The job file the engine reads (export_job.hpp `parse_job`). */
export function engineJobFile(spec: EngineExportSpec, workDir: string): Record<string, unknown> {
  const job: Record<string, unknown> = { projectPath: spec.projectPath, workDir };
  if (spec.comp) job.comp = spec.comp;
  for (const k of ['startFrame', 'endFrame', 'fps', 'width', 'height'] as const) {
    if (typeof spec[k] === 'number') job[k] = spec[k];
  }
  if (typeof spec.transparent === 'boolean') job.transparent = spec.transparent;
  if (spec.bitDepth === 16) job.depth = 16;
  // A GIF carries no sound (buildEncodeArgs drops it), so the engine skips the mix.
  job.audio = spec.format !== 'gif' && !isSequence(spec.format);
  if (spec.format === 'png-sequence') job.sequence = 'png-zip';
  if (spec.format === 'jpg-sequence') job.sequence = 'jpg-zip';
  if (spec.format === 'exr-sequence') job.sequence = 'exr-zip';
  const chapters = resolvedChapters(spec.chapters);
  if (chapters) job.chapters = chapters;
  return job;
}

/** The encoder command line for a preflighted job — `render:openStream`'s, exactly. */
export function engineEncodeArgs(spec: EngineExportSpec, pre: EnginePreflight, out: string): string[] {
  return buildEncodeArgs({
    format: spec.format as EncodeFormat,
    videoInput: rawVideoInput(pre.width, pre.height, pre.fps, pre.depth === 16 ? 'rgba64le' : 'rgba'),
    frame: { width: pre.width, height: pre.height, fps: pre.fps },
    quality: spec.quality,
    proresProfile: spec.proresProfile,
    audio: pre.audio,
    chaptersFile: resolvedChapters(spec.chapters) && (spec.format === 'mp4' || spec.format === 'mov')
      ? path.join(path.dirname(out), 'chapters.ffmeta')
      : null,
    alpha: pre.alpha,
    videoEncoder: videoEncoderOf(spec),
    tagSrgb: true,
    out,
  });
}

/** Where the engine writes the encode before it is delivered. */
export function engineOutputFile(workDir: string, format: string): string {
  if (format === 'png-sequence') return path.join(workDir, 'frames.png.zip');
  if (format === 'jpg-sequence') return path.join(workDir, 'frames.jpg.zip');
  if (format === 'exr-sequence') return path.join(workDir, 'frames.exr.zip');
  return path.join(workDir, `out.${format}`);
}

const defaultFs: NonNullable<EngineExportDeps['fs']> = {
  mkdir: async (p) => { await mkdir(p, { recursive: true }); },
  writeFile: (p, text) => writeFile(p, text, 'utf8'),
  rename: (a, b) => rename(a, b),
  copyFile: (a, b) => copyFile(a, b),
  rm: (p) => rm(p, { recursive: true, force: true }),
};

/** Move the finished file to where the user asked, across volumes if need be (overwriting, like the CLI). */
async function deliver(fs: NonNullable<EngineExportDeps['fs']>, from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV' && (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    await fs.copyFile(from, to);
    await fs.rm(from);
  }
}

/**
 * Start one engine job. The returned `done` never rejects: every ending is an
 * outcome, and `fallback` is the one that sends the job to the window path.
 */
export function startEngineExport(
  jobId: string,
  spec: EngineExportSpec,
  cb: EngineExportCallbacks,
  deps: EngineExportDeps,
): EngineExportRun {
  const fs = deps.fs ?? defaultFs;
  const log = deps.log ?? ((m: string) => console.log(`[export/engine] ${m}`));
  let child: ChildProcess | null = null;
  let cancelled = false;
  let settle!: (o: EngineExportOutcome) => void;
  const done = new Promise<EngineExportOutcome>((resolve) => { settle = resolve; });
  let settled = false;
  const finish = (o: EngineExportOutcome): void => {
    if (settled) return;
    settled = true;
    settle(o);
  };

  const run = async (): Promise<void> => {
    const engine = deps.enginePath;
    if (!engine) {
      finish({ kind: 'fallback', reason: 'premation-engine is not available' });
      return;
    }
    const workDir = deps.workDirFor(jobId);
    await fs.mkdir(workDir);
    const jobPath = path.join(workDir, 'job.json');
    await fs.writeFile(jobPath, JSON.stringify(engineJobFile(spec, workDir)));
    if (cancelled) {
      finish({ kind: 'cancelled' });
      return;
    }
    const out = engineOutputFile(workDir, spec.format);
    const proc = (deps.spawn ?? nodeSpawn)(engine, ['--export', jobPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = proc;
    let stderrTail = '';
    proc.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + String(d)).slice(-4096); });
    // The engine's stdin is our control channel; its failure is the exit's to report.
    proc.stdin?.on('error', () => undefined);

    let preflight: EnginePreflight | null = null;
    let terminal: EngineExportOutcome | null = null;
    let buffered = '';
    const onLine = (line: string): void => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // a stray library print; the protocol is JSON lines only
      }
      switch (msg.ev) {
        case 'preflight': {
          if (msg.ok !== true) {
            terminal = { kind: 'fallback', reason: `preflight: ${String(msg.reason ?? 'a frame is outside the engine port')}` };
            return;
          }
          preflight = {
            frames: Number(msg.frames),
            width: Number(msg.width),
            height: Number(msg.height),
            fps: Number(msg.fps),
            alpha: msg.alpha === true,
            depth: msg.depth === 16 ? 16 : 8,
            audio: typeof msg.audio === 'string' ? msg.audio : null,
            comp: String(msg.comp ?? ''),
            compName: String(msg.compName ?? ''),
          };
          cb.started?.(preflight);
          if (!isSequence(spec.format)) {
            const encode = { bin: deps.ffmpegPath(), args: engineEncodeArgs(spec, preflight, out) };
            proc.stdin?.write(`${JSON.stringify({ encode })}\n`);
          }
          return;
        }
        case 'progress': {
          const total = Number(msg.total) || preflight?.frames || 1;
          cb.progress(Math.max(0, Math.min(1, Number(msg.frame) / total)));
          return;
        }
        case 'done':
          terminal = { kind: 'completed', frames: Number(msg.frames), stats: (msg.stats ?? undefined) as Record<string, unknown> | undefined };
          return;
        case 'error':
          terminal = msg.fallback === true
            ? { kind: 'fallback', reason: String(msg.message ?? 'the engine could not render this job') }
            : { kind: 'failed', message: String(msg.message ?? 'Export failed.') };
          return;
        default:
      }
    };
    proc.stdout?.on('data', (d: Buffer) => {
      buffered += String(d);
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) onLine(line);
        nl = buffered.indexOf('\n');
      }
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      proc.once('error', (error) => resolve({ code: null, signal: null, error }));
      proc.once('close', (code, signal) => resolve({ code, signal }));
    });
    child = null;
    if (buffered.trim()) onLine(buffered.trim());

    if (cancelled) {
      finish({ kind: 'cancelled' });
      return;
    }
    if (exit.error) {
      finish({ kind: 'fallback', reason: `premation-engine could not start: ${exit.error.message}` });
      return;
    }
    const outcome = terminal as EngineExportOutcome | null;
    if (exit.code === EXPORT_EXIT.ok && outcome?.kind === 'completed') {
      try {
        await deliver(fs, out, spec.outPath);
      } catch (err) {
        finish({ kind: 'failed', message: `The export could not be moved to ${spec.outPath}: ${(err as Error).message}` });
        return;
      }
      finish(outcome);
      return;
    }
    if (outcome && outcome.kind !== 'completed') {
      finish(outcome);
      return;
    }
    // No terminal line: the engine crashed (or was killed from outside). Its
    // encoder died with it and nothing was delivered — the window path renders
    // the job instead.
    const why = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
    log(`job ${jobId}: the engine stopped unexpectedly (${why})${stderrTail ? `: ${stderrTail.slice(-400)}` : ''}`);
    finish({ kind: 'fallback', reason: `premation-engine stopped unexpectedly (${why})` });
  };

  run().catch((err: unknown) => {
    finish({ kind: 'fallback', reason: `the engine job could not be prepared: ${(err as Error)?.message ?? String(err)}` });
  });

  return {
    done,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      const p = child;
      if (p) {
        // Ask first (the engine stops and kills its encoder), then make sure.
        try { p.stdin?.write(`${JSON.stringify({ cancel: true })}\n`); } catch { /* gone */ }
        const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 2000);
        p.once('close', () => clearTimeout(t));
      } else {
        finish({ kind: 'cancelled' });
      }
    },
  };
}
