/**
 * The main-process half of `premation render` — drive one headless render and
 * exit with a meaningful code.
 *
 * It opens the real renderer in a hidden window. That is the design, not a
 * shortcut: the export pipeline is a DOM pipeline (see the header of
 * `src/core/cli/headlessRender.ts`), so the only way to guarantee the CLI ships
 * the file the editor would have shipped is to BE the editor, with its window
 * never shown. Everything a GUI launch does and a render does not need — the
 * application menu, the auto-updater, the managed backend, GPU diagnostics —
 * is skipped by `main.ts` before this is called.
 *
 * Three things this owns that the renderer cannot:
 *
 *  - **Paths.** Only this side has `path` and the cwd, so every path is made
 *    absolute here and the renderer is handed nothing it has to interpret.
 *  - **Output.** stdout, the exit code, and the `--log` file.
 *  - **The watchdog.** A render that stops making progress must fail the build
 *    rather than hold a CI runner until its own timeout kills the job with no
 *    explanation.
 */

import { BrowserWindow, app } from 'electron';
import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { handle, on } from './ipcGuard';
import type { CliOutputOptions, CliRenderJob } from './cliArgs';

/**
 * How long a render may make no progress at all before it is declared stuck.
 *
 * Generous on purpose: one 8K frame with heavy effects legitimately takes
 * minutes, and a false timeout that kills a real render is worse than a stuck
 * render that eventually times out. The clock resets on every progress report,
 * so this bounds the gap between frames, never the render.
 */
const STALL_TIMEOUT_MS = 15 * 60 * 1000;

/** How long the renderer has to boot and ask for its job before we give up. */
const BOOT_TIMEOUT_MS = 2 * 60 * 1000;

/** What the renderer sends back when it is finished, one way or the other. */
export type CliRenderReport =
  | {
      ok: true;
      outPath: string;
      compositionName: string;
      frames: number;
      width: number;
      height: number;
      fps: number;
      warnings: string[];
    }
  | { ok: false; message: string }
  /** `comps` — a listing rather than a render. */
  | { ok: true; comps: string[] }
  /** `captions` — a transcript, for this process to write. */
  | { ok: true; captions: { text: string; cues: number; compositionName: string }; warnings: string[] }
  /** `--data` — one render per row, reported as a whole. */
  | {
      ok: true;
      batch: {
        rendered: number;
        failed: number;
        rows: Array<{ outputPath: string; error?: string }>;
      };
      warnings: string[];
    };

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
};

export interface CliTask {
  /** The render to perform, or a listing request. */
  request:
    | { kind: 'render'; job: CliRenderRequestWithData }
    | { kind: 'comps'; projectPath: string }
    | { kind: 'captions'; projectPath: string; outPath: string; comp?: string; language?: string };
  output: CliOutputOptions;
}

/** Where the renderer lives — the dev server, or the packaged bundle. */
function rendererEntry(): { url: string } | { file: string } {
  return process.env.NODE_ENV === 'development'
    ? { url: 'http://localhost:5173/#/render' }
    : { file: path.join(__dirname, '..', 'dist', 'index.html') };
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

  if (task.request.kind === 'render') {
    const what = task.request.job.aspect ? `Reframing to ${task.request.job.aspect} and rendering` : 'Rendering';
    print.line(`${what} ${path.basename(task.request.job.projectPath)} → ${task.request.job.outPath}`);
  } else if (task.request.kind === 'captions') {
    print.line(`Transcribing ${path.basename(task.request.projectPath)} → ${task.request.outPath}`);
  }

  const started = Date.now();
  let settled = false;
  let resolveRun: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => { resolveRun = resolve; });

  /** Every exit goes through here, so the window and the timers always close. */
  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    resolveRun(code);
  };

  let watchdog = setTimeout(
    () => {
      print.event({
        event: 'error',
        message: `The renderer did not start within ${Math.round(BOOT_TIMEOUT_MS / 1000)}s. `
          + 'This usually means no GPU is available to this process.',
      });
      finish(1);
    },
    BOOT_TIMEOUT_MS,
  );

  /** Restart the stall clock — called on every sign of life. */
  const kick = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      print.event({
        event: 'error',
        message: `The render made no progress for ${Math.round(STALL_TIMEOUT_MS / 60000)} minutes and was stopped.`,
      });
      finish(1);
    }, STALL_TIMEOUT_MS);
  };

  // The renderer PULLS its job rather than being pushed one, so there is no
  // race between `did-finish-load` and the route mounting: whenever the page is
  // ready, it asks, and the answer is already here.
  handle('cli:job', () => {
    kick();
    return task.request;
  });

  on('cli:progress', (_event, fraction: unknown) => {
    kick();
    const f = typeof fraction === 'number' ? Math.max(0, Math.min(1, fraction)) : 0;
    const pct = Math.round(f * 100);
    print.progress(`  ${String(pct).padStart(3)}%`, { fraction: f, percent: pct });
  });

  on('cli:done', (_event, report: unknown) => {
    const result = report as CliRenderReport;
    const elapsedMs = Date.now() - started;
    if (!result || typeof result !== 'object') {
      print.event({ event: 'error', message: 'The renderer finished without saying what happened.' });
      finish(1);
      return;
    }
    if (!result.ok) {
      print.event({ event: 'error', message: result.message, elapsedMs });
      finish(1);
      return;
    }
    if ('comps' in result) {
      if (task.output.json) print.event({ event: 'comps', comps: result.comps });
      else for (const line of result.comps) print.line(line);
      finish(0);
      return;
    }
    if ('captions' in result) {
      // WRITTEN HERE, not in the renderer: this process already resolved and
      // validated the path, and a second place that decides where a file goes
      // is a second place for them to disagree.
      const target = task.request.kind === 'captions' ? task.request.outPath : '';
      try {
        writeFileSync(target, result.captions.text, 'utf8');
      } catch (e) {
        print.event({ event: 'error', message: `Could not write "${target}": ${(e as Error).message}` });
        finish(1);
        return;
      }
      for (const warning of result.warnings) {
        print.event({ event: 'warning', message: `warning: ${warning}` });
      }
      print.event({
        event: 'done',
        message: `Wrote ${target} — ${result.captions.cues} caption(s) from "${result.captions.compositionName}" `
          + `in ${(elapsedMs / 1000).toFixed(1)}s`,
        outPath: target,
        cues: result.captions.cues,
        compositionName: result.captions.compositionName,
        elapsedMs,
        warnings: result.warnings,
      });
      finish(0);
      return;
    }
    if ('batch' in result) {
      for (const warning of result.warnings) {
        print.event({ event: 'warning', message: `warning: ${warning}` });
      }
      for (const row of result.batch.rows) {
        // Every row named, failures included. A batch that reports only a
        // count leaves the reader diffing a folder against a spreadsheet.
        if (row.error) print.event({ event: 'row', message: `  failed  ${row.outputPath}: ${row.error}`, outputPath: row.outputPath, error: row.error });
        else print.line(`  wrote   ${row.outputPath}`);
      }
      print.event({
        event: 'done',
        message: `Rendered ${result.batch.rendered} of ${result.batch.rendered + result.batch.failed} row(s) `
          + `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        rendered: result.batch.rendered,
        failed: result.batch.failed,
        rows: result.batch.rows,
        elapsedMs,
        warnings: result.warnings,
      });
      // A batch with any failed row fails the build. The successful files are
      // still on disk and named in the log; what a pipeline must not do is
      // treat "39 of 40" as a green run.
      finish(result.batch.failed > 0 ? 1 : 0);
      return;
    }
    for (const warning of result.warnings) {
      print.event({ event: 'warning', message: `warning: ${warning}` });
    }
    print.event({
      event: 'done',
      message: `Wrote ${result.outPath} — ${result.frames} frame(s), `
        + `${result.width}×${result.height} @ ${result.fps}fps, in ${(elapsedMs / 1000).toFixed(1)}s`,
      outPath: result.outPath,
      compositionName: result.compositionName,
      frames: result.frames,
      width: result.width,
      height: result.height,
      fps: result.fps,
      elapsedMs,
      warnings: result.warnings,
    });
    finish(0);
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
      devTools: false,
      /*
        The whole reason a hidden render works at all.

        Chromium throttles timers in a window that is not visible — to roughly
        one tick per second — and the offline render loop yields between frames
        (`scheduler.yield`, falling back to `setTimeout`). Throttled, a 600-frame
        render would take ten minutes of pure waiting and then trip the stall
        watchdog. This is the switch that says "this window is not idle, it is
        working".
      */
      backgroundThrottling: false,
    },
  });

  // A renderer that dies — an OOM on a huge comp, a GPU process crash — must
  // fail the build rather than hang until the watchdog. There is no window to
  // show the user, so the only report is this line.
  win.webContents.on('render-process-gone', (_e, details) => {
    print.event({
      event: 'error',
      message: `The renderer stopped unexpectedly (${details.reason}). `
        + 'A very large composition can exhaust memory; try --scale or a shorter --range.',
    });
    finish(1);
  });
  win.webContents.on('did-fail-load', (_e, code, description) => {
    print.event({ event: 'error', message: `The editor could not be loaded (${code} ${description}).` });
    finish(1);
  });

  const entry = rendererEntry();
  void ('url' in entry ? win.loadURL(entry.url) : win.loadFile(entry.file, { hash: '/render' }));

  const code = await finished;
  if (!win.isDestroyed()) win.destroy();
  return code;
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
