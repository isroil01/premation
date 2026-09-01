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
// The FULL sandbox off, not just the GPU process's.
//
// `--disable-gpu-sandbox` above covers the GPU process only. The zygote still
// uses Chromium's SUID sandbox helper, and on any Linux box where
// `node_modules/electron/dist/chrome-sandbox` is not root-owned mode 4755 that
// helper refuses to run *and aborts the process*:
//
//   FATAL:setuid_sandbox_host.cc(163) The SUID sandbox helper binary was found,
//   but is not configured correctly. Rather than run without sandboxing I'm
//   aborting now.
//
// A GitHub Actions runner installs node_modules as a non-root user, so it can
// never satisfy that without `sudo chown root` — which is why CI died at
// "render harness exited 1 on [webgl2] — no pixels produced" while local runs
// were fine.
//
// Turned off UNCONDITIONALLY rather than only under CI, deliberately. This is a
// golden-frame harness: its whole contract is that the same scenes produce the
// same bytes, and switch sets that differ between a developer's machine and CI
// are exactly how that contract rots. The sandbox buys nothing here either — the
// harness loads one local, repo-controlled HTML file, has no network access and
// never navigates. Keeping the flags identical everywhere is worth more than a
// sandbox around content we authored.
app.commandLine.appendSwitch('no-sandbox');
if (WANT_WEBGPU) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  // On Linux, Dawn discovers NO backend at all without this — Chromium says so
  // itself in the renderer log: "WebGPU on Linux requires GLES compat, or
  // command-line flag --enable-features=Vulkan, or command-line flag
  // --enable-features=SkiaGraphite". Every CI run before this flag existed
  // therefore failed all webgpu scenes with "asked for webgpu, got webgl2":
  // the adapter was never absent because the runner lacked a GPU, it was
  // absent because Vulkan was never enabled. With it, Dawn enumerates whatever
  // Vulkan ICDs are installed — a hardware driver on a real box, lavapipe
  // (mesa-vulkan-drivers) on a hosted runner.
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'Vulkan');
  }
  // NOTE: the WebGPU run uses the machine's REAL adapter, and is therefore only
  // deterministic in the "same machine + same driver" sense — not the stronger
  // "any machine" sense the ANGLE-SwiftShader WebGL2 run gives.
  //
  // Dawn's software rasterizer was the obvious alternative and it does not work
  // here. `--use-vulkan=swiftshader --use-webgpu-adapter=swiftshader` yields an
  // adapter (google/swiftshader) and a device, then kills the render process on
  // the first submit: "A valid external Instance reference no longer exists" /
  // "Instance dropped in onSubmittedWorkDone", under OSR and windowed alike, on
  // Electron 32.3.3 (probed on Windows; the Linux path behind
  // --enable-features=Vulkan is a different stack and is probed from CI via
  // HARNESS_CHROMIUM_SWITCHES below). Until a software adapter demonstrably
  // works there is no software WebGPU to bless against, which is why references
  // are still blessed from WebGL2 — see GATE_BACKEND in scripts/run.mjs.
} else {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}

// Extra Chromium switches for GPU-stack experiments, ';'-separated (';' rather
// than ',' because switch VALUES contain commas: `enable-features=A,B`).
// Example: HARNESS_CHROMIUM_SWITCHES='use-vulkan=swiftshader;use-webgpu-adapter=swiftshader'
// This exists so CI can probe adapter configurations without a code change per
// attempt; the flags a run settles on belong above, not in the workflow.
for (const sw of (process.env.HARNESS_CHROMIUM_SWITCHES || '').split(';')) {
  const s = sw.trim();
  if (!s) continue;
  const eq = s.indexOf('=');
  if (eq === -1) app.commandLine.appendSwitch(s);
  else app.commandLine.appendSwitch(s.slice(0, eq), s.slice(eq + 1));
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

/**
 * Optional comma list of scene ids to RENDER. Empty means all.
 *
 * `run.mjs --scene` filters the COMPARISON only; the renderer still draws every
 * scene, which is minutes of wall clock to look at one of them. This is the
 * debugging path, off by default — the gate never sets it, so a partial run can
 * never be mistaken for a full one.
 */
const ONLY = (process.env.HARNESS_SCENES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

ipcMain.on('harness:config', (e) => {
  e.returnValue = { backends: BACKENDS, only: ONLY };
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
  //
  // `level >= 2` keeps ordinary renderer chatter out of the run log. The
  // harness's own announcements are not chatter: the resolved-backend line is a
  // CLAIM ABOUT THE RESULTS and has to travel with them, so it is forwarded
  // regardless of level. It goes to stdout (informational) rather than stderr
  // (the failure channel).
  win.webContents.on('console-message', (_e, level, message) => {
    if (typeof message === 'string' && message.startsWith('[harness]')) {
      process.stdout.write(`${message}\n`);
    } else if (level >= 2) {
      process.stderr.write(`[renderer] ${message}\n`);
    }
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
