import { app, BrowserWindow, shell, ipcMain, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const isDev = process.env.NODE_ENV === 'development';

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
    autoHideMenuBar: true, // native menu available via Alt / macOS bar; app has its own bar too
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
  registerFileIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
