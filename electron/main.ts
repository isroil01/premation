import { app, BrowserWindow, shell, ipcMain, dialog, Menu, protocol, net, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, unlink, readdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { startBackend, stopBackend } from './backend';
import { registerIndexIpc } from './localIndexDb';

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
// Don't force Vulkan here — it conflicts with ANGLE on some drivers.
app.commandLine.appendSwitch('use-angle', 'default');

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
 * Offline mp4 export (RFC §12 / principle 7). The renderer rasterizes frames
 * locally (deterministic — offlineRenderer) and streams them here; the main
 * process muxes with a bundled/resolved ffmpeg so mp4 export needs no network.
 * Frames are staged to a per-job temp dir, then muxed on demand.
 */
function registerRenderIpc(): void {
  const jobs = new Map<string, string>();

  const resolveFfmpeg = (): string => {
    if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const bundled = path.join(process.resourcesPath ?? '', 'ffmpeg', name);
    if (existsSync(bundled)) return bundled;
    return 'ffmpeg'; // fall back to PATH
  };

  const runFfmpeg = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const proc = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (d) => (stderr += String(d)));
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))));
    });

  ipcMain.handle('render:beginJob', async () => {
    const jobId = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const dir = path.join(app.getPath('temp'), `motion-mux-${jobId}`);
    await mkdir(dir, { recursive: true });
    jobs.set(jobId, dir);
    return jobId;
  });

  ipcMain.handle('render:stageFrame', async (_e, jobId: string, index: number, bytes: Uint8Array) => {
    const dir = jobs.get(jobId);
    if (!dir) throw new Error('unknown render job');
    await writeFile(path.join(dir, `frame_${String(index).padStart(6, '0')}.png`), Buffer.from(bytes));
  });

  ipcMain.handle('render:stageAudio', async (_e, jobId: string, bytes: Uint8Array) => {
    const dir = jobs.get(jobId);
    if (!dir) throw new Error('unknown render job');
    await writeFile(path.join(dir, 'audio.wav'), Buffer.from(bytes));
  });

  ipcMain.handle('render:muxMp4', async (_e, jobId: string, opts: { fps: number; hasAudio?: boolean }) => {
    const dir = jobs.get(jobId);
    if (!dir) throw new Error('unknown render job');
    const out = path.join(dir, 'out.mp4');
    const audio = opts.hasAudio ? path.join(dir, 'audio.wav') : null;
    const args = [
      '-y',
      '-framerate', String(opts.fps),
      '-i', path.join(dir, 'frame_%06d.png'),
      ...(audio ? ['-i', audio] : []),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // even dims required by yuv420p
      ...(audio ? ['-c:a', 'aac', '-shortest'] : []),
      out,
    ];
    await runFfmpeg(args);
    return { path: out };
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
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    title: 'Motion Editor',
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

  // External links open in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
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
