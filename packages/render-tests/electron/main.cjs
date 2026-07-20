/**
 * Electron main for the golden-frame render harness (Phase 0).
 *
 * Boots a hidden, OFFSCREEN BrowserWindow that renders every scene on the
 * requested backends and reads back real pixels. Software GL (SwiftShader) is
 * forced so output is deterministic and CI-safe — "same machine + same driver
 * ⇒ same bytes", with the driver pinned to SwiftShader rather than whatever GPU
 * the box happens to have.
 *
 * This process is a pure pixel factory: it writes actual PNGs to HARNESS_OUT and
 * a manifest to HARNESS_MANIFEST_OUT, then exits. All comparison/blessing is
 * done by the Node runner (scripts/run.mjs).
 *
 * Config via env:
 *   HARNESS_OUT           dir to write <backend>/<sceneId>/<frame>.png
 *   HARNESS_MANIFEST_OUT  file to write the scene manifest JSON
 *   HARNESS_BACKENDS      comma list, e.g. "canvas2d,webgl2"
 *   HARNESS_HTML          path to the built harness index.html
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ── Deterministic software GL, headless-safe ──────────────────────────
// WebGPU spot-check runs (HARNESS_BACKENDS=…,webgpu) need an adapter, which
// disableHardwareAcceleration() would block — those runs keep HW acceleration
// on and are NOT byte-deterministic (they verify orientation/feature parity,
// not the golden gate; the gate always compares the webgl2/SwiftShader run).
const WANT_WEBGPU = (process.env.HARNESS_BACKENDS || '').includes('webgpu');
if (WANT_WEBGPU) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  // Dawn's software rasterizer — lets an adapter exist without a real GPU.
  app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader');
  app.commandLine.appendSwitch('enable-features', 'Vulkan,WebGPUService');
} else {
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const OUT = process.env.HARNESS_OUT;
const MANIFEST_OUT = process.env.HARNESS_MANIFEST_OUT;
const BACKENDS = (process.env.HARNESS_BACKENDS || 'canvas2d,webgl2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const HTML = process.env.HARNESS_HTML;

let exitCode = 0;
function fail(msg) {
  process.stderr.write(`[harness] ${msg}\n`);
  exitCode = 1;
}

ipcMain.on('harness:config', (e) => {
  e.returnValue = { backends: BACKENDS };
});

ipcMain.handle('harness:manifest', (_e, scenes) => {
  if (MANIFEST_OUT) {
    fs.mkdirSync(path.dirname(MANIFEST_OUT), { recursive: true });
    fs.writeFileSync(MANIFEST_OUT, JSON.stringify(scenes, null, 2));
  }
});

ipcMain.handle('harness:frame', (_e, p) => {
  const dir = path.join(OUT, p.backend, p.sceneId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${p.frame}.png`), Buffer.from(p.pngBase64, 'base64'));
});

ipcMain.handle('harness:done', (_e, error) => {
  if (error) fail(`renderer error: ${error}`);
  // Give the last IPC write a tick, then quit.
  setTimeout(() => app.quit(), 20);
});

app.whenReady().then(() => {
  if (!OUT || !HTML) {
    fail('HARNESS_OUT and HARNESS_HTML env vars are required');
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Surface renderer console + crashes to our stdout for debugging.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) process.stderr.write(`[renderer] ${message}\n`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    fail(`render process gone: ${details.reason}`);
    app.quit();
  });

  // Watchdog: never hang CI.
  const watchdog = setTimeout(() => {
    fail('timed out waiting for renderer to finish');
    app.quit();
  }, Number(process.env.HARNESS_TIMEOUT_MS || 120000));
  app.on('will-quit', () => clearTimeout(watchdog));

  win.loadFile(HTML).catch((err) => {
    fail(`failed to load harness html: ${err}`);
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => process.exit(exitCode));
