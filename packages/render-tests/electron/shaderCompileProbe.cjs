/**
 * Do these composed shaders actually compile on a real adapter?
 *
 * Narrower than the other probes on purpose: it asks nothing about what a
 * shader DRAWS, only whether the driver accepts it. That is the question worth
 * asking before handing someone a package to test — a plugin whose WGSL fails
 * to compile wastes their time on a different bug than the one they were asked
 * to look at, and the failure surfaces as "the effect does nothing", which is
 * indistinguishable from the wiring being broken.
 *
 * Reads composed WGSL from JSON, creates a shader module per entry, and reports
 * every compilation message the driver produced.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

const SHADERS = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const PAGE = `
async function run(spec) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();

  const results = [];
  for (const s of spec) {
    const module = device.createShaderModule({ code: s.wgsl, label: s.name });
    // getCompilationInfo is the only way to see a WARNING; an error also shows
    // up as an uncaptured device error, but by then the name is gone.
    const info = await module.getCompilationInfo();
    const msgs = info.messages.map((m) => ({
      type: m.type, line: m.lineNum, text: m.message.trim(),
    }));
    results.push({ name: s.name, messages: msgs });
  }
  return results;
}
`;

const PAGE_PATH = path.join(os.tmpdir(), 'motion-shader-compile-probe.html');

app.whenReady().then(async () => {
  fs.writeFileSync(PAGE_PATH, '<!doctype html><title>shader compile probe</title>');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  await win.loadFile(PAGE_PATH);
  try {
    const result = await win.webContents.executeJavaScript(
      `${PAGE}\nrun(${JSON.stringify(SHADERS)})`,
    );
    if (result) console.log(`RESULT:${JSON.stringify(result)}`);
    else console.log('SKIP:navigator.gpu absent, or requestAdapter returned null');
  } catch (err) {
    console.log(`ERROR:${String((err && err.message) || err)}`);
  }
  app.quit();
});

app.on('window-all-closed', () => app.quit());
