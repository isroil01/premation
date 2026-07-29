import { app, BrowserWindow, shell, ipcMain, dialog, Menu, protocol, net, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, unlink, readdir, access, rm, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { startBackend, stopBackend } from './backend';
import { registerIndexIpc } from './localIndexDb';
import { registerCredentialIpc } from './credentialStore';

const isDev = process.env.NODE_ENV === 'development';

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
  ipcMain.handle('project:open', async () => {
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

  ipcMain.handle('project:chooseSavePath', async (_event, defaultName: string) => {
    const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters: PROJECT_FILTERS });
    return res.canceled ? null : res.filePath ?? null;
  });

  ipcMain.handle('file:read', async (_event, filePath: string) => {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('file:write', async (_event, filePath: string, contents: string) => {
    await writeFile(filePath, contents, 'utf8');
  });

  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  ipcMain.handle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:quit', () => app.quit());
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

  ipcMain.handle('bundle:read', async (_event, root: string, name: string) => {
    const target = contained(root, name);
    if (!target) return null;
    try {
      return await readFile(target, 'utf8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('bundle:writeAtomic', async (_event, root: string, name: string, contents: string) => {
    const target = contained(root, name);
    if (!target) throw new Error('bundle:writeAtomic path escapes bundle root');
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, contents, 'utf8');
    await rename(tmp, target); // atomic on the same filesystem
  });

  ipcMain.handle('bundle:remove', async (_event, root: string, name: string) => {
    const target = contained(root, name);
    if (!target) return;
    try {
      await unlink(target);
    } catch {
      /* already gone */
    }
  });

  ipcMain.handle('bundle:list', async (_event, root: string) => {
    try {
      const entries = await readdir(path.resolve(root), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  });

  // Native directory dialog for opening a `.motion` bundle (a directory).
  ipcMain.handle('project:openBundleDir', async () => {
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

  ipcMain.handle('blob:has', async (_event, root: string, hash: string) => {
    const target = blobPath(root, hash);
    if (!target) return false;
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('blob:read', async (_event, root: string, hash: string) => {
    const target = blobPath(root, hash);
    if (!target) return null;
    try {
      return await readFile(target); // Buffer → Uint8Array on the renderer side
    } catch {
      return null;
    }
  });

  ipcMain.handle('blob:write', async (_event, root: string, hash: string, bytes: Uint8Array) => {
    const target = blobPath(root, hash);
    if (!target) throw new Error('blob:write invalid hash');
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, Buffer.from(bytes));
    await rename(tmp, target);
  });

  ipcMain.handle('blob:remove', async (_event, root: string, hash: string) => {
    const target = blobPath(root, hash);
    if (!target) return;
    try {
      await unlink(target);
    } catch {
      /* already gone */
    }
  });

  ipcMain.handle('blob:list', async (_event, root: string) => {
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

  ipcMain.handle('render:beginJob', async () => {
    const jobId = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const dir = path.join(app.getPath('temp'), `motion-render-${jobId}`);
    await mkdir(dir, { recursive: true });
    jobs.set(jobId, dir);
    return jobId;
  });

  ipcMain.handle(
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

  ipcMain.handle('render:stageAudio', async (_e, jobId: string, bytes: Uint8Array) => {
    const dir = jobs.get(jobId);
    if (!dir) throw new Error('unknown render job');
    await writeFile(path.join(dir, 'audio.wav'), Buffer.from(bytes));
  });

  /**
   * Encode the staged frames into one file. `format` picks the codec/container;
   * everything else is derived so the renderer never has to know ffmpeg flags.
   */
  ipcMain.handle(
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
  ipcMain.handle('render:cancel', async (_e, jobId: string) => {
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

  ipcMain.handle('render:save', async (_e, jobId: string, defaultName: string) => {
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
  ipcMain.handle('render:saveTo', async (_e, jobId: string, dir: string, filename: string) => {
    const ext = path.extname(filename).replace('.', '') || 'mp4';
    const stem = path.basename(filename, `.${ext}`);
    let target = path.join(dir, filename);
    for (let n = 2; existsSync(target); n++) target = path.join(dir, `${stem} (${n}).${ext}`);
    await moveOutput(jobId, ext, target);
    return { path: target };
  });

  /** Directory picker for the render queue's output folder. */
  ipcMain.handle('render:chooseOutputDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle('render:cleanJob', async (_e, jobId: string) => {
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
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: cmd('project.open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('project.save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('project.saveAs') },
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
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
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
    title: 'Motion Editor',
    ...(appIcon ? { icon: appIcon } : {}),
    backgroundColor: '#0a0a0b',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: false is required for WebGPU adapter creation in Electron.
      // Security is maintained by contextIsolation + nodeIntegration: false.
      sandbox: false,
      webgl: true,
    },
  });

  win.once('ready-to-show', () => win.show());

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
            sandbox: false,
            webgl: true,
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

  return win;
}

function registerPopoutIpc(): void {
  ipcMain.handle('popout:spawnWindow', (event, panelId: string) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    const popoutWin = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 400,
      minHeight: 300,
      title: `${panelId} — Motion Editor`,
      backgroundColor: '#0a0a0b',
      autoHideMenuBar: true,
      frame: false,
      parent: parentWin ?? undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
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

app.whenReady().then(() => {
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
  registerIndexIpc(ipcMain, app);
  registerRenderIpc();
  registerPopoutIpc();
  // The session's refresh token, encrypted with the OS keystore and held in
  // this process — never in renderer localStorage, where DevTools can read and
  // edit it. See credentialStore.ts.
  registerCredentialIpc();
  // NOTE: no AI IPC any more. AI runs through the backend gateway
  // (POST /ai/stream) with the user's keys stored server-side — this process
  // holds no AI privileges at all.

  // The app connects to the backend at localhost:4000 (the renderer's default
  // API origin — see src/core/api/env.ts). You run motion-back yourself,
  // separately, so the app does NOT start its own server by default.
  // Opt in with MOTION_LOCAL_BACKEND=1 to have the app spawn/stop the server for
  // you (it reuses one already running rather than duplicating it).
  if (process.env.MOTION_LOCAL_BACKEND === '1') void startBackend();

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

// Ensure the managed server is torn down on every exit path.
app.on('before-quit', () => stopBackend());
