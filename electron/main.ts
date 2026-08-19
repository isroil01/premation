import { app, BrowserWindow, shell, dialog, Menu, protocol, net, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { handle, on } from './ipcGuard';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, unlink, readdir, access, rm, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { shouldStartBackend, startBackend, stopBackend } from './backend';
import { registerIndexIpc } from './localIndexDb';
import { registerThumbIpc } from './thumbCache';
import { registerAiKeyIpc } from './aiKeyVault';
import { registerAiProxyIpc, abortAllStreams } from './aiProxy';
import { registerApiProxyIpc, abortAllApiStreams } from './apiProxy';
import { installPluginPublishIpc } from './pluginPublish';
import { registerPluginNetIpc } from './pluginNet';
import { aiEnabled, pluginsEnabled, assertRendererEditionMatches } from './edition';
import { parseProbeJson, type ProbeJson } from './mediaProbeParse';
import { checkForUpdatesInteractive, initAutoUpdate } from './updater';

const isDev = process.env.NODE_ENV === 'development';

/** The main window, tracked so the OAuth deep-link handler can reach it. */
let mainWindow: BrowserWindow | null = null;

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

// Only one instance may run: on Windows a premation:// link launches a SECOND
// copy whose argv carries the URL, and `second-instance` relays it to the
// original (which holds the lock). Without the lock the link would spawn a
// duplicate app instead of returning to the signed-in one.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
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
// have WebGPU on by default in Electron 32 / Chromium 128, and enabling Vulkan
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
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: PROJECT_FILTERS });
    const filePath = res.filePaths[0];
    if (res.canceled || !filePath) return null;
    try {
      const contents = await readFile(filePath, 'utf8');
      return { path: filePath, name: path.basename(filePath), contents };
    } catch {
      return null;
    }
  });

  handle('project:chooseSavePath', async (_event, defaultName: string) => {
    const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters: PROJECT_FILTERS });
    return res.canceled ? null : res.filePath ?? null;
  });

  handle('file:read', async (_event, filePath: string) => {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  });

  handle('file:write', async (_event, filePath: string, contents: string) => {
    await writeFile(filePath, contents, 'utf8');
  });

  handle('file:writeBytes', async (_event, filePath: string, bytes: Uint8Array) => {
    await writeFile(filePath, Buffer.from(bytes));
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
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, contents, 'utf8');
    await rename(tmp, target); // atomic on the same filesystem
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
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0] ?? null;
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
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, Buffer.from(bytes));
    await rename(tmp, target);
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
 * Frames are staged to a per-job temp dir; `render:encode` muxes on demand and
 * `render:cleanJob` removes the dir.
 */
function registerRenderIpc(): void {
  const jobs = new Map<string, string>();
  /** Running ffmpeg children per job, so `render:cancel` can kill them. */
  const running = new Map<string, ReturnType<typeof spawn>>();

  const resolveFfmpeg = (): string => {
    if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const bundled = path.join(process.resourcesPath ?? '', 'ffmpeg', name);
    if (existsSync(bundled)) return bundled;
    return 'ffmpeg'; // fall back to PATH
  };

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
    const files = await readdir(dir);
    const png = files.filter((f) => /^frame_\d+\.png$/i.test(f)).length;
    const jpg = files.filter((f) => /^frame_\d+\.jpg$/i.test(f)).length;
    return png > jpg ? { count: png, ext: 'png' } : { count: jpg, ext: 'jpg' };
  };

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

  handle('render:beginJob', async () => {
    const jobId = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const dir = path.join(app.getPath('temp'), `motion-render-${jobId}`);
    await mkdir(dir, { recursive: true });
    jobs.set(jobId, dir);
    return jobId;
  });

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
      opts: { format: 'mp4' | 'webm' | 'gif' | 'mov'; fps: number; hasAudio?: boolean; quality?: 'high' | 'medium' | 'draft' },
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

      const base = ['-y', '-framerate', String(opts.fps), '-i', input, ...(hasAudio ? ['-i', audio!] : [])];
      let args: string[];

      switch (opts.format) {
        case 'webm':
          args = [
            ...base,
            '-c:v', 'libvpx-vp9',
            '-crf', crf, '-b:v', '0',
            // VP9 encodes far faster with row-based threading, and an export is
            // the one place where using every core is exactly what the user wants.
            '-row-mt', '1', '-threads', '0',
            // VP9 is the only mainstream video codec with an alpha channel, so a
            // transparent comp (staged as PNG) keeps its transparency here.
            // alt-ref frames must be off for alpha, or the channel is discarded.
            ...(staged.ext === 'png' ? ['-pix_fmt', 'yuva420p', '-auto-alt-ref', '0'] : ['-pix_fmt', 'yuv420p']),
            '-vf', evenScale,
            ...(hasAudio ? ['-c:a', 'libopus', '-b:a', '160k', '-shortest'] : []),
            out,
          ];
          break;
        case 'gif':
          // Two passes in one graph: palettegen builds an optimal 256-colour
          // palette for the whole animation, paletteuse dithers against it. A
          // single-pass GIF quantises per frame and visibly bands and flickers.
          args = [
            '-y', '-framerate', String(opts.fps), '-i', input,
            '-filter_complex',
            `[0:v] ${evenScale},split [a][b];[a] palettegen=stats_mode=diff [p];[b][p] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
            '-loop', '0',
            out,
          ];
          break;
        case 'mov':
          // ProRes 4444 keeps the alpha channel, which is the reason to pick a
          //.mov over mp4 at all (transparent comps for compositing elsewhere).
          args = [
            ...base,
            '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
            '-vf', evenScale,
            ...(hasAudio ? ['-c:a', 'pcm_s16le', '-shortest'] : []),
            out,
          ];
          break;
        case 'mp4':
        default:
          args = [
            ...base,
            '-c:v', 'libx264',
            '-preset', opts.quality === 'draft' ? 'veryfast' : 'medium',
            '-crf', crf,
            // H.264 carries no alpha. A transparent comp stages as RGBA PNG and
            // this conversion flattens it over BLACK — ffmpeg's own behaviour,
            // relied on deliberately rather than stumbled into, and now stated
            // in the composition settings dialog so nobody first discovers it
            // in a delivered file. mov (ProRes 4444) and webm (VP9) keep alpha.
            '-pix_fmt', 'yuv420p',
            // Streaming-friendly: without faststart the moov atom lands at the
            // end and browsers refuse to play the file until it fully downloads.
            '-movflags', '+faststart',
            '-vf', evenScale,
            ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
            out,
          ];
      }

      await runFfmpeg(jobId, args);
      return { path: out, frames };
    },
  );

  /** Kill a running encode (the queue's Pause / the dialog's Cancel). */
  handle('render:cancel', async (_e, jobId: string) => {
    running.get(jobId)?.kill();
    running.delete(jobId);
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
   */
  handle('render:saveTo', async (_e, jobId: string, dir: string, filename: string) => {
    const ext = path.extname(filename).replace('.', '') || 'mp4';
    const stem = path.basename(filename, `.${ext}`);
    let target = path.join(dir, filename);
    for (let n = 2; existsSync(target); n++) target = path.join(dir, `${stem} (${n}).${ext}`);
    await moveOutput(jobId, ext, target);
    return { path: target };
  });

  /** Directory picker for the render queue's output folder. */
  handle('render:chooseOutputDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  handle('render:cleanJob', async (_e, jobId: string) => {
    const dir = jobs.get(jobId);
    if (!dir) return;
    running.get(jobId)?.kill();
    running.delete(jobId);
    jobs.delete(jobId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });
}

/**
 * Native application menu. Items forward a command id to the renderer, which
 * executes it through the same CommandSystem the in-app UI uses — so the menu
 * never duplicates behaviour, it just triggers commands.
 */
function buildApplicationMenu(win: BrowserWindow): void {
  const cmd = (id: string) => () => win.webContents.send('menu:command', id);

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: cmd('project.new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: cmd('project.open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('project.save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('project.saveAs') },
        { label: 'Save to Computer…', click: cmd('project.saveToComputer') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('edit.undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: cmd('edit.redo') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: cmd('edit.selectAll') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Scene Panel', click: cmd('view.toggleLeftSidebar') },
        { label: 'Toggle Inspector', click: cmd('view.toggleRightInspector') },
        { label: 'Toggle Timeline', click: cmd('view.toggleTimeline') },
        { type: 'separator' },
        { label: 'Reset Layout', click: cmd('layout.reset') },
        { label: 'Switch Theme', click: cmd('theme.switch') },
        // Reload + DevTools are developer affordances only — omitted from shipped
        // builds so end users get no inspector and no accidental hard reload.
        ...(isDev
          ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      // The native menubar is normally hidden (`autoHideMenuBar`), so the
      // in-app menu is the real one — that is where a plugin's own commands and
      // panel appear, assembled from what is installed. This entry exists so
      // the two menus do not disagree about whether the app HAS plugins for a
      // user who reaches for Alt.
      label: 'Plugins',
      submenu: [
        { label: 'Manage Plugins…', click: cmd('view.plugins') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        // Not a command forwarded to the renderer: updating is the shell's job,
        // and the renderer is what gets replaced.
        { label: 'Check for Updates…', click: () => checkForUpdatesInteractive(win) },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

function createMainWindow(): BrowserWindow {
  const appIcon = resolveAppIcon();
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
    frame: false,
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

  if (isDev) {
    void win.loadURL('http://localhost:5173');
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
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
      ? `http://localhost:5173/#/popout/${panelId}`
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

app.whenReady().then(() => {
  // A second instance already relayed its deep link and quit; this one should not
  // have reached whenReady, but guard anyway rather than open a duplicate window.
  if (!hasSingleInstanceLock) return;

  // Kick the GPU process awake NOW, during boot, so it is ready before the first
  // viewport mounts. Without this the renderer can win the race to first-init and
  // fail every rung (WebGPU + WebGL2) against a GPU that is milliseconds from
  // ready — the packaged-build "GPU unavailable on first entry" symptom. Fire and
  // forget; the renderer has its own cold-start retry as the real safety net.
  void app.getGPUInfo('complete').catch(() => { /* GPU info is best-effort */ });

  // Claim the premation:// scheme so the OAuth callback can hand the code back.
  registerProtocolClient();

  // Protocol handler to resolve local files under the local-file:// scheme
  protocol.handle('local-file', (request) => {
    let filePath = request.url.replace(/^local-file:\/\//, '');
    filePath = decodeURIComponent(filePath);
    // On Windows, local-file://C:/... sometimes retains a slash or format that needs normalize/file URL format
    if (process.platform === 'win32') {
      filePath = filePath.replace(/^\/([A-Za-z]:)/, '$1');
    }
    return net.fetch('file://' + filePath);
  });

  registerFileIpc();
  registerBundleIpc();
  registerBlobIpc();
  registerIndexIpc(app);
  registerThumbIpc(app);
  registerRenderIpc();
  registerPopoutIpc();
  registerOAuthIpc();
  // A plugin's outbound requests. Here rather than in the renderer because the
  // app shell's `connect-src` does not name a plugin's hosts, and widening it
  // to cover them would widen the whole renderer rather than the plugin.
  //
  // GATED, for exactly the reason the assistant below is. The local edition
  // ships no plugins, and "the renderer never calls it" is not a gate on the
  // privileged side of this boundary. It is also the second of the two channels
  // in this process that reach a third-party host — the other is aiProxy — so
  // leaving it registered would hold an outbound path open in a build whose
  // whole claim is that it has none.
  if (pluginsEnabled()) registerPluginNetIpc();
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
  if (pluginsEnabled()) installPluginPublishIpc();

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
  }

  // The renderer reports its own edition on first paint so a build whose two
  // halves disagree says so. Not authoritative — see preload's `reportEdition`.
  handle('edition:report', (_event, reported: unknown) => {
    const result = assertRendererEditionMatches(reported);
    if (!result.ok) console.error(result.message);
    return result;
  });

  // A normal build is a CLIENT: it talks to a deployed motion-back at the origin
  // baked in by VITE_BACKEND_ORIGIN, or to one you run yourself on localhost:4000
  // (see src/core/api/env.ts). It starts no server of its own.
  //
  // The app manages a server only when one was bundled into the build
  // (electron-builder.selfhosted.yml) or when MOTION_LOCAL_BACKEND=1 asks for it.
  // Either way it reuses a server already listening rather than duplicating it.
  if (shouldStartBackend()) void startBackend();

  const win = createMainWindow();

  // Report GPU status AFTER the renderer has loaded and touched the GPU. Reading
  // in whenReady catches Chromium's GPU process before it initializes (every
  // adapter inactive, initializationTime:0) — a premature, misleading snapshot.
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => void logGpuDiagnostics(), 6000);
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
});
