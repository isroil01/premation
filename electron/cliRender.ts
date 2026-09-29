/**
 * The main-process half of `premation render` — drive one headless render and
 * exit with a meaningful code.
 *
 * The ENGINE renders (`premation-engine --export`, cliEngineRender.ts): no
 * window is opened. The hidden editor window that rendered on the TypeScript
 * engine is gone (docs/TS_ENGINE_REMOVAL.md phase 4).
 *
 * Three things this owns:
 *
 *  - **Paths.** Only this side has `path` and the cwd, so every path is made
 *    absolute here.
 *  - **Output.** stdout, the exit code, and the `--log` file.
 *  - **Refusals.** Anything that cannot run is a printed line and exit 1.
 */

import { app } from 'electron';
import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { CliOutputOptions, CliRenderJob } from './cliArgs';
import { runCliEngineBatch, runCliEngineRender } from './cliEngineRender';
import { describeComposition, formatCaptions, runEnginePrepare } from './cliPrepare';
import { getKeyForProvider } from './aiKeyVault';
import { resolveEngineExecutable } from './engineSupervisor';
import { resolveFfmpegBinary } from './ffmpegBinary';
import { EncoderProbe } from './encoderProbe';

/**
 * A render job with its data table already read.
 *
 * The renderer never touches `dataPath`: it receives the TEXT. Reading here is
 * what makes "that file does not exist" a two-second failure rather than one
 * that costs a GPU boot, and it keeps the parse (`parseDataTable`) on the side
 * that owns the vocabulary.
 */
export type CliRenderRequestWithData = CliRenderJob & {
  data?: { text: string; filename: string };
  /** A caption file's text, read here for the same reason `data` is. */
  captions?: { text: string; filename: string };
  /** A recorded command log's text (`--commands`), read here likewise. */
  commands?: { text: string; filename: string };
};

export interface CliTask {
  /** The render to perform, or a listing request. */
  request:
    | { kind: 'render'; job: CliRenderRequestWithData }
    | { kind: 'comps'; projectPath: string }
    | { kind: 'captions'; projectPath: string; outPath: string; comp?: string; language?: string };
  output: CliOutputOptions;
}

/**
 * A printer bound to one invocation's output options.
 *
 * `--log` exists because of Windows: a packaged Electron app is a GUI-subsystem
 * binary with no console attached, so a run started from cmd or PowerShell gets
 * the exit code and nothing else. Everything printed here goes to the log file
 * too, so a pipeline always has somewhere to read.
 */
function createPrinter(output: CliOutputOptions): {
  line(text: string): void;
  event(payload: Record<string, unknown>): void;
  progress(text: string, payload: Record<string, unknown>): void;
} {
  const logPath = output.logPath ? path.resolve(output.logPath) : null;
  const write = (text: string): void => {
    console.log(text);
    if (!logPath) return;
    try {
      appendFileSync(logPath, `${text}\n`, 'utf8');
    } catch {
      // A log file that cannot be written must not fail a render that can.
    }
  };
  return {
    line: (text) => { if (!output.json) write(text); },
    event: (payload) => { write(output.json ? JSON.stringify(payload) : String(payload.message ?? '')); },
    progress: (text, payload) => {
      if (output.quiet) return;
      write(output.json ? JSON.stringify({ event: 'progress', ...payload }) : text);
    },
  };
}

/** Absolute, cwd-relative — a CLI path means what the shell meant by it. */
function absolute(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Resolve and sanity-check the paths BEFORE booting a renderer.
 *
 * Booting takes seconds and a GPU. Finding out afterwards that the project does
 * not exist is a slow way to learn a typo, so every check that can happen on a
 * string happens here. Returns an error message, or null when the task is
 * ready to run.
 */
export function prepareTask(task: CliTask): string | null {
  const projectPath =
    task.request.kind === 'render' ? task.request.job.projectPath : task.request.projectPath;
  const resolved = absolute(projectPath);
  if (!existsSync(resolved)) {
    return `No project at "${resolved}".`;
  }
  if (task.request.kind === 'comps') {
    task.request.projectPath = resolved;
    return null;
  }
  if (task.request.kind === 'captions') {
    task.request.projectPath = resolved;
    const outPath = absolute(task.request.outPath);
    task.request.outPath = outPath;
    const dir = path.dirname(outPath);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        return `Could not create the output directory "${dir}": ${(e as Error).message}`;
      }
    }
    return null;
  }

  task.request.job.projectPath = resolved;
  const outPath = absolute(task.request.job.outPath);
  task.request.job.outPath = outPath;

  const dir = path.dirname(outPath);
  if (!existsSync(dir)) {
    // Created, not refused: `--out dist/promo.mp4` on a clean checkout is a
    // reasonable thing to write, and making the caller mkdir first is busywork
    // every pipeline would have to repeat.
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      return `Could not create the output directory "${dir}": ${(e as Error).message}`;
    }
  } else if (existsSync(outPath) && statSync(outPath).isDirectory()) {
    return `"${outPath}" is a directory, so nothing can be written there.`;
  }

  const captionsPath = task.request.job.captionsPath;
  if (captionsPath !== undefined) {
    const resolvedCaptions = absolute(captionsPath);
    if (!existsSync(resolvedCaptions)) return `No caption file at "${resolvedCaptions}".`;
    try {
      task.request.job.captions = {
        text: readFileSync(resolvedCaptions, 'utf8'),
        filename: path.basename(resolvedCaptions),
      };
    } catch (e) {
      return `Could not read the caption file "${resolvedCaptions}": ${(e as Error).message}`;
    }
  }

  const commandsPath = task.request.job.commandsPath;
  if (commandsPath !== undefined) {
    const resolvedCommands = absolute(commandsPath);
    if (!existsSync(resolvedCommands)) return `No command log at "${resolvedCommands}".`;
    try {
      task.request.job.commands = {
        text: readFileSync(resolvedCommands, 'utf8'),
        filename: path.basename(resolvedCommands),
      };
    } catch (e) {
      return `Could not read the command log "${resolvedCommands}": ${(e as Error).message}`;
    }
  }

  const dataPath = task.request.job.dataPath;
  if (dataPath !== undefined) {
    const resolvedData = absolute(dataPath);
    if (!existsSync(resolvedData)) return `No data table at "${resolvedData}".`;
    try {
      task.request.job.data = {
        text: readFileSync(resolvedData, 'utf8'),
        filename: path.basename(resolvedData),
      };
    } catch (e) {
      return `Could not read the data table "${resolvedData}": ${(e as Error).message}`;
    }
  }
  return null;
}

/**
 * Run one CLI task to completion. Resolves with the process exit code.
 *
 * Never rejects: every failure path has to end in a printed line and a code,
 * because an unhandled rejection in the main process exits 0 on some platforms
 * and that would report a failed render as a successful build.
 */
export async function runCliTask(task: CliTask): Promise<number> {
  const print = createPrinter(task.output);

  const problem = prepareTask(task);
  if (problem) {
    print.event({ event: 'error', message: problem });
    return 1;
  }

  const enginePath = resolveEngineExecutable({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath ?? '',
    appPath: app.getAppPath(),
    platform: process.platform,
    vars: process.env,
    exists: existsSync,
  });
  const workDirFor = (id: string): string => path.join(app.getPath('temp'), 'premation-cli', id);

  if (task.request.kind === 'comps') {
    const out = await runEnginePrepare({ projectPath: task.request.projectPath, listComps: true }, { enginePath, workDir: workDirFor(`comps-${Date.now().toString(36)}`) });
    if (!out.ok) {
      print.event({ event: 'error', message: out.message });
      return 1;
    }
    const comps = out.result.comps ?? [];
    if (task.output.json) print.event({ event: 'comps', comps: comps.map(describeComposition) });
    else for (const c of comps) print.line(describeComposition(c));
    return 0;
  }

  if (task.request.kind === 'captions') {
    const req = task.request;
    print.line(`Transcribing ${path.basename(req.projectPath)} → ${req.outPath}`);
    const t0 = Date.now();
    // The key is main's (the AI key vault), handed to the engine for this one request.
    const credential = await getKeyForProvider('openai').catch(() => null);
    if (!credential) {
      print.event({ event: 'error', message: 'No OpenAI key is set: add one in Settings ▸ AI to transcribe.' });
      return 1;
    }
    const out = await runEnginePrepare({
      projectPath: req.projectPath,
      ...(req.comp !== undefined ? { comp: req.comp } : {}),
      transcribe: { provider: 'openai', credential, ...(req.language ? { language: req.language } : {}) },
    }, { enginePath, workDir: workDirFor(`captions-${Date.now().toString(36)}`) });
    if (!out.ok) {
      print.event({ event: 'error', message: out.message });
      return 1;
    }
    const cues = out.result.cues ?? [];
    try {
      writeFileSync(req.outPath, formatCaptions(cues, req.outPath), 'utf8');
    } catch (e) {
      print.event({ event: 'error', message: `Could not write "${req.outPath}": ${(e as Error).message}` });
      return 1;
    }
    const elapsedMs = Date.now() - t0;
    print.event({
      event: 'done',
      message: `Wrote ${req.outPath} — ${cues.length} caption(s) from "${out.result.compName ?? ''}" in ${(elapsedMs / 1000).toFixed(1)}s`,
      outPath: req.outPath,
      cues: cues.length,
      compositionName: out.result.compName ?? '',
      elapsedMs,
      warnings: [],
    });
    return 0;
  }

  const request = task.request.job;
  // HDR10 / HLG: HEVC when this ffmpeg has libx265, else H.264 High 10 (said once).
  let job: typeof request & { hdrEncoder?: 'libx265' | 'libx264' } = request;
  if (request.format === 'hdr10' || request.format === 'hlg') {
    const probe = new EncoderProbe({ bin: () => resolveFfmpegBinary({ vars: process.env, resourcesPath: process.resourcesPath ?? '', platform: process.platform, exists: existsSync }) });
    const hdrEncoder = (await probe.has('libx265')) ? 'libx265' as const : 'libx264' as const;
    if (hdrEncoder === 'libx264') print.event({ event: 'warning', message: 'warning: ffmpeg has no libx265 — writing H.264 High 10 without HDR10 mastering metadata.' });
    job = { ...request, hdrEncoder };
  }
  const what = job.aspect ? `Reframing to ${job.aspect} and rendering` : 'Rendering';
  print.line(`${what} ${path.basename(job.projectPath)} → ${job.outPath}`);
  const t0 = Date.now();
  const deps = {
    enginePath,
    ffmpegPath: () => resolveFfmpegBinary({ vars: process.env, resourcesPath: process.resourcesPath ?? '', platform: process.platform, exists: existsSync }),
    workDirFor,
    log: (m: string) => print.event({ event: 'engine', message: `engine: ${m}` }),
  };
  const progress = (f: number): void => {
    const pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
    print.progress(`  ${String(pct).padStart(3)}%`, { fraction: f, percent: pct });
  };
  if (job.data) {
    const batch = await runCliEngineBatch({ ...job, data: job.data }, deps, progress);
    if (batch.kind === 'failed') {
      print.event({ event: 'error', message: batch.message });
      return 1;
    }
    for (const w of batch.warnings) print.event({ event: 'warning', message: `warning: ${w}` });
    for (const row of batch.rows) {
      // Every row named, failures included.
      if (row.error) print.event({ event: 'row', message: `  failed  ${row.outputPath}: ${row.error}`, outputPath: row.outputPath, error: row.error });
      else print.line(`  wrote   ${row.outputPath}`);
    }
    const elapsedMs = Date.now() - t0;
    print.event({
      event: 'done',
      message: `Rendered ${batch.rendered} of ${batch.rendered + batch.failed} row(s) in ${(elapsedMs / 1000).toFixed(1)}s`,
      rendered: batch.rendered,
      failed: batch.failed,
      rows: batch.rows,
      elapsedMs,
      warnings: batch.warnings,
    });
    // A batch with any failed row fails the build.
    return batch.failed > 0 ? 1 : 0;
  }
  const outcome = await runCliEngineRender(job, deps, progress);
  if (outcome.kind === 'done') {
    const elapsedMs = Date.now() - t0;
    for (const w of outcome.warnings) print.event({ event: 'warning', message: `warning: ${w}` });
    print.event({
      event: 'done',
      message: `Wrote ${job.outPath} — ${outcome.frames} frame(s), `
        + `${outcome.width}×${outcome.height} @ ${outcome.fps}fps, in ${(elapsedMs / 1000).toFixed(1)}s`,
      outPath: job.outPath,
      compositionName: outcome.compositionName,
      frames: outcome.frames,
      width: outcome.width,
      height: outcome.height,
      fps: outcome.fps,
      elapsedMs,
      warnings: outcome.warnings,
      renderer: 'engine',
    });
    return 0;
  }
  print.event({ event: 'error', message: outcome.kind === 'failed' ? outcome.message : `This render needs a feature the engine CLI does not have yet: ${outcome.reason}.` });
  return 1;
}

/**
 * Run a task and exit the process with its code.
 *
 * `app.exit`, not `app.quit`: quit is cooperative and can be cancelled by a
 * `before-quit` handler, and a CLI that a listener can keep alive is a CLI that
 * hangs a pipeline.
 *
 * Returns rather than being typed `never`. `app.exit` tears the process down
 * asynchronously enough that a `throw` placed after it to satisfy `never` is
 * genuinely reached — and surfaced as an unhandled rejection warning on every
 * successful render, which is a poor last impression for a tool whose whole job
 * is to report clearly.
 */
export async function runCliAndExit(task: CliTask): Promise<void> {
  let code = 1;
  try {
    code = await runCliTask(task);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
  }
  app.exit(code);
}
