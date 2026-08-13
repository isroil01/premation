/**
 * The Electron main process for the IPC frame-guard test.
 *
 * NOT the app's main process, and deliberately configured WORSE than it.
 *
 * `ipcGuard`'s whole argument is that the frame check — not the absence of a
 * preload in subframes — is what stops a plugin panel reaching IPC. The app
 * ships `nodeIntegrationInSubFrames` off, so in production a subframe has no
 * `ipcRenderer` to call with, and any test against the real app would pass with
 * the guard deleted. That is the test that proves nothing.
 *
 * So this harness turns `nodeIntegrationInSubFrames` ON and hands every frame,
 * including a sandboxed one, a working invoke bridge. It is the configuration
 * the guard's own comment names as the risk: "a preload change, or an Electron
 * default moving, would each turn a configuration detail into the whole IPC
 * surface, silently." Here that change is already made, and the guard has to
 * hold on its own.
 *
 * It registers through the REAL compiled `ipcGuard`, so the thing under test is
 * the shipped module rather than a copy of its logic.
 */

const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');

// The compiled shipping module. `npm run electron:compile` must have run —
// `e2e/run.mjs` does that before invoking Playwright.
const ipcGuard = require(join(__dirname, '..', '..', 'dist-electron', 'ipcGuard.js'));

// One channel, registered exactly the way every real handler is. A handler that
// bypassed `ipcGuard.handle` would not be testing anything.
ipcGuard.handle('harness:ping', (event) => ({
  ok: true,
  url: event.senderFrame?.url ?? null,
}));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // ★ The point of the harness. Off in production; on here so subframes
      //   actually get the preload and can attempt an invoke.
      nodeIntegrationInSubFrames: true,
      preload: join(__dirname, 'preload.cjs'),
      // file:// subframes are opaque to each other without this, and the
      // same-origin subframe case is the one that catches a URL comparison
      // masquerading as an identity check.
      webSecurity: false,
    },
  });

  await win.loadFile(join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
