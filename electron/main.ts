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
import { readFile, writeFile, mkdir, unlink, readdir, access, rm, copyFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from './atomicWrite';
import { initDialogDirs, rememberDir, rememberedDir } from './dialogDirs';
import { localFileUrlToPath } from './localFileUrl';
import { EngineHost, registerEngineIpc, type SharedTextureApi } from './engineHost';
import { handleEngineUnavailable } from './engineUnavailable';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolveFfmpegBinary } from './ffmpegBinary';
import { EncoderProbe } from './encoderProbe';
import { shouldStartBackend, startBackend, stopBackend } from './backend';
import { registerIndexIpc } from './localIndexDb';
import { registerThumbIpc } from './thumbCache';
import { registerRevealIpc } from './ipc/reveal';
import { registerNativePluginIpc } from './ipc/nativePlugins';
import { getKeyForProvider, registerAiKeyIpc, VAULT_PROVIDERS, type VaultProvider } from './aiKeyVault';
import { registerAiProxyIpc, abortAllStreams } from './aiProxy';
import { registerModelDownloadIpc, abortAllModelDownloads } from './modelDownload';
import { registerMediaKeyIpc } from './mediaKeyVault';
import { registerAiMediaProxyIpc } from './aiMediaProxy';
import { registerApiProxyIpc, abortAllApiStreams } from './apiProxy';
import { aiEnabled, assertRendererEditionMatches } from './edition';
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
import { vaultEncryptionAvailable } from './vaultCrypto';

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
 * The C++ engine process (electron/engineHost.ts), created in whenReady: the
 * only engine (docs/TS_ENGINE_REMOVAL.md). When it cannot run, main shows a
 * fatal startup dialog, or blocks the editor after a crash loop and offers a
 * recovery save (electron/engineUnavailable.ts).
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

  // F2: the engine opens the file itself (a portable `.motion` zip included),
  // so the page needs only the path — never the bytes, which may be gigabytes.
  handle('project:chooseOpenPath', async () => {
    const res = await dialog.showOpenDialog({ ...rememberedDir('project'), properties: ['openFile'], filters: PROJECT_FILTERS });
    const filePath = res.filePaths[0];
    if (res.canceled || !filePath) return null;
    rememberDir('project', filePath, false);
    return filePath;
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

  // Session `blob:` / `data:` footage the C++ engine cannot open. The page
  // writes those bytes here, then relinkItem points the item at the file.
  handle('file:sessionFootageDir', async () => {
    const dir = path.join(app.getPath('userData'), 'session-footage');
    await mkdir(dir, { recursive: true });
    return dir;
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

/** Create `dir` when missing (best effort — the engine skips a folder that is not there) and return it. */
/** Where native SDK plugins are installed (by copying) and loaded from. */
function nativePluginDirPath(): string {
  return path.join(app.getPath('userData'), 'native-plugins');
}

function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Read-only profile: plugins simply do not load from here.
  }
  return dir;
}

/** ffprobe, proxy transcodes and the output-folder / encoder pickers (the page render IPC is gone: the engine exports). */
function registerRenderIpc(): void {
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
  });

  /**
   * Which hardware encoders work on THIS machine — probed once per session,
   * for the Settings picker (the engine export resolves the same way).
   */
  handle('render:probeEncoders', async () => ({ hardware: await encoderProbe.availableHw() }));

  /** Directory picker for the render queue's output folder. */
  handle('render:chooseOutputDir', async () => {
    const res = await dialog.showOpenDialog({ ...rememberedDir('outputFolder'), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled) return null;
    rememberDir('outputFolder', res.filePaths[0], true);
    return res.filePaths[0] ?? null;
  });
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

/** Open pop-out windows (F2: each is a mirror the engine's events are relayed to). */
const popoutWindows = new Set<BrowserWindow>();

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

    // F2: the engine relays its events to every pop-out (a second mirror).
    // C: a pop-out's viewport is its own engine surface — its receivers reset
    // with its page, and closing it drops its frames and viewports.
    popoutWindows.add(popoutWin);
    const popoutKey = popoutWin.webContents.id;
    popoutWin.webContents.on('did-start-loading', () => engineHost?.pageReset(popoutKey));
    popoutWin.webContents.on('render-process-gone', () => engineHost?.pageReset(popoutKey));
    popoutWin.on('closed', () => {
      popoutWindows.delete(popoutWin);
      engineHost?.windowClosed(popoutKey);
    });

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
  // The vaults' async encryptor initialises lazily; start it now so the sync
  // `persisted` flag (auth status) has an answer before the first sign-in check.
  void vaultEncryptionAvailable();

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
  // The Plugins page / panel's "Open plugins folder" — the same folder the
  // engine loads native SDK plugins from (nativePluginDir below).
  registerNativePluginIpc({ dir: nativePluginDirPath });
  registerRenderIpc();
  // Desktop export as a main-owned queue, each job in its own
  // `premation-engine --export` process (electron/exportProcess.ts). The queue
  // file is read now, so jobs left from a previous session are listed the
  // moment the editor asks; they start once the editor window is up, so a
  // queued render never begins on a machine whose editor has not even painted.
  exportSupervisor = createExportSupervisor();
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
  // The account session, and every authenticated call that uses it.
  //
  // Both tokens live in this process. There is no `credentials:get` any more:
  // the renderer asks for a REQUEST to be made and never for the credential
  // that makes it possible, so a compromised renderer can spend the session but
  // cannot take it somewhere else. See apiSession.ts for the full argument, and
  // apiBase.ts for why this is `api.request(path)` and not `fetch(url)`.
  registerApiProxyIpc();

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

  // The C++ engine process: the only engine, and it owns the document. The
  // channels exist before the window does (the page asks for the status at boot).
  const recoveryPath = path.join(ensureDir(path.join(app.getPath('userData'), 'recovery')), 'engine-recovery.json');
  engineHost = new EngineHost({
    isDev,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // Development runs `electron dist-electron/main.js`: the repo root is one up.
    appPath: app.isPackaged ? app.getAppPath() : path.join(__dirname, '..'),
    hostPid: process.pid,
    appVersion: app.getVersion(),
    getGPUInfo: (level) => app.getGPUInfo(level),
    getWindow: () => mainWindow,
    // F2: pop-outs are second mirrors of the engine — its events reach them too.
    getWindows: () => [mainWindow, ...popoutWindows].filter((w): w is BrowserWindow => w !== null && !w.isDestroyed()),
    sharedTexture: sharedTexture as unknown as SharedTextureApi,
    // G1: native SDK plugins load in the engine process from this folder.
    nativePluginDir: ensureDir(nativePluginDirPath()),
    nativePluginJournal: path.join(app.getPath('userData'), 'native-plugin-journal.bin'),
    // F2 / D5: where the engine-owned document's autosave writes its recovery copy.
    recoveryPath,
    // Imported bytes and session blob: footage become files here (the same
    // folder file:sessionFootageDir hands the page).
    sessionFootageDir: ensureDir(path.join(app.getPath('userData'), 'session-footage')),
    // The transcribe job's key: main's keystore → the startJob, per job (never logged, never to a page).
    transcribeCredential: async (provider) =>
      (VAULT_PROVIDERS as readonly string[]).includes(provider) ? getKeyForProvider(provider as VaultProvider) : null,
    // No engine, no editor: a fatal startup dialog, or a blocking crash-loop
    // dialog with a recovery save (engineUnavailable.ts).
    onUnavailable: (info) => {
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      void handleEngineUnavailable(info, {
        showErrorBox: (title, content) => dialog.showErrorBox(title, content),
        showMessageBox: (o) => (parent ? dialog.showMessageBox(parent, o) : dialog.showMessageBox(o)),
        showSaveDialog: (o) => (parent ? dialog.showSaveDialog(parent, o) : dialog.showSaveDialog(o)),
        recoveryPath,
        exists: (p) => existsSync(p),
        copyFile: (from, to) => copyFile(from, to),
        retry: () => engineHost?.retry() ?? Promise.resolve(),
        quit: () => app.quit(),
        defaultDir: app.getPath('documents'),
        joinPath: (...parts) => path.join(...parts),
      });
    },
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
  void engineHost.start();
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU') engineHost?.gpuProcessGone(details.reason);
  });

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
  // The engine gets a Goodbye and exits on its own; the supervisor kills it
  // after 2 s if it does not (a closing stdin ends it either way).
  void engineHost?.stop();
});
