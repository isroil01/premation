import { app, BrowserWindow, shell, dialog, Menu, protocol, net, sharedTexture, type WebContents } from 'electron';
import { handle, on } from './ipcGuard';
import {
  devUiPlatformOverride,
  hasTitleBarOverlay,
  resolveUiChrome,
  sanitizeOverlayColors,
  uiChromeQuery,
  windowChromeOptions,
  WINDOWS_TITLEBAR_HEIGHT,
} from './uiPlatform';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, rename, unlink, readdir, access, rm, copyFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from './atomicWrite';
import { initDialogDirs, rememberDir, rememberedDir } from './dialogDirs';
import { localFileUrlToPath } from './localFileUrl';
import { EngineHost, engineBackendEnabled, enginePreferenceFile, registerEngineIpc, type SharedTextureApi } from './engineHost';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { buildEncodeArgs, ffmpegRate, rawVideoInput, stagedVideoInput, type EncodeFormat, type VideoEncoder } from './ffmpegEncodeArgs';
import { FfmpegStdinStream, RAW_PIPE_MAX_CHUNK_BYTES } from './ffmpegStream';
import { resolveFfmpegBinary } from './ffmpegBinary';
import { EncoderProbe } from './encoderProbe';
import { shouldStartBackend, startBackend, stopBackend } from './backend';
import { registerIndexIpc } from './localIndexDb';
import { registerThumbIpc } from './thumbCache';
import { registerRevealIpc } from './ipc/reveal';
import { registerAiKeyIpc } from './aiKeyVault';
import { registerAiProxyIpc, abortAllStreams } from './aiProxy';
import { registerModelDownloadIpc, abortAllModelDownloads } from './modelDownload';
import { registerMediaKeyIpc } from './mediaKeyVault';
import { registerAiMediaProxyIpc } from './aiMediaProxy';
import { registerApiProxyIpc, abortAllApiStreams } from './apiProxy';
import { installPluginPublishIpc } from './pluginPublish';
import { registerPluginNetIpc } from './pluginNet';
import { registerPluginLoaderIpc } from './pluginLoader';
import { disposeNativePlugins, registerPluginNativeIpc } from './pluginNativeIpc';
import { aiEnabled, pluginsEnabled, pluginPublishEnabled, assertRendererEditionMatches } from './edition';
import { parseProbeJson, type ProbeJson } from './mediaProbeParse';
import { checkForUpdatesInteractive, initAutoUpdate, registerUpdaterIpc } from './updater';
import { nativeTemplateFromGroups, sanitizeMenuGroups, type NativeMenuGroupSpec, type NativeMenuOptions } from './nativeMenu';
import { CLI_HELP, cliArgs, parseCli, type CliInvocation } from './cliArgs';
import { runCliAndExit } from './cliRender';
import {
  createExportSupervisor,
  installExportQuitGuard,
  keepAliveForExports,
  registerExportSupervisorIpc,
  type ExportSupervisor,
} from './exportProcess';
import { enforceProjectExtension } from './projectSavePath';
import {
  inspectJob,
  jobDir as resumeJobDir,
  listResumableJobs as listResumableJobDirs,
  scanStagedFrames,
  writeManifest,
  type AdoptedRenderJob,
  type ResumableRenderJob,
} from './renderResume';

const isDev = process.env.NODE_ENV === 'development';
/**
 * Where the dev renderer is served from. Vite's default port, unless another
 * project on the machine already holds it — `PREMATION_DEV_URL` then points a
 * dev launch at the port Vite actually took (`vite --port 5273`).
 */
const DEV_SERVER_URL = (process.env.PREMATION_DEV_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

/** The main window, tracked so the OAuth deep-link handler can reach it. */
let mainWindow: BrowserWindow | null = null;

/** The export queue, owned here so it outlives any window (electron/exportProcess.ts). */
let exportSupervisor: ExportSupervisor | null = null;

/**
 * The C++ engine process (electron/engineHost.ts), created in whenReady. Its
 * supervisor only exists — and the engine only runs — when the process
 * backend is switched on (PREMATION_ENGINE=process or <userData>/engine.json).
 */
let engineHost: EngineHost | null = null;

// ── OAuth deep link (premation://oauth?code=…) ──────────────────────────────
//
// Google refuses to run its consent screen inside an Electron window (embedded
// webview), so provider sign-in opens in the SYSTEM browser. The backend hands
// the one-time code back by redirecting to this custom scheme, which the OS
// routes to us: on Windows/Linux as an argument to a second launch (caught by
// `second-instance`), on macOS via `open-url`. See src/pages/OAuthCallbackPage.
const OAUTH_SCHEME = 'premation';

/** Register this app as the handler for premation:// links. */
function registerProtocolClient(): void {
  // In dev the "app" is the electron binary run against a script path, so the
  // launch command the OS records has to include that path or the deep link
  // would relaunch electron with nothing to run.
  if (isDev && process.platform === 'win32' && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(OAUTH_SCHEME, process.execPath, [path.resolve(process.argv[1]!)]);
  } else {
    app.setAsDefaultProtocolClient(OAUTH_SCHEME);
  }
}

/** The first premation:// argument in a launch argv, if any. */
function findDeepLink(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith(`${OAUTH_SCHEME}://`));
}

/**
 * A plugin id that may be routed on.
 *
 * A deep link is the least trusted input this process handles: anyone can put
 * one in a web page, a chat message or an email, and the OS hands it straight
 * to us. The id is therefore validated HERE, before it is forwarded anywhere —
 * the renderer validates it again, because IPC is its own boundary, but a
 * malformed id has no business travelling that far.
 *
 * Same shape the registry issues: reverse-DNS and lowercase, which leaves no
 * room for traversal characters, a scheme, or a path.
 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Parse a premation:// deep link and route it to the renderer. */
function handleDeepLink(url: string | undefined): void {
  if (!url || !url.startsWith(`${OAUTH_SCHEME}://`)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  const win = mainWindow;
  if (!win || win.isDestroyed()) return;

  if (parsed.host === 'oauth') {
    const code = parsed.searchParams.get('code') ?? undefined;
    const error = parsed.searchParams.get('error') ?? undefined;
    if (!code && !error) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('oauth:result', { code, error });
    return;
  }

  // premation://plugin/<id> — open that plugin's page in the editor.
  if (parsed.host === 'plugin') {
    const id = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    // Refused silently rather than forwarded or reported. A link with a
    // malformed id is a typo or a probe, and neither earns a dialog.
    if (id.length > 200 || !PLUGIN_ID_RE.test(id)) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('deeplink:plugin', { id });
  }
}

// ── What kind of launch is this? ─────────────────────────────────────────
//
// Decided FIRST, because the answer changes what this process is allowed to do
// — including whether it may take the single-instance lock below. Anything that
// is not one of our command words reads as a normal launch, so a deep link, a
// file association and Chromium's own switches all fall through untouched.
// See electron/cliArgs.ts.
const cliInvocation = parseCli(cliArgs(process.argv, !!process.defaultApp));
const isHeadlessRun =
  cliInvocation.kind === 'render'
  || cliInvocation.kind === 'comps'
  || cliInvocation.kind === 'captions';

// These three need no app, no window and no GPU, so they answer and leave
// rather than booting Electron to print a paragraph.
if (cliInvocation.kind === 'help') {
  console.log(CLI_HELP);
  app.exit(0);
} else if (cliInvocation.kind === 'version') {
  console.log(app.getVersion());
  app.exit(0);
} else if (cliInvocation.kind === 'error') {
  console.error(cliInvocation.message);
  // 2, not 1: a malformed command line is a different failure from a render
  // that ran and failed, and a pipeline should be able to tell them apart.
  app.exit(2);
}

// Only one instance may run: on Windows a premation:// link launches a SECOND
// copy whose argv carries the URL, and `second-instance` relays it to the
// original (which holds the lock). Without the lock the link would spawn a
// duplicate app instead of returning to the signed-in one.
//
// A headless render is exempt, and has to be. The lock is what makes a second
// launch hand its argument to the first and quit — correct for a deep link,
// fatal for a CLI, which would exit 0 having rendered nothing while the open
// editor silently ignored it. Renders are their own processes; that is the
// whole point of being able to run several at once.
const hasSingleInstanceLock = isHeadlessRun || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => handleDeepLink(findDeepLink(argv)));
  // macOS delivers the deep link to the running app through this event.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
}

// ── GPU acceleration & WebGPU ────────────────────────────────────────
// Bypass Chromium's GPU driver blocklist so WebGPU/WebGL2 can init on
// all hardware (blocklist false-positives are the #1 cause of "WebGPU
// not available" on Windows laptops with recent drivers).
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// Force Windows to assign the discrete (high-performance) GPU to this
// process instead of the integrated one.
app.commandLine.appendSwitch('force_high_performance_gpu');
// Hardware-accelerated rasterization & zero-copy texture uploads.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// ANGLE: D3D11 is the stable default on Windows; D3D9 on very old HW.
// This governs the WebGL2 FALLBACK rung only — WebGPU goes straight to D3D12
// on Windows and Metal on macOS and never touches ANGLE.
app.commandLine.appendSwitch('use-angle', 'default');
// Linux is the one platform where Chromium still gates WebGPU behind Vulkan;
// without this, `navigator.gpu` is undefined there and the app silently spends
// its whole life on the WebGL2 fallback. Windows (D3D12) and macOS (Metal)
// have WebGPU on by default (Electron 32 / Chromium 128 and still on 44 /
// Chromium 152, where every switch above is still honoured), and enabling Vulkan
// on those platforms is what conflicts with ANGLE — hence the platform gate.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'Vulkan');
}

// Privileged local-file protocol for assets in Electron
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { bypassCSP: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const PROJECT_FILTERS = [
  { name: 'Motion Project', extensions: ['motion', 'json'] },
  { name: 'All Files', extensions: ['*'] },
];

/**
 * Privileged file operations — the only place the app touches the real disk.
 * The renderer reaches these through the preload bridge (project:*, file:*).
 */
function registerFileIpc(): void {
  handle('project:open', async () => {
    const res = await dialog.showOpenDialog({ ...rememberedDir('project'), properties: ['openFile'], filters: PROJECT_FILTERS });
    const filePath = res.filePaths[0];
    if (res.canceled || !filePath) return null;
    rememberDir('project', filePath, false);
    try {
      const contents = await readFile(filePath, 'utf8');
      return { path: filePath, name: path.basename(filePath), contents };
    } catch {
      return null;
    }
  });

  handle('project:chooseSavePath', async (_event, defaultName: string) => {
    const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters: PROJECT_FILTERS });
    if (res.canceled || !res.filePath) return null;
    // The filters do not bind what the user TYPES — "oops.mp4" came back as
    // "oops.mp4" and the project JSON was written into it. See projectSavePath.
    const target = enforceProjectExtension(res.filePath);
    if (!target.changed) return target.path;
    // The OS only asked about replacing the path as typed. The corrected one is
    // a different file (or, local-first, a bundle directory) it never checked,
    // so a project already sitting there must not be replaced without a word.
    if (existsSync(target.path)) {
      const answer = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `“${path.basename(target.path)}” already exists.`,
        detail: 'Projects are saved as .motion, so that is the name this one would be saved under. Replace the existing project?',
      });
      if (answer.response !== 0) return null;
    }
    return target.path;
  });

  handle('file:read', async (_event, filePath: string) => {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  });

  // The project file itself comes through these two (localProjectIO,
  // FileManager). Temp-then-rename: a crash or a full disk mid-save leaves
  // the previous version, never a truncated one (electron/atomicWrite.ts).
  handle('file:write', async (_event, filePath: string, contents: string) => {
    await writeFileAtomic(filePath, contents);
  });

  handle('file:writeBytes', async (_event, filePath: string, bytes: Uint8Array) => {
    await writeFileAtomic(filePath, Buffer.from(bytes));
  });

  handle('file:readBytes', async (_event, filePath: string) => {
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  });

  handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  handle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  // The Windows / Linux caption buttons are the OS's, but their colours are the
  // title bar's, and the theme lives in the renderer. Refused for any window
  // created without an overlay (macOS, drawn-controls previews, pop-outs).
  handle('window:setTitleBarOverlay', (event, raw: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const colors = sanitizeOverlayColors(raw);
    if (!win || !colors || !overlayWindows.has(win)) return false;
    win.setTitleBarOverlay({ ...colors, height: WINDOWS_TITLEBAR_HEIGHT });
    return true;
  });

  handle('app:version', () => app.getVersion());
  handle('app:quit', () => app.quit());
}

/**
 * `.motion` directory-bundle I/O — the privileged half of the local-first
 * storage. Chunks are written atomically (temp + rename, so a crash never leaves
 * a half-written chunk) and every path is contained within its bundle `root`
 * (a chunk name can never escape via `..` or an absolute path).
 */
function registerBundleIpc(): void {
  /** Resolve `<root>/<name>` and refuse anything that escapes the bundle dir. */
  const contained = (root: string, name: string): string | null => {
    const base = path.resolve(root);
    const target = path.resolve(base, name);
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    return target;
  };

  handle('bundle:read', async (_event, root: string, name: string) => {
    const target = contained(root, name);
    if (!target) return null;
    try {
      return await readFile(target, 'utf8');
    } catch {
      return null;
    }
  });

  handle('bundle:writeAtomic', async (_event, root: string, name: string, contents: string) => {
    const target = contained(root, name);
    if (!target) throw new Error('bundle:writeAtomic path escapes bundle root');
    await writeFileAtomic(target, contents, { mkdirp: true });
  });

  handle('bundle:remove', async (_event, root: string, name: string) => {
    const target = contained(root, name);
    if (!target) return;
    try {
      await unlink(target);
    } catch {
      /* already gone */
    }
  });

  handle('bundle:list', async (_event, root: string) => {
    try {
      const entries = await readdir(path.resolve(root), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  });

  // Native directory dialog for opening a `.motion` bundle (a directory).
  handle('project:openBundleDir', async () => {
    const res = await dialog.showOpenDialog({ ...rememberedDir('project'), properties: ['openDirectory'] });
    if (res.canceled) return null;
    // The bundle IS the picked directory; the folder worth reopening is its parent.
    rememberDir('project', res.filePaths[0], false);
    return res.filePaths[0] ?? null;
  });
}

/**
 * Binary content-addressed blob I/O within a bundle (asset bytes). Blobs live at
 * `blobs/<hash[0:2]>/<hash>`; the hash is validated as hex so it can never be a
 * path-traversal vector.
 */
function registerBlobIpc(): void {
  const HEX = /^[0-9a-f]{8,128}$/;
  const blobPath = (root: string, hash: string): string | null => {
    if (!HEX.test(hash)) return null;
    return path.resolve(root, 'blobs', hash.slice(0, 2), hash);
  };

  handle('blob:has', async (_event, root: string, hash: string) => {
    const target = blobPath(root, hash);
    if (!target) return false;
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  });

  handle('blob:read', async (_event, root: string, hash: string) => {
    const target = blobPath(root, hash);
    if (!target) return null;
    try {
      return await readFile(target); // Buffer → Uint8Array on the renderer side
    } catch {
      return null;
    }
  });

  handle('blob:write', async (_event, root: string, hash: string, bytes: Uint8Array) => {
    const target = blobPath(root, hash);
    if (!target) throw new Error('blob:write invalid hash');
    await writeFileAtomic(target, Buffer.from(bytes), { mkdirp: true });
  });

  handle('blob:remove', async (_event, root: string, hash: string) => {
    const target = blobPath(root, hash);
    if (!target) return;
    try {
      await unlink(target);
    } catch {
      /* already gone */
    }
  });

  handle('blob:list', async (_event, root: string) => {
    const out: string[] = [];
    try {
      const base = path.resolve(root, 'blobs');
      for (const dir of await readdir(base, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const f of await readdir(path.join(base, dir.name), { withFileTypes: true })) {
          if (f.isFile()) out.push(f.name);
        }
      }
    } catch {
      /* no blobs dir yet */
    }
    return out;
  });
}

/**
 * Offline video export. The renderer rasterizes frames deterministically
 * (src/core/export/offlineRenderer.ts) and streams them here one at a time;
 * this process encodes them with ffmpeg and hands back a path on disk.
 *
 * Why the encode lives in the main process and not the renderer:
 *
 *  - ffmpeg runs as a CHILD PROCESS, so the encode never competes with the
 *    editor's UI thread or its GPU context. A long export leaves the app fully
 *    usable, which in-renderer encoding (MediaRecorder, a WASM encoder) cannot
 *    promise.
 *  - Frames are written to disk as they arrive, so peak memory is one frame
 *    rather than the whole render. A 4K/30s export used to hold ~2 GB of JPEG
 *    byte arrays in the renderer heap before encoding started.
 *  - The finished file is moved to the user's chosen path with `render:save` —
 *    it is never read back through the renderer, so a 2 GB output costs nothing.
 *
 * Frames are staged to a per-job dir; `render:encode` muxes on demand and
 * `render:cleanJob` removes the dir.
 *
 * Those staged frames now survive a RESTART, which is the whole reason this
 * section grew a manifest. The `jobId → dir` map below is in-memory, so before
 * `resume.json` existed a relaunched app could not name — let alone reach — the
 * directory holding a nearly-finished render: `render:stageFrame` answered
 * `unknown render job` for the old id and 900 real frames were dead weight on
 * disk. `render:listResumableJobs` finds those directories again and
 * `render:adoptJob` puts one back in the map under its original id, at which
 * point every other handler here works on it exactly as if it had never been
 * interrupted. See electron/renderResume.ts.
 */
/** Create `dir` when missing (best effort — the engine skips a folder that is not there) and return it. */
function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Read-only profile: plugins simply do not load from here.
  }
  return dir;
}

/** What `registerRenderIpc` hands the export supervisor: teardown by window. */
interface RenderIpcControl {
  /**
   * Kill the ffmpeg children and remove the staging dirs of every job a
   * window began. The export supervisor calls this when it destroys a hidden
   * window before its job completed — a crash, a stall, a cancel — because the
   * window's own cleanup never ran, and a stream child left waiting on stdin
   * would outlive the render holding a half-written file.
   */
  abortJobsOwnedBy(webContentsId: number): Promise<void>;
}

function registerRenderIpc(): RenderIpcControl {
  const jobs = new Map<string, string>();
  /** Which window began each job, so a dead window's jobs can be found. */
  const owners = new Map<string, number>();
  /**
   * Where staging dirs live.
   *
   * `app.getPath('temp')` was the old home, and it is the wrong one for work
   * that must outlast the process: /tmp is cleared on boot on Linux, and every
   * platform's temp is fair game for a cleaner. userData is the app's own
   * storage — the same place the settings blob and the thumbnail cache live —
   * so a render paused on Friday is still there on Monday. `cleanJob`,
   * `discardJob` and the stale-dir prune in `listResumableJobs` are what keep
   * it from growing without bound.
   */
  const stagingRoot = (): string => path.join(app.getPath('userData'), 'render-staging');
  /** Running ffmpeg children per job, so `render:cancel` can kill them. */
  const running = new Map<string, ReturnType<typeof spawn>>();
  /** Jobs whose encode was cancelled — a killed hardware encode must not be retried in software. */
  const cancelled = new Set<string>();
  /**
   * Streaming encodes per job (`render:openStream`), with the file each writes.
   * Kept apart from `running` because a stream is fed frame by frame and its
   * child must be reachable for writes, not only for a kill.
   */
  const streams = new Map<string, { stream: FfmpegStdinStream; out: string }>();
  const killStream = (jobId: string): void => {
    streams.get(jobId)?.stream.kill();
    streams.delete(jobId);
  };
  /**
   * Chapter metadata, staged in the job dir next to the frames.
   *
   * The name is deliberately outside `frame_%04d` so `stagedFrames` cannot
   * mistake it for a frame, and inside the job dir so `cleanJob` reclaims it
   * with everything else.
   */
  const CHAPTER_METADATA_FILE = 'chapters.ffmetadata';

  // The same rule the engine's export jobs use (ffmpegBinary.ts).
  const resolveFfmpeg = (): string => resolveFfmpegBinary({
    vars: process.env,
    resourcesPath: process.resourcesPath ?? '',
    platform: process.platform,
    exists: existsSync,
  });

  /**
   * Cached encoder probe (`ffmpeg -encoders` once per session, plus a smoke
   * encode per hardware encoder on first use) — see encoderProbe.ts.
   */
  const encoderProbe = new EncoderProbe({ bin: resolveFfmpeg });
  const probeLibx265 = (): Promise<boolean> => encoderProbe.has('libx265');

  const runFfmpeg = (jobId: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
      running.set(jobId, proc);
      let stderr = '';
      proc.stderr?.on('data', (d) => (stderr += String(d)));
      proc.on('error', (err: NodeJS.ErrnoException) => {
        running.delete(jobId);
        // ENOENT is the one failure worth explaining: nothing is wrong with the
        // render, ffmpeg simply is not installed. The generic message sent users
        // hunting for a bug in their composition.
        reject(
          err.code === 'ENOENT'
            ? new Error(
                'ffmpeg was not found. Install it and make sure it is on your PATH, ' +
                  'or set the FFMPEG_PATH environment variable to the executable.',
              )
            : err,
        );
      });
      proc.on('close', (code) => {
        running.delete(jobId);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
      });
    });

  /**
   * What is actually staged for a job: how many frames, and in which format.
   *
   * ffmpeg writes a valid, playable container with NO video stream and exits 0
   * when its input pattern matches nothing — which is precisely the "exported
   * file is a black screen" bug. Every encode checks this first and fails loudly
   * instead of producing an empty file that looks like a successful export.
   */
  const stagedFrames = async (dir: string): Promise<{ count: number; ext: 'jpg' | 'png' }> => {
    // The scan itself is shared with the resume path (renderResume.ts), which
    // needs the same "how far does the sequence run unbroken" answer without
    // throwing — a resume's whole job is to fill the gap this refuses to encode
    // over. Two copies of the frame-name regex is how those two answers drift.
    const scan = await scanStagedFrames(dir);
    // CONTIGUITY, not just count: ffmpeg's image2 demuxer stops at the first
    // missing index and still exits 0 — a gap at frame 500 of 1000 shipped a
    // half-length video while this reported the full count. Fail loudly with
    // the missing frame named instead.
    if (scan.contiguous < scan.indices.length) {
      throw new Error(
        `Staged frame ${scan.contiguous} is missing (${scan.indices.length} frames on disk) — `
        + 'the encode would silently truncate there. Re-run the export.',
      );
    }
    return { count: scan.indices.length, ext: scan.ext };
  };

  // `ffmpegRate` (the NTSC rationals) lives in ffmpegEncodeArgs.ts now, beside
  // the command-line builder the staged and streaming encodes share.

  /**
   * Probe a media file's real stream facts.
   *
   * The renderer cannot learn these on its own. Nothing in the browser reports a
   * `<video>`'s frame rate — `requestVideoFrameCallback` is the only API that
   * exposes real frame times and it never fires for a detached, paused element
   * (measured) — and `decodeAudioData` only tells you whether a file HAS audio
   * by throwing at playback time, long after import.
   *
   * Bytes come over IPC and land in a temp file rather than being piped to
   * ffprobe's stdin, deliberately: a pipe is not seekable, and an mp4 with its
   * moov atom at the end (every file a phone or a browser recorder produces)
   * cannot be parsed without seeking. The temp file is always removed.
   *
   * Returns null rather than throwing when ffprobe/ffmpeg is absent — the probe
   * is an enhancement, and an import must never fail because a codec tool is
   * missing. `resolveFfmpeg` falls back to bare 'ffmpeg' on PATH, so "not
   * installed" is a real, common state on desktop, not just on web.
   */
  const resolveFfprobe = (): string => {
    if (process.env.FFPROBE_PATH && existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH;
    const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const bundled = path.join(process.resourcesPath ?? '', 'ffmpeg', name);
    if (existsSync(bundled)) return bundled;
    // Sibling of a resolved ffmpeg — the usual layout for both bundles and
    // package managers.
    const ff = resolveFfmpeg();
    if (ff !== 'ffmpeg') {
      const sibling = path.join(path.dirname(ff), name);
      if (existsSync(sibling)) return sibling;
    }
    return 'ffprobe';
  };

  /** Run a binary and capture stdout. Resolves null on any failure, including
   *  the executable not existing — every caller treats absence as "unknown". */
  const capture = (bin: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve(null);
        return;
      }
      let out = '';
      let err = '';
      proc.stdout?.on('data', (d) => (out += String(d)));
      proc.stderr?.on('data', (d) => (err += String(d)));
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => resolve(code === 0 ? out : err || null));
    });

  handle('media:probe', async (_e, bytes: Uint8Array, ext: string) => {
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'bin';
    const tmp = path.join(
      app.getPath('temp'),
      `motion-probe-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.${safeExt}`,
    );
    try {
      await writeFile(tmp, bytes);
      const json = await capture(resolveFfprobe(), [
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', tmp,
      ]);
      if (!json) return null;

      try {
        return parseProbeJson(JSON.parse(json) as ProbeJson);
      } catch {
        return null;
      }
    } catch {
      return null;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });

  /**
   * Transcode an imported file into a low-resolution editing proxy.
   *
   * Runs as a CHILD PROCESS for the same reason the export encode does: the
   * transcode must never compete with the editor's UI thread, because the whole
   * point is that the asset stays usable at full resolution while this runs.
   *
   * Cancellation is real, not cooperative. `proxy:cancel` kills the child, and
   * killing it is also what happens on app close — an ffmpeg child does not
   * outlive the app, which is precisely why a 'generating' record is never
   * persisted (see `saveProxies`).
   *
   * Returns null rather than throwing when ffmpeg is missing, matching
   * `media:probe`: no codec tool is a real desktop state, and the caller
   * degrades to full resolution rather than surfacing an error.
   */
  const proxyJobs = new Map<string, ReturnType<typeof spawn>>();

  handle(
    'proxy:generate',
    async (_e, assetId: string, bytes: Uint8Array, ext: string, args: string[], outExt: string) => {
      const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'bin';
      const safeOut = /^[a-z0-9]{1,5}$/i.test(outExt) ? outExt : 'mp4';
      const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      const input = path.join(app.getPath('temp'), `motion-proxy-in-${stamp}.${safeExt}`);
      const output = path.join(app.getPath('temp'), `motion-proxy-out-${stamp}.${safeOut}`);

      // A second request for the same asset supersedes the first — re-importing
      // or re-requesting must not leave two children racing to write one file.
      proxyJobs.get(assetId)?.kill();

      try {
        await writeFile(input, bytes);
        // The renderer chose the encode (`proxyEncodeArgs`), so the rule lives in
        // one place; main only substitutes the paths it owns.
        const resolved = args.map((a) => (a === '__IN__' ? input : a === '__OUT__' ? output : a));

        const code = await new Promise<number | null>((resolve) => {
          const proc = spawn(resolveFfmpeg(), resolved, { stdio: ['ignore', 'ignore', 'pipe'] });
          proxyJobs.set(assetId, proc);
          let stderr = '';
          proc.stderr?.on('data', (d) => (stderr += String(d)));
          proc.on('error', () => resolve(null));
          proc.on('close', (c) => {
            proxyJobs.delete(assetId);
            if (c !== 0 && stderr) console.warn(`[proxy] ffmpeg ${c}: ${stderr.slice(-400)}`);
            resolve(c);
          });
        });
        if (code !== 0) return null;
        return await readFile(output);
      } catch {
        return null;
      } finally {
        await unlink(input).catch(() => {});
        await unlink(output).catch(() => {});
      }
    },
  );

  handle('proxy:cancel', (_e, assetId: string) => {
    const proc = proxyJobs.get(assetId);
    if (!proc) return false;
    proc.kill();
    proxyJobs.delete(assetId);
    return true;
  });

  app.on('before-quit', () => {
    for (const proc of proxyJobs.values()) proc.kill();
    proxyJobs.clear();
    // A streaming encode's child is waiting on a pipe nobody will write to
    // again; left alone it would outlive the app holding a half-written file.
    for (const jobId of [...streams.keys()]) killStream(jobId);
  });

  /**
   * Open a staging dir for a render.
   *
   * `info` is what makes the dir resumable: without it nothing on disk says
   * what these frames were for, and a relaunched app can only delete them. It
   * is optional because the argument-less call is the shape every existing
   * caller uses (the Export dialog's one-shot renders, the headless CLI) and
   * those genuinely do not want to be resumed — a `premation render` that
   * exited is not something a later editor session should offer to finish.
   */
  handle('render:beginJob', async (e, info?: { spec?: unknown; format?: string; totalFrames?: number }) => {
    const jobId = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const dir = resumeJobDir(stagingRoot(), jobId);
    await mkdir(dir, { recursive: true });
    jobs.set(jobId, dir);
    owners.set(jobId, e.sender.id);
    cancelled.delete(jobId);
    if (info && typeof info.format === 'string') {
      await writeManifest(dir, {
        jobId,
        spec: info.spec ?? null,
        format: info.format,
        totalFrames: typeof info.totalFrames === 'number' ? info.totalFrames : 0,
        stagedFrames: 0,
        createdAt: Date.now(),
      });
    }
    return jobId;
  });

  /** Previous sessions' renders that still have frames on disk. */
  handle('render:listResumableJobs', async (): Promise<ResumableRenderJob[]> => {
    const found = await listResumableJobDirs(stagingRoot());
    // A job this process already owns is not "from a previous session" — it is
    // the render currently running, and offering it back would have the queue
    // adopt a directory its own live sink is still writing into.
    return found.filter((j) => !jobs.has(j.jobId));
  });

  /**
   * Re-register a previous session's dir under its ORIGINAL id.
   *
   * Same id on purpose: every other handler here is keyed by it, so once this
   * returns, `stageFrame`, `encode`, `save` and `cleanJob` all work on the
   * half-finished render with no second code path. The reply says exactly how
   * many contiguous frames are really present, counted off the files rather
   * than trusted from the manifest — a crash can leave the tally ahead of the
   * frames, and resuming one frame late writes a video with a hole in it.
   */
  handle('render:adoptJob', async (e, jobId: string): Promise<AdoptedRenderJob | null> => {
    const root = stagingRoot();
    const adopted = await inspectJob(root, jobId);
    if (!adopted) return null;
    jobs.set(jobId, resumeJobDir(root, jobId));
    owners.set(jobId, e.sender.id);
    return adopted;
  });

  /**
   * Throw away one staging dir — the "no, don't finish that" answer.
   *
   * Distinct from `cleanJob`, which reclaims a job that FINISHED. This one is
   * reachable for an id the process has never seen, because that is the whole
   * point: the queue is discarding something a previous session left behind.
   */
  handle('render:discardJob', async (_e, jobId: string) => {
    running.get(jobId)?.kill();
    running.delete(jobId);
    killStream(jobId);
    const dir = jobs.get(jobId) ?? resumeJobDir(stagingRoot(), jobId);
    jobs.delete(jobId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  /** Pre-export HDR capability — Export dialog shows HEVC vs H.264 High 10 before encode. */
  handle('render:probeHdr', async () => ({ libx265: await probeLibx265() }));

  handle(
    'render:stageFrame',
    async (_e, jobId: string, index: number, bytes: Uint8Array, ext: 'jpg' | 'png' = 'jpg') => {
      const dir = jobs.get(jobId);
      if (!dir) throw new Error('unknown render job');
      // Frame naming is a contract shared with the renderer (exportManager's
      // frameFileName) and with motion-back's render worker: 4-digit zero padding.
      // `%04d` is a MINIMUM width in ffmpeg, so renders longer than 9999 frames
      // still match. PNG is used only when the export needs an alpha channel.
      const name = `frame_${String(index).padStart(4, '0')}.${ext === 'png' ? 'png' : 'jpg'}`;
      await writeFile(path.join(dir, name), Buffer.from(bytes));
    },
  );

  handle('render:stageAudio', async (_e, jobId: string, bytes: Uint8Array) => {
    const dir = jobs.get(jobId);
    if (!dir) throw new Error('unknown render job');
    await writeFile(path.join(dir, 'audio.wav'), Buffer.from(bytes));
  });

  /**
   * Encode the staged frames into one file. `format` picks the codec/container;
   * everything else is derived so the renderer never has to know ffmpeg flags.
   */
  handle(
    'render:encode',
    async (
      _e,
      jobId: string,
      opts: {
        format: 'mp4' | 'webm' | 'gif' | 'mov';
        fps: number;
        hasAudio?: boolean;
        quality?: 'high' | 'medium' | 'draft';
        /** mov only — ProRes flavour. Defaults to 4444 (the alpha-capable one). */
        proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
        hdr?: 'pq' | 'hlg';
        hdrMastering?: {
          maxCll: number;
          maxFall: number;
          displayMaxNits: number;
          displayMinNits: number;
        };
        /**
         * Chapter marks, already rendered as FFMETADATA1 text by the renderer
         * (`src/core/export/chapters.ts`). Text and not a chapter array on
         * purpose: this process cannot import from `src/`, so formatting here
         * would mean a second, untested copy of the ffmetadata escaping rules.
         */
        chaptersFfmetadata?: string;
        /** mp4 only — a hardware encoder, opt-in. Probed; falls back to libx264. */
        videoEncoder?: VideoEncoder;
      },
    ) => {
      const dir = jobs.get(jobId);
      if (!dir) throw new Error('unknown render job');

      const staged = await stagedFrames(dir);
      const frames = staged.count;
      if (frames === 0) {
        throw new Error('No frames were staged — refusing to write an empty file.');
      }

      const input = path.join(dir, `frame_%04d.${staged.ext}`);
      const audio = opts.hasAudio ? path.join(dir, 'audio.wav') : null;
      const hasAudio = !!(audio && existsSync(audio));
      const out = path.join(dir, `out.${opts.format}`);
      // Even dimensions are required by yuv420p; odd-sized comps otherwise fail
      // the encode outright.
      const evenScale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
      const crf = opts.quality === 'draft' ? '28' : opts.quality === 'medium' ? '23' : '18';

      /*
        Chapters ride in as an extra INPUT, not as a flag — see
        ffmpegEncodeArgs.ts for the mapping rules. The file lands in the job's
        own staging dir, so `cleanJob` already deletes it and there is no second
        temp path to leak. Only MP4/MOV get it: passing it to a VP9 encode would
        produce an identical file plus a stray temp write.
      */
      const wantsChapters =
        (opts.format === 'mp4' || opts.format === 'mov')
        && typeof opts.chaptersFfmetadata === 'string'
        && opts.chaptersFfmetadata.trim().length > 0;
      if (wantsChapters) {
        await writeFile(path.join(dir, CHAPTER_METADATA_FILE), opts.chaptersFfmetadata!, 'utf8');
      }
      const chapterInput = wantsChapters ? ['-i', path.join(dir, CHAPTER_METADATA_FILE)] : [];
      // Input indices: frames are 0, the audio mix (when present) is 1, so the
      // metadata file is whatever comes next. Off by one here silently maps the
      // AUDIO input's (non-existent) chapters and delivers a file with none.
      const chapterMap = wantsChapters ? ['-map_chapters', String(hasAudio ? 2 : 1)] : [];

      const base = [
        '-y', '-framerate', ffmpegRate(opts.fps), '-i', input,
        ...(hasAudio ? ['-i', audio!] : []),
        ...chapterInput,
      ];

      // HDR10 / HLG: frames are already PQ/HLG-baked; tag BT.2020 + transfer.
      // Prefer libx265 10-bit; fall back to libx264 high10 with the same tags.
      if (opts.hdr === 'pq' || opts.hdr === 'hlg') {
        const trc = opts.hdr === 'pq' ? 'smpte2084' : 'arib-std-b67';
        const md = opts.hdrMastering ?? {
          maxCll: 1000,
          maxFall: 400,
          displayMaxNits: 1000,
          displayMinNits: 0.005,
        };
        const Lmax = Math.round(md.displayMaxNits * 10000);
        const Lmin = Math.round(md.displayMinNits * 10000);
        const masterDisplay =
          `G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(${Lmax},${Lmin})`;
        const x265Params =
          `hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=${trc === 'smpte2084' ? 'smpte2084' : 'arib-std-b67'}:colormatrix=bt2020nc` +
          `:master-display=${masterDisplay}:max-cll=${md.maxCll},${md.maxFall}`;
        const hdrCommon = [
          '-color_primaries', 'bt2020',
          '-color_trc', trc,
          '-colorspace', 'bt2020nc',
          '-color_range', 'tv',
          '-vf', evenScale,
          ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
          '-movflags', '+faststart',
          // The HDR presets deliver an MP4, so they carry chapters like any
          // other MP4 — `opts.format` is already 'mp4' by the time it gets here.
          ...chapterMap,
        ];
        const x265Args = [
          ...base,
          '-c:v', 'libx265',
          '-pix_fmt', 'yuv420p10le',
          '-crf', opts.quality === 'draft' ? '28' : opts.quality === 'medium' ? '24' : '20',
          '-x265-params', x265Params,
          ...hdrCommon,
          out,
        ];
        const x264Args = [
          ...base,
          '-c:v', 'libx264',
          '-profile:v', 'high10',
          '-pix_fmt', 'yuv420p10le',
          '-preset', opts.quality === 'draft' ? 'veryfast' : 'medium',
          '-crf', crf,
          ...hdrCommon,
          out,
        ];
        // Probe once so we don't pay a failed x265 spawn when the binary lacks it.
        const can265 = await probeLibx265();
        if (can265) {
          try {
            await runFfmpeg(jobId, x265Args);
            return { path: out, frames, videoCodec: 'libx265' as const };
          } catch {
            // Rare: probe said yes but encode failed — fall through.
          }
        }
        await runFfmpeg(jobId, x264Args);
        return { path: out, frames, videoCodec: 'libx264' as const };
      }

      // The codec/container half is shared with the streaming encode, so the two
      // paths cannot drift. Alpha follows what was staged: only a PNG sequence
      // carries it (a transparent comp stages PNG; see videoSink.ts).
      const encodeArgs = (videoEncoder: VideoEncoder): string[] => buildEncodeArgs({
        format: opts.format,
        videoInput: stagedVideoInput(input, opts.fps),
        quality: opts.quality,
        proresProfile: opts.proresProfile,
        audio: hasAudio ? audio : null,
        chaptersFile: wantsChapters ? path.join(dir, CHAPTER_METADATA_FILE) : null,
        alpha: staged.ext === 'png',
        videoEncoder,
        out,
      });
      const resolved = opts.format === 'mp4'
        ? await encoderProbe.resolveVideoEncoder(opts.videoEncoder)
        : { encoder: 'libx264' as const };
      let warning = resolved.fallbackReason;
      if (resolved.encoder !== 'libx264') {
        // The probe said yes; the real encode can still refuse (a device busy,
        // an unsupported frame size). The staged frames are all still here, so
        // one more ffmpeg run with libx264 costs nothing but time. A cancel
        // (`render:cancel` kills the child) must NOT be retried as software.
        try {
          await runFfmpeg(jobId, encodeArgs(resolved.encoder));
          return { path: out, frames, videoCodec: resolved.encoder };
        } catch (err) {
          if (cancelled.has(jobId)) throw err;
          warning = `${resolved.encoder} failed to encode (${String((err as Error)?.message ?? err).slice(-200)}); encoded with libx264 instead.`;
          console.warn(`[export] ${warning}`);
        }
      }
      await runFfmpeg(jobId, encodeArgs('libx264'));
      return { path: out, frames, videoCodec: 'libx264' as const, ...(warning ? { warning } : {}) };
    },
  );

  /**
   * Streaming encode: ONE ffmpeg child, opened when the export begins and fed
   * raw RGBA frames as they render (electron/ffmpegStream.ts).
   *
   * The counterpart of `stageFrame` × N + `encode`, sharing everything else
   * with them: the same job dir, the same staged `audio.wav` and chapters file,
   * the same command line bar the video input (`buildEncodeArgs`), and the same
   * `out.<ext>` — so `save`, `saveTo`, `cancel` and `cleanJob` work on a
   * streamed job unchanged. HDR is refused: its mastering metadata is measured
   * over every frame before the encode starts (see ffmpegEncodeArgs.ts).
   *
   * No resume manifest is ever written for a stream: its intermediate state is
   * inside the encoder, so there is nothing a later run could pick up.
   */
  handle('render:streamPreference', async (): Promise<'stream' | 'staged'> =>
    // The escape hatch, and the A/B switch the export benchmark uses.
    (process.env.MOTION_EXPORT_PIPELINE === 'staged' ? 'staged' : 'stream'));

  handle(
    'render:openStream',
    async (
      _e,
      jobId: string,
      opts: {
        format: EncodeFormat;
        fps: number;
        width: number;
        height: number;
        hasAudio?: boolean;
        quality?: 'high' | 'medium' | 'draft';
        proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
        alpha?: boolean;
        chaptersFfmetadata?: string;
        /** mp4 only — a hardware encoder, opt-in. Probed first; falls back to libx264. */
        videoEncoder?: VideoEncoder;
      },
    ): Promise<{ videoEncoder: VideoEncoder; warning?: string }> => {
      const dir = jobs.get(jobId);
      if (!dir) throw new Error('unknown render job');
      if (streams.has(jobId)) throw new Error('this render job is already streaming');
      if (!['mp4', 'webm', 'gif', 'mov'].includes(opts.format)) {
        throw new Error(`"${String(opts.format)}" cannot be streamed`);
      }
      const width = Math.trunc(opts.width);
      const height = Math.trunc(opts.height);
      if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384)) {
        throw new Error(`invalid stream frame size ${opts.width}x${opts.height}`);
      }
      if (!(Number.isFinite(opts.fps) && opts.fps > 0)) throw new Error('invalid stream frame rate');

      const audio = opts.hasAudio ? path.join(dir, 'audio.wav') : null;
      const hasAudio = !!(audio && existsSync(audio));
      const wantsChapters =
        (opts.format === 'mp4' || opts.format === 'mov')
        && typeof opts.chaptersFfmetadata === 'string'
        && opts.chaptersFfmetadata.trim().length > 0;
      if (wantsChapters) {
        await writeFile(path.join(dir, CHAPTER_METADATA_FILE), opts.chaptersFfmetadata!, 'utf8');
      }
      const out = path.join(dir, `out.${opts.format}`);
      // A stream cannot retry: once frames have gone into a child that then
      // dies, they are gone. So the hardware encoder is proven BEFORE the
      // child opens (a cached smoke encode, see encoderProbe.ts), and anything
      // the probe cannot vouch for streams into libx264 with a stated reason.
      const resolved = opts.format === 'mp4'
        ? await encoderProbe.resolveVideoEncoder(opts.videoEncoder)
        : { encoder: 'libx264' as const };
      if (resolved.fallbackReason) console.warn(`[export] ${resolved.fallbackReason}`);
      const args = buildEncodeArgs({
        format: opts.format,
        videoInput: rawVideoInput(width, height, opts.fps),
        frame: { width, height, fps: opts.fps },
        quality: opts.quality,
        proresProfile: opts.proresProfile,
        audio: hasAudio ? audio : null,
        chaptersFile: wantsChapters ? path.join(dir, CHAPTER_METADATA_FILE) : null,
        alpha: !!opts.alpha,
        videoEncoder: resolved.encoder,
        // Raw rgba carries no colour description; a staged PNG does. Tagging
        // the frames sRGB is what makes the two encodes byte-identical.
        tagSrgb: true,
        out,
      });
      const stream = await FfmpegStdinStream.open({ bin: resolveFfmpeg(), args, frameBytes: width * height * 4 });
      streams.set(jobId, { stream, out });
      return {
        videoEncoder: resolved.encoder,
        ...(resolved.fallbackReason ? { warning: resolved.fallbackReason } : {}),
      };
    },
  );

  /**
   * One PIECE of a frame into the stream — the raw pixel pipe's unit of IPC.
   *
   * A whole 4K frame is 33 MB, and one IPC message of that size is copied
   * through structured clone into main's heap before anything can push back.
   * The renderer therefore sends `RAW_PIPE_CHUNK_BYTES` (4 MiB) at a time and
   * awaits THIS handler's resolution for each — which comes only once the
   * chunk has drained into ffmpeg's stdin. Memory in main is bounded by one
   * chunk plus the pipe buffer, whatever the frame size or the encoder speed.
   * See src/core/export/rawPipe.ts for the renderer half.
   */
  handle(
    'render:streamChunk',
    async (_e, jobId: string, index: number, offset: number, bytes: Uint8Array, last: boolean) => {
      const entry = streams.get(jobId);
      if (!entry) throw new Error('this render job is not streaming');
      if (!(bytes instanceof Uint8Array)) throw new Error('a stream chunk must be a Uint8Array');
      if (bytes.byteLength > RAW_PIPE_MAX_CHUNK_BYTES) {
        throw new Error(`stream chunk of ${bytes.byteLength} bytes exceeds the ${RAW_PIPE_MAX_CHUNK_BYTES}-byte limit`);
      }
      if (!Number.isInteger(index) || !Number.isInteger(offset) || index < 0 || offset < 0) {
        throw new Error('invalid stream chunk position');
      }
      await entry.stream.writeChunk(index, offset, bytes, !!last);
    },
  );

  /**
   * Which hardware encoders work on THIS machine — probed once per session,
   * for the Settings picker. Empty where ffmpeg is missing: the picker then
   * offers software only, and an export still explains itself at encode time.
   */
  handle('render:probeEncoders', async () => ({ hardware: await encoderProbe.availableHw() }));

  /**
   * One frame into the stream. Resolves only once ffmpeg's stdin has drained —
   * that await IS the back-pressure: the renderer does not send the next frame
   * until this returns, so a slow encoder slows the render instead of growing
   * this process's heap.
   */
  handle('render:streamFrame', async (_e, jobId: string, index: number, bytes: Uint8Array) => {
    const entry = streams.get(jobId);
    if (!entry) throw new Error('this render job is not streaming');
    await entry.stream.write(index, bytes);
  });

  /** Close the stream and wait for the encoder to write `out.<ext>`. */
  handle('render:finishStream', async (_e, jobId: string) => {
    const entry = streams.get(jobId);
    if (!entry) throw new Error('this render job is not streaming');
    try {
      const frames = await entry.stream.finish();
      return { path: entry.out, frames };
    } finally {
      streams.delete(jobId);
    }
  });

  /** Kill a running encode (the queue's Pause / the dialog's Cancel). */
  handle('render:cancel', async (_e, jobId: string) => {
    cancelled.add(jobId);
    running.get(jobId)?.kill();
    running.delete(jobId);
    killStream(jobId);
  });

  /**
   * Move a finished render to a path the user picks.
   *
   * The alternative — reading the file back into the renderer as a Blob and
   * triggering a browser download — copies the entire output through the
   * renderer heap and drops it in the default download folder. For a desktop app
   * exporting multi-gigabyte video, both halves of that are wrong.
   */
  /** Move a job's encoded file to `target`, across volumes if need be. */
  const moveOutput = async (jobId: string, ext: string, target: string): Promise<void> => {
    const dir = jobs.get(jobId);
    if (!dir) throw new Error('unknown render job');
    const produced = path.join(dir, `out.${ext}`);
    if (!existsSync(produced)) throw new Error(`nothing encoded for this job (${ext})`);
    try {
      await rename(produced, target);
    } catch {
      // rename fails across volumes (temp on C:, target on D:) — copy instead.
      await copyFile(produced, target);
      await unlink(produced).catch(() => undefined);
    }
  };

  handle('render:save', async (_e, jobId: string, defaultName: string) => {
    const ext = path.extname(defaultName).replace('.', '') || 'mp4';
    const res = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await moveOutput(jobId, ext, res.filePath);
    return { path: res.filePath };
  });

  /**
   * Save into a folder the user picked earlier, with no dialog.
   *
   * This is what makes the render queue worth using: a queue that opens a save
   * dialog per job stops dead on the first one and waits for someone to come
   * back, which is the opposite of queueing work up and walking away.
   *
   * Never overwrites — an existing name gets ` (2)`, ` (3)` and so on, because
   * silently replacing a previous render is not recoverable.
   *
   * `overwrite` opts out, and only the headless CLI passes it: an invocation
   * that named its output file must produce that file, or a pipeline's artifact
   * path stops being knowable after the first run. The queue never sets it.
   */
  handle('render:saveTo', async (_e, jobId: string, dir: string, filename: string, overwrite?: boolean) => {
    const ext = path.extname(filename).replace('.', '') || 'mp4';
    const stem = path.basename(filename, `.${ext}`);
    let target = path.join(dir, filename);
    if (!overwrite) {
      for (let n = 2; existsSync(target); n++) target = path.join(dir, `${stem} (${n}).${ext}`);
    }
    await moveOutput(jobId, ext, target);
    return { path: target };
  });

  /** Directory picker for the render queue's output folder. */
  handle('render:chooseOutputDir', async () => {
    const res = await dialog.showOpenDialog({ ...rememberedDir('outputFolder'), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled) return null;
    rememberDir('outputFolder', res.filePaths[0], true);
    return res.filePaths[0] ?? null;
  });

  handle('render:cleanJob', async (_e, jobId: string) => {
    const dir = jobs.get(jobId);
    if (!dir) return;
    running.get(jobId)?.kill();
    running.delete(jobId);
    killStream(jobId);
    jobs.delete(jobId);
    owners.delete(jobId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  return {
    async abortJobsOwnedBy(webContentsId) {
      for (const [jobId, owner] of [...owners]) {
        if (owner !== webContentsId) continue;
        cancelled.add(jobId);
        running.get(jobId)?.kill();
        running.delete(jobId);
        killStream(jobId);
        const dir = jobs.get(jobId);
        jobs.delete(jobId);
        owners.delete(jobId);
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * Native application menu. Items forward a command id to the renderer, which
 * executes it through the same CommandSystem the in-app UI uses — so the menu
 * never duplicates behaviour, it just triggers commands.
 *
 * GENERATED FROM THE RENDERER'S MENU MODEL. The renderer serialises
 * `menuModel.ts` (labels, chords, submenus, visibility and checked state all
 * evaluated) and sends it over `menu:setTemplate`; `electron/nativeMenu.ts`
 * validates it and adds the roles only main can own. Until the first
 * template arrives — the window's first paint, before the renderer has booted
 * — a minimal bootstrap menu holds the slot so Alt never shows an empty bar.
 * The hand-maintained item list this replaced had already drifted from the
 * in-app menu ("Save to Computer…" for what the app calls "Save Portable
 * Copy…"), which is the whole reason it is generated now.
 */
function buildApplicationMenu(win: BrowserWindow, groups?: ReadonlyArray<NativeMenuGroupSpec>): void {
  const cmd = (id: string) => () => win.webContents.send('menu:command', id);
  const opts: NativeMenuOptions = {
    platform: process.platform,
    isDev,
    version: app.getVersion(),
    cmd,
    checkForUpdates: () => checkForUpdatesInteractive(win),
  };
  const bootstrap: NativeMenuGroupSpec[] = [
    {
      id: 'file',
      label: 'File',
      items: [
        { label: 'New Project', commandId: 'project.new', accelerator: 'CmdOrCtrl+N' },
        { label: 'Open Project…', commandId: 'project.open', accelerator: 'CmdOrCtrl+O' },
        { type: 'separator' },
        { label: 'Save', commandId: 'project.save', accelerator: 'CmdOrCtrl+S' },
      ],
    },
    { id: 'view', label: 'View', items: [{ label: 'Command Palette', commandId: 'view.commandPalette' }] },
    { id: 'help', label: 'Help', items: [{ label: 'About Premation', commandId: 'help.about' }] },
  ];
  const template = nativeTemplateFromGroups(groups ?? bootstrap, opts);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * `menu:setTemplate` — the renderer's serialised menu model. Only the main
 * window may set the application menu; a pop-out sending this is ignored.
 */
function registerMenuIpc(): void {
  handle('menu:setTemplate', async (e, raw: unknown) => {
    const win = mainWindow;
    if (!win || e.sender !== win.webContents) return { ok: false };
    const groups = sanitizeMenuGroups(raw);
    if (!groups) return { ok: false };
    buildApplicationMenu(win, groups);
    return { ok: true };
  });
}

/**
 * Window/taskbar icon (the Premation mark). Packaged Windows and macOS builds
 * take their icon from electron-builder's `icon:` instead, so this is a
 * best-effort lookup for dev and Linux — undefined when the file isn't there.
 */
function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'build', 'icon.png'),
  ];
  return candidates.find((p) => p && existsSync(p));
}

/** Windows created with a Window Controls Overlay — the only ones `window:setTitleBarOverlay` may restyle. */
const overlayWindows = new WeakSet<BrowserWindow>();

function createMainWindow(): BrowserWindow {
  const appIcon = resolveAppIcon();
  // macOS or Windows / Linux chrome: the OS, or `PREMATION_UI_PLATFORM` in
  // development (electron/uiPlatform.ts). dist-electron/ sits one level under
  // the repo root, where Vite reads the same dotenv files.
  const chrome = resolveUiChrome({
    osPlatform: process.platform,
    isDev,
    override: isDev ? devUiPlatformOverride(process.env, path.join(__dirname, '..')) : undefined,
  });
  if (chrome.overridden) {
    console.info(`[ui] previewing the ${chrome.platform} chrome (PREMATION_UI_PLATFORM), ${chrome.windowControls} window controls`);
  }
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    title: 'Premation',
    ...(appIcon ? { icon: appIcon } : {}),
    backgroundColor: '#0a0a0b',
    show: false,
    autoHideMenuBar: true,
    ...windowChromeOptions(chrome),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /*
        The OS-level renderer sandbox. ON.

        It was off, with a comment stating that `sandbox: true` breaks WebGPU
        adapter creation. That was measured and is not true here: on Electron
        32.3.3 / Chromium 128, a sandboxed renderer reports `navigator.gpu`
        defined, `requestAdapter()` resolving to an adapter, `requestDevice()`
        succeeding, and WebGL2 available — over both `file://` (the packaged
        build's load path) and `http://` (the dev server's). Whatever was true
        when that comment was written, Chromium's GPU sandboxing has moved.

        It matters more here than in most Electron apps. This renderer embeds
        third-party plugin panels, and `contextIsolation` + `nodeIntegration:
        false` bound what a compromised renderer can ASK for — the sandbox
        bounds what the process itself can DO if one of those is ever escaped.

        The preload is sandbox-compatible: it imports only `contextBridge` and
        `ipcRenderer`, and reads `process.platform` / `process.versions`, all of
        which a sandboxed preload is given.

        Re-measured on Electron 44.4.3 / Chromium 152 (C4, 2026-09-23): the
        real app, sandboxed, reports WebGPU `resolvedKind: 'webgpu'` on the dev
        server, and the hidden export windows render and encode.

        Re-measure at the next Electron upgrade rather than trusting this note:
        `electron/sandboxSupport.test.ts` records what was checked and how.
      */
      sandbox: true,
      webgl: true,
      // DevTools only in development. A shipped build has no inspector, so no
      // "Inspect", no console, and no "allow pasting" prompt for end users.
      devTools: isDev,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    // After the window is up, not before: an update dialog in front of a blank
    // screen looks like a crash, and a check during startup competes with the
    // renderer for the network.
    initAutoUpdate(win);
  });

  // External links open in default browser; pop-out window links spawn internal Electron desktop windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('popout') || url.includes('#/popout/')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          frame: false,
          autoHideMenuBar: true,
          backgroundColor: '#0a0a0b',
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Same as the main window — see the note there. A pop-out running
            // less sandboxed than the window it came from is the kind of gap
            // nobody looks for.
            sandbox: true,
            webgl: true,
            devTools: isDev,
          },
        },
      };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  buildApplicationMenu(win);
  if (hasTitleBarOverlay(chrome)) overlayWindows.add(win);

  // The C++ engine's shared-texture receiver belongs to the page that installed
  // it: a reload or a renderer crash takes it away until the page says it is
  // back (electron/engineHost.ts — early sends time out).
  win.webContents.on('did-start-loading', () => engineHost?.pageReset());
  win.webContents.on('render-process-gone', () => engineHost?.pageReset());

  // The renderer draws the bar at first paint, so it reads the chrome off the
  // URL rather than asking over IPC (src/core/config/uiPlatform.ts).
  const chromeQuery = uiChromeQuery(chrome);
  if (isDev) {
    void win.loadURL(`${DEV_SERVER_URL}/?${new URLSearchParams(chromeQuery).toString()}`);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: chromeQuery });
  }

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

/**
 * Open a provider sign-in URL in the SYSTEM browser.
 *
 * The renderer passes the backend's `/auth/oauth/<provider>/start?client=desktop`
 * URL; we refuse anything that is not http(s) so a compromised renderer cannot
 * use this to launch arbitrary local schemes (file:, and — the one that would
 * bite — premation: itself, re-entering our own deep-link handler).
 */
function registerOAuthIpc(): void {
  handle('oauth:openExternal', async (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('oauth:openExternal invalid url');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('oauth:openExternal refused non-http url');
    }
    await shell.openExternal(url);
  });
}

function registerPopoutIpc(): void {
  handle('popout:spawnWindow', (event, panelId: string) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    const popoutWin = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 400,
      minHeight: 300,
      title: `${panelId} — Premation`,
      backgroundColor: '#0a0a0b',
      autoHideMenuBar: true,
      frame: false,
      parent: parentWin ?? undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Same as the main window — see the note there.
        sandbox: true,
        webgl: true,
      },
    });

    const isDev = process.env.NODE_ENV === 'development';
    const popoutUrl = isDev
      ? `${DEV_SERVER_URL}/#/popout/${panelId}`
      : `file://${path.join(__dirname, '..', 'dist', 'index.html')}#/popout/${panelId}`;

    void popoutWin.loadURL(popoutUrl);
    popoutWin.once('ready-to-show', () => popoutWin.show());
  });

}

/**
 * Production hardening. `devTools: false` in webPreferences is the real gate;
 * this is defence in depth for every webContents (main + pop-outs): swallow the
 * DevTools shortcuts (F12, Ctrl/Cmd+Shift+I/J/C), suppress the native right-click
 * "Inspect" menu, and slam DevTools shut if anything still manages to open it.
 * No-op in development, where the inspector stays fully available.
 */
function hardenWebContents(contents: WebContents): void {
  if (isDev) return;
  contents.on('context-menu', (e) => e.preventDefault());
  contents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    if (key === 'f12' || (mod && input.shift && (key === 'i' || key === 'j' || key === 'c'))) {
      event.preventDefault();
    }
  });
  contents.on('devtools-opened', () => contents.closeDevTools());
}

app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

// The renderer's ground-truth WebGPU probe result (adapter/device/configure +
// any error), appended to the same log the main process writes. This is what
// actually answers "is WebGPU working" on a packaged build with no DevTools.
on('diag:gpuReport', (_event, report: unknown) => {
  try {
    const line = `${new Date().toISOString()} [renderer] ${JSON.stringify(report)}\n`;
    const logPath = path.join(app.getPath('userData'), 'gpu-diagnostics.log');
    void writeFile(logPath, line, { flag: 'a' });
    console.log('[gpu:renderer]', report);
  } catch (e) {
    console.warn('[gpu] renderer report failed', e);
  }
});

/**
 * One-shot GPU report to the main-process console AND
 * <userData>/gpu-diagnostics.log. Because a shipped build has no DevTools, this
 * file is how we tell whether Chromium reports WebGPU 'enabled' vs
 * 'disabled_software'/'disabled_off', and which adapter/driver it picked — the
 * difference between "your GPU can't" and "the app's probe is misfiring".
 */
async function logGpuDiagnostics(): Promise<void> {
  try {
    const status = app.getGPUFeatureStatus();
    let info: unknown = null;
    try {
      info = await app.getGPUInfo('basic');
    } catch {
      /* getGPUInfo rejects on some drivers; the feature status is the key part */
    }
    console.log('[gpu] featureStatus', status);
    console.log('[gpu] info', info);
    const line = `${new Date().toISOString()} v${app.getVersion()} featureStatus=${JSON.stringify(status)} info=${JSON.stringify(info)}\n`;
    const logPath = path.join(app.getPath('userData'), 'gpu-diagnostics.log');
    await writeFile(logPath, line, { flag: 'a' });
    console.log('[gpu] wrote diagnostics to', logPath);
  } catch (e) {
    console.warn('[gpu] diagnostics failed', e);
  }
}

/**
 * The renderer reports its own edition on first paint so a build whose two
 * halves disagree says so. Not authoritative — see preload's `reportEdition`.
 *
 * Registered by BOTH launch shapes. The renderer sends this unconditionally
 * from its entry module, so leaving it out of the headless path did not make it
 * un-sent — it made every CLI run print an Electron "no handler registered"
 * stack trace over the render's own output.
 */
function registerEditionReportIpc(): void {
  handle('edition:report', (_event, reported: unknown) => {
    const result = assertRendererEditionMatches(reported);
    if (!result.ok) console.error(result.message);
    return result;
  });
}

/**
 * The bundled Object Matte model files (dist/models/**, placed there by
 * scripts/fetchObjectMatte.cjs and shipped inside app.asar).
 *
 * The packaged renderer runs from file://, where `fetch` reaches nothing local,
 * so the bytes come over IPC instead. A fixed name→path allowlist rather than a
 * path parameter: this channel reads three known files out of our own bundle
 * and must never become a general file read (that is `file:readBytes`, which
 * takes a user-picked path through a dialog).
 */
const OBJECT_MATTE_FILES: Readonly<Record<string, string>> = {
  'vision_encoder_quantized.onnx': path.join('models', 'object-matte', 'vision_encoder_quantized.onnx'),
  'prompt_encoder_mask_decoder_quantized.onnx': path.join('models', 'object-matte', 'prompt_encoder_mask_decoder_quantized.onnx'),
  'ort-wasm-simd-threaded.jsep.wasm': path.join('models', 'ort', 'ort-wasm-simd-threaded.jsep.wasm'),
  'ort-wasm-simd-threaded.jsep.mjs': path.join('models', 'ort', 'ort-wasm-simd-threaded.jsep.mjs'),
};

function objectMatteAbsPath(name: unknown): string | null {
  const rel = typeof name === 'string' ? OBJECT_MATTE_FILES[name] : undefined;
  // Same root the window loads from (`../dist/index.html`).
  return rel ? path.join(__dirname, '..', 'dist', rel) : null;
}

function registerObjectMatteIpc(): void {
  handle('objectMatte:read', async (_event, name: unknown) => {
    const abs = objectMatteAbsPath(name);
    if (!abs) return null;
    try {
      // fs is asar-aware, so this reads straight out of the archive when packaged.
      return await readFile(abs);
    } catch {
      // A build that never ran the fetch script — the renderer falls back to
      // classical GrabCut, exactly as when the files are absent over http.
      return null;
    }
  });

  // The ORT glue is a MODULE: the renderer must `import()` it, so it needs a
  // URL, not bytes. Answered only for files that exist — an import that would
  // 404 is better refused here, where the fallback is graceful.
  handle('objectMatte:url', async (_event, name: unknown) => {
    const abs = objectMatteAbsPath(name);
    if (!abs) return null;
    try {
      await access(abs);
      return pathToFileURL(abs).href;
    } catch {
      return null;
    }
  });
}

/** Resolve `local-file://` URLs (imported media) to real files on disk. */
function registerLocalFileProtocol(): void {
  protocol.handle('local-file', (request) => {
    // Both `local-file://C:/…` (which Chromium ≥ 130 delivers as
    // `local-file://C/…`) and `local-file:///C:/…` — see localFileUrl.ts.
    const filePath = localFileUrlToPath(request.url);
    if (!filePath) return new Response(null, { status: 400 });
    return net.fetch(pathToFileURL(filePath).href);
  });
}

/**
 * Boot just enough of the app to render one file, then exit.
 *
 * The registrations here are a deliberately SHORTER list than a GUI launch's,
 * and the omissions are the point. A headless render never signs in, never
 * publishes, never talks to a provider and never loads a plugin's network
 * bridge, so none of those channels are opened — the same argument the GUI path
 * makes for gating them by edition, applied to a process that has even less
 * business holding them open. What is left is the disk (the project, its
 * assets, its blobs) and ffmpeg.
 */
function bootHeadlessRun(
  cli: Extract<CliInvocation, { kind: 'render' } | { kind: 'comps' } | { kind: 'captions' }>,
): void {
  registerLocalFileProtocol();
  registerFileIpc();
  registerBundleIpc();
  registerBlobIpc();
  registerIndexIpc(app);
  registerThumbIpc(app);
  registerRenderIpc();
  registerEditionReportIpc();

  void runCliAndExit(
    cli.kind === 'render'
      ? { request: { kind: 'render', job: cli.job }, output: cli.output }
      : cli.kind === 'captions'
        ? {
            request: {
              kind: 'captions',
              projectPath: cli.projectPath,
              outPath: cli.outPath,
              ...(cli.comp ? { comp: cli.comp } : {}),
              ...(cli.language ? { language: cli.language } : {}),
            },
            output: cli.output,
          }
        : { request: { kind: 'comps', projectPath: cli.projectPath }, output: cli.output },
  );
}

app.whenReady().then(() => {
  // A second instance already relayed its deep link and quit; this one should not
  // have reached whenReady, but guard anyway rather than open a duplicate window.
  if (!hasSingleInstanceLock) return;

  // A render, not an editor: no menu, no updater, no managed backend, no
  // protocol registration, no GPU diagnostics timer — and no window anyone can
  // see. It exits the process itself once the file is written.
  // Re-tested rather than reusing `isHeadlessRun`: a boolean does not narrow
  // the union, and `bootHeadlessRun` may only be handed an invocation that
  // actually carries a job.
  if (
    cliInvocation.kind === 'render'
    || cliInvocation.kind === 'comps'
    || cliInvocation.kind === 'captions'
  ) {
    bootHeadlessRun(cliInvocation);
    return;
  }

  // Sweep render staging dirs older than two days. They leak whenever a save
  // fails mid-move, the app crashes mid-export, or a finished render's save
  // dialog is dismissed (the encode is deliberately KEPT then) — multi-GB
  // `motion-render-*` dirs otherwise accumulate in %TEMP% forever. Age-gated
  // so a render running in ANOTHER instance is never swept out from under it.
  void (async () => {
    try {
      const temp = app.getPath('temp');
      const entries = await readdir(temp);
      const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
      for (const name of entries) {
        if (!name.startsWith('motion-render-')) continue;
        const full = path.join(temp, name);
        try {
          const info = await stat(full);
          if (info.mtimeMs < cutoff) await rm(full, { recursive: true, force: true });
        } catch { /* raced with another process — leave it */ }
      }
    } catch { /* temp unreadable — nothing to sweep */ }
  })();

  // Kick the GPU process awake NOW, during boot, so it is ready before the first
  // viewport mounts. Without this the renderer can win the race to first-init and
  // fail every rung (WebGPU + WebGL2) against a GPU that is milliseconds from
  // ready — the packaged-build "GPU unavailable on first entry" symptom. Fire and
  // forget; the renderer has its own cold-start retry as the real safety net.
  void app.getGPUInfo('complete').catch(() => { /* GPU info is best-effort */ });

  // Claim the premation:// scheme so the OAuth callback can hand the code back.
  registerProtocolClient();

  // Where each file dialog last was (Electron 43+ no longer lets the OS
  // remember — see electron/dialogDirs.ts).
  initDialogDirs(path.join(app.getPath('userData'), 'dialog-dirs.json'));

  registerLocalFileProtocol();

  registerFileIpc();
  registerBundleIpc();
  registerBlobIpc();
  registerIndexIpc(app);
  registerThumbIpc(app);
  registerRevealIpc();
  const renderIpc = registerRenderIpc();
  // Desktop export as a main-owned queue, each job in a hidden window of its
  // own (electron/exportProcess.ts). The queue file is read now, so jobs left
  // from a previous session are listed the moment the editor asks; they start
  // once the editor window is up, so a queued render never begins on a
  // machine whose editor has not even painted.
  exportSupervisor = createExportSupervisor({ abortRenderJobsOwnedBy: renderIpc.abortJobsOwnedBy });
  registerExportSupervisorIpc(exportSupervisor);
  installExportQuitGuard(exportSupervisor);
  const supervisorLoaded = exportSupervisor.load();
  registerPopoutIpc();
  registerOAuthIpc();
  // Bundled neural segmentation model — read-only, allowlisted, no gate: the
  // files ship in every edition and reading our own bundle spends nothing.
  registerObjectMatteIpc();
  // The custom-model download (Settings ▸ Object Matte ▸ Install). In main
  // because the page CSP names no model host — see electron/modelDownload.ts.
  // Ungated: it attaches no credential and runs only on an explicit press.
  registerModelDownloadIpc();
  // A plugin's outbound requests. Here rather than in the renderer because the
  // app shell's `connect-src` does not name a plugin's hosts, and widening it
  // to cover them would widen the whole renderer rather than the plugin.
  //
  // GATED on `pluginsEnabled()`, which is on in both editions now that the
  // local edition installs plugins from local files. "The renderer never calls
  // it" is not a gate on the privileged side of this boundary, so the predicate
  // stays the one switch. A request still leaves only for a plugin granted
  // `net:fetch`, to a host its manifest declared — see edition.ts.
  if (pluginsEnabled()) registerPluginNetIpc();
  // Plugins that live in a folder on this machine — the user's own, a
  // machine-wide one an installer wrote, and anything MOTION_PLUGIN_PATH names.
  // Gated with the rest: it reads directories and hands the bytes to the
  // renderer, which is a filesystem capability and belongs behind the same
  // switch. The paths it will read are fixed in pluginLoader.ts, never named by
  // the renderer.
  if (pluginsEnabled()) registerPluginLoaderIpc();
  // A plugin's COMPILED module, in a utility process of its own.
  //
  // Behind the same switch, and it starts nothing on its own: no process exists
  // until the renderer asks for one, which it does only after a signature check
  // and a consent step naming the binary. What this registration adds to a
  // machine with no native plugins is four idle IPC handlers.
  if (pluginsEnabled()) registerPluginNativeIpc();
  // The account session, and every authenticated call that uses it.
  //
  // Both tokens live in this process. There is no `credentials:get` any more:
  // the renderer asks for a REQUEST to be made and never for the credential
  // that makes it possible, so a compromised renderer can spend the session but
  // cannot take it somewhere else. See apiSession.ts for the full argument, and
  // apiBase.ts for why this is `api.request(path)` and not `fetch(url)`.
  registerApiProxyIpc();

  // Publishing a plugin. Both secrets involved — the session above and the
  // publisher's private signing key — stay in this process; the renderer sends
  // bytes and a visibility choice and gets a result back. See pluginPublish.ts
  // for why the key is picked per publish rather than remembered.
  //
  // Gated with the rest. Publishing needs an account and a registry, neither of
  // which the local edition has, and the channel opens a file picker — a UI
  // affordance appearing in a build with no way to use what it produces.
  // (`pluginPublishEnabled`, not `pluginsEnabled`: the local edition runs
  // plugins installed from local files but has no registry to publish to.)
  if (pluginPublishEnabled()) installPluginPublishIpc();

  // The assistant. Provider keys live here rather than in the renderer —
  // encrypted with the OS keystore, with NO read-back verb (aiKeyVault.ts) — and
  // the provider calls happen here too, which is what lets the vault stay
  // write-only and keeps the provider hosts out of the page CSP (aiProxy.ts).
  //
  // GATED, where this used to be unconditional. The old comment argued that one
  // IPC surface for both editions was simpler to reason about, and that held
  // while both editions shipped the assistant. The local edition no longer does,
  // and "the renderer doesn't render the panel" is not a gate: this is the
  // privileged side of the boundary, and anything running in the renderer — a
  // third-party plugin panel, an imported document, the DevTools console of a
  // packaged build — can invoke a channel that exists. Not registering it is the
  // gate. It is also what keeps the local edition off the network: aiProxy is the
  // only code here that contacts a third-party host. See electron/edition.ts.
  if (aiEnabled()) {
    registerAiKeyIpc();
    registerAiProxyIpc();
    registerMediaKeyIpc();
    registerAiMediaProxyIpc();
  }

  registerEditionReportIpc();
  registerMenuIpc();
  // Before the window exists: the page asks for the update status during boot,
  // which on Electron 44 is earlier than `ready-to-show` (see updater.ts).
  registerUpdaterIpc();

  // The C++ engine process (NATIVE_CORE_PLAN C3), behind its flag. The
  // channels exist before the window does (the page asks for the status at
  // boot); `engine:status` answers `enabled: false` when the flag is off.
  engineHost = new EngineHost({
    enabled: engineBackendEnabled(process.env, enginePreferenceFile(app.getPath('userData'))),
    isDev,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // Development runs `electron dist-electron/main.js`: the repo root is one up.
    appPath: app.isPackaged ? app.getAppPath() : path.join(__dirname, '..'),
    hostPid: process.pid,
    appVersion: app.getVersion(),
    getGPUInfo: (level) => app.getGPUInfo(level),
    getWindow: () => mainWindow,
    sharedTexture: sharedTexture as unknown as SharedTextureApi,
    // G1: native SDK plugins load in the engine process from this folder.
    nativePluginDir: ensureDir(path.join(app.getPath('userData'), 'native-plugins')),
    nativePluginJournal: path.join(app.getPath('userData'), 'native-plugin-journal.bin'),
  });
  registerEngineIpc(engineHost);
  // Dev only: the real-app harness reads the frame-forwarding counters from
  // the main-process inspector (`globalThis.__premationEngineHost.frames.stats`).
  if (isDev) (globalThis as { __premationEngineHost?: EngineHost }).__premationEngineHost = engineHost;

  // A normal build is a CLIENT: it talks to a deployed motion-back at the origin
  // baked in by VITE_BACKEND_ORIGIN, or to one you run yourself on localhost:4000
  // (see src/core/api/env.ts). It starts no server of its own.
  //
  // The app manages a server only when one was bundled into the build
  // (electron-builder.selfhosted.yml) or when MOTION_LOCAL_BACKEND=1 asks for it.
  // Either way it reuses a server already listening rather than duplicating it.
  if (shouldStartBackend()) void startBackend();

  const win = createMainWindow();

  // After ready, beside the window: the engine asks Chromium which adapter it
  // composits on, so it can render where the page will sample (C1).
  if (engineHost.enabled) {
    void engineHost.start();
    app.on('child-process-gone', (_event, details) => {
      if (details.type === 'GPU') engineHost?.gpuProcessGone(details.reason);
    });
  }

  // Report GPU status AFTER the renderer has loaded and touched the GPU. Reading
  // in whenReady catches Chromium's GPU process before it initializes (every
  // adapter inactive, initializationTime:0) — a premature, misleading snapshot.
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => void logGpuDiagnostics(), 6000);
    // Jobs queued in a previous session start now, with an editor to show them.
    void supervisorLoaded.then(() => exportSupervisor?.dispatch());
  });

  // Cold start via a premation:// link (Windows/Linux put it in argv). Wait for
  // the renderer to be ready to receive before forwarding the code.
  const coldLink = findDeepLink(process.argv);
  if (coldLink) {
    win.webContents.once('did-finish-load', () => handleDeepLink(coldLink));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  // A headless run owns its own exit (`runCliAndExit`). Quitting here as well
  // would race it: the hidden window closes the moment the render resolves, and
  // on a fast `comps` listing that fires before the result has been printed.
  if (isHeadlessRun) return;
  // The editor window is gone but exports may not be: a queued render is not
  // the editor's to take with it. The process stays up, headless, until the
  // queue drains, then quits (unless a window has opened again by then).
  if (exportSupervisor && keepAliveForExports(exportSupervisor, () => app.quit())) return;
  if (process.platform !== 'darwin') app.quit();
});

// Ensure the managed server is torn down on every exit path.
app.on('before-quit', () => {
  stopBackend();
  // Otherwise a fetch to a provider — or to our own backend — can outlive the
  // window that asked for it and hold the process open after every window is
  // gone.
  abortAllStreams();
  abortAllApiStreams();
  abortAllModelDownloads();
  // A plugin's utility process is a child of this one and would otherwise keep
  // running after the last window closed — a stranger's compiled code with no
  // editor left to serve.
  disposeNativePlugins();
  // The engine gets a Goodbye and exits on its own; the supervisor kills it
  // after 2 s if it does not (a closing stdin ends it either way).
  void engineHost?.stop();
});
