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

// ── Deterministic software rendering, headless-safe, PER BACKEND ──────
//
// The two APIs need DIFFERENT software rasterizers, and the flags for one
// suppress the other — which is why every backend renders in its own process
// (see renderBackendsIsolated in scripts/run.mjs).
//
//   WebGL2 → ANGLE over SwiftShader   (--use-gl=angle --use-angle=swiftshader)
//   WebGPU → Dawn over Vulkan-SwiftShader (--use-vulkan=swiftshader)
//
// `--use-angle=swiftshader` is not neutral for WebGPU: with it set, Dawn finds
// NO adapter at all and `navigator.gpu.requestAdapter()` resolves null. That is
// not a theory — probed in this Electron (32.3.3) across four flag sets:
//
//   flags                                          adapter
//   use-angle=swiftshader + use-webgpu-adapter     none          ← what we had
//   use-angle=swiftshader (no webgpu-adapter)      none
//   nothing forced                                 nvidia/lovelace
//   use-vulkan=swiftshader + use-webgpu-adapter    google/swiftshader
//
// So the harness's WebGPU runs never had a WebGPU adapter. MotionRendererBackend
// stepped silently down to WebGL2 and the harness recorded the result under
// `webgpu/`, which is the whole reason its "WebGPU parity" figure was
// meaningless. renderEntry.ts now asserts the resolved tier, so a repeat of this
// fails loudly instead of producing mislabelled pixels.
const WANT_WEBGPU = (process.env.HARNESS_BACKENDS || '').includes('webgpu');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-sandbox');
if (WANT_WEBGPU) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  // NOTE: the WebGPU run uses the machine's REAL adapter, and is therefore only
  // deterministic in the "same machine + same driver" sense — not the stronger
  // "any machine" sense the ANGLE-SwiftShader WebGL2 run gives.
  //
  // Dawn's software rasterizer was the obvious alternative and it does not work
  // here. `--use-vulkan=swiftshader --use-webgpu-adapter=swiftshader` yields an
  // adapter (google/swiftshader) and a device, then kills the render process on
  // the first submit: "A valid external Instance reference no longer exists" /
  // "Instance dropped in onSubmittedWorkDone", under OSR and windowed alike, on
  // Electron 32.3.3. Until that is fixed upstream there is no software WebGPU
  // to bless against, which is why references are still blessed from WebGL2 —
  // see GATE_BACKEND in scripts/run.mjs.
} else {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}

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
