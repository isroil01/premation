/* global WebSocket -- Node 22 global */
/**
 * Transport in the real app (release blocker 2026-09-29): a shape layer, an
 * animation preset from the Presets panel, then Space → play ~3 s → Space →
 * pause (must stop and stay stopped) → Space → play → Space. Real clicks and
 * key presses over CDP; the engine's own playhead / transportChanged events
 * and the page transport's counters are sampled.
 *   node scripts/realapp/transportPreset.cjs
 * Runs the built dist-electron + dist (build first: `npm run electron:build:local`;
 * a development-mode dist — NODE_ENV=development vite build --mode development —
 * exercises React StrictMode like `electron:dev`). Does not start Vite.
 */
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const MAIN = path.join(REPO, 'dist-electron', 'main.js');
const ELECTRON = require(path.join(REPO, 'node_modules', 'electron'));
// The engine build: PREMATION_ENGINE_PATH, else this checkout's (a missing
// engine makes main show a blocking error dialog, so fail here instead).
const ENGINE = process.env.PREMATION_ENGINE_PATH
  || path.join(REPO, 'native', 'build', 'windows-clang-cl-engine', 'engine', 'premation-engine.exe');
if (!require('node:fs').existsSync(ENGINE)) {
  console.error(`premation-engine not found at ${ENGINE} (set PREMATION_ENGINE_PATH)`);
  process.exit(1);
}
const PORT = 9347;
const PRESET = process.argv[2] || 'Pop In';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }).on('error', reject);
});

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }
  send(method, params) {
    const id = ++this.seq;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return done;
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  async click([x, y]) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }
  async space() {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  }
}

/** Centre of the first visible leaf element whose text is exactly `text`. */
const centreOf = (text, nth = 0) => `(() => {
  const els = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(text)})
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  const r = els.at(${nth});
  return r ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null;
})()`;

const RECORD = `(() => {
  const c = window.__premationProcessEngineState.instance;
  const rec = { events: [], t0: performance.now() };
  c.subscribe((b) => { for (const e of b.events) if (e.type === 'playhead' || e.type === 'transportChanged') rec.events.push({ type: e.type, frame: Math.round(e.time * 30 / 705600000), state: e.state }); });
  window.__transportRec = rec;
  return true;
})()`;

/** Before each key press: reset the event log and snapshot the transport counters. */
const MARK = `(() => { window.__transportRec.events.length = 0; window.__transportSt0 = { ...window.__premationEngineTransport }; return true; })()`;

const SAMPLE = (ms) => `(async () => {
  const rec = window.__transportRec;
  const st0 = window.__transportSt0;
  await new Promise((r) => setTimeout(r, ${ms}));
  const ev = rec.events.splice(0);
  const ph = ev.filter((e) => e.type === 'playhead').map((e) => e.frame);
  let backwards = 0;
  for (let i = 1; i < ph.length; i++) if (ph[i] < ph[i - 1]) backwards += 1;
  const st = window.__premationEngineTransport;
  return {
    playheads: ph.length, first: ph[0] ?? null, last: ph[ph.length - 1] ?? null, backwards,
    transportChanged: ev.filter((e) => e.type === 'transportChanged').length,
    plays: st.plays - st0.plays, pauses: st.pauses - st0.pauses, seeks: st.seeksSent - st0.seeksSent,
    readout: (document.body.innerText.match(/\\d\\d:\\d\\d:\\d\\d/) || [null])[0],
  };
})()`;

(async () => {
  const userData = path.join(os.tmpdir(), `premation-transport-${process.pid}`);
  const env = { ...process.env, NODE_ENV: 'production', MOTION_EDITION: 'local', PREMATION_ENGINE_PATH: ENGINE };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const keep = (d) => { log = (log + d).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  process.on('exit', (code) => { if (code) console.error(log.slice(-1500)); });
  try {
    let ws = null;
    for (let i = 0; i < 160 && !ws; i++) {
      try {
        const page = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('index.html'));
        if (page) {
          const sock = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => { sock.addEventListener('open', resolve); sock.addEventListener('error', reject); });
          ws = sock;
        }
      } catch { /* booting */ }
      if (!ws) await sleep(250);
    }
    if (!ws) throw new Error('debugger never came up');
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    const win = await cdp.send('Browser.getWindowForTarget').catch(() => null);
    if (win?.windowId) await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'maximized' } }).catch(() => {});
    for (let i = 0; i < 120; i++) {
      if (await cdp.eval('!!(window.__premationAutomation && window.__premationEngineTransport && window.__premationProcessEngineState)')) break;
      await sleep(250);
    }
    const clickButton = (t) => cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(t)})); b?.click(); return !!b; })()`);
    for (let i = 0; i < 40 && !(await clickButton('Continue without')); i++) await sleep(250);
    await sleep(1000);
    await clickButton('Skip tour');
    const made = await cdp.eval(`window.__premationAutomation.runToolTurn('make', [{ name: 'create_layer', args: { id: 'box', kind: 'shape', shape: 'rect', name: 'Box', x: 960, y: 540, width: 300, height: 300, fill: '#ff0000' } }]).then((r) => r.results[0].ok)`);
    await sleep(800);
    await clickButton('Skip tour');
    const tours = await cdp.eval(`[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('Skip tour')).length`);
    await cdp.click(await cdp.eval(centreOf('Box')));
    // The right rail's Presets tab (the last "Presets" label; Properties has its own "Presets" menus).
    await cdp.click(await cdp.eval(centreOf('Presets', -1)));
    await sleep(500);
    let presetAt = await cdp.eval(centreOf(PRESET));
    for (let i = 0; i < 3 && !presetAt; i++) {
      // The preset's category may be collapsed (or a late tour card in the way).
      await clickButton('Skip tour');
      const group = await cdp.eval(centreOf('Entrances'));
      if (group) await cdp.click(group);
      await sleep(500);
      presetAt = await cdp.eval(centreOf(PRESET));
    }
    // Selection may have moved with the clicks: select the layer again.
    await cdp.click(await cdp.eval(centreOf('Box')));
    await sleep(200);
    presetAt = await cdp.eval(centreOf(PRESET));
    if (!presetAt) {
      const shot = path.join(os.tmpdir(), 'premation-transport-fail.png');
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      require('node:fs').writeFileSync(shot, Buffer.from(png.data, 'base64'));
      throw new Error(`preset "${PRESET}" not visible in the Presets panel (screenshot: ${shot})`);
    }
    await cdp.click(presetAt);
    await sleep(800);
    const applied = await cdp.eval(`(async () => {
      const c = window.__premationProcessEngineState.instance;
      const d = await c.query({ type: 'getDocument', includeProperties: false, includeKeyframes: true });
      return d.ok ? d.value.keyframes.map((k) => k.prop.path + ' @ ' + k.keyframes.map((f) => (f.time / 705600000).toFixed(3)).join(',')) : d.error;
    })()`);
    await cdp.eval(RECORD);
    const steps = [];
    const press = async (step, ms) => {
      await cdp.eval(MARK);
      await cdp.space();
      steps.push({ step, ...(await cdp.eval(SAMPLE(ms))) });
    };
    await press('play (Space), 3 s', 3000);
    await press('pause (Space), 2 s', 2000);
    await press('play again (Space), 1.5 s', 1500);
    await press('pause (Space), 1.5 s', 1500);
    console.log(JSON.stringify({ made, tourButtons: tours, preset: PRESET, applied }, null, 1));
    for (const s of steps) console.log(JSON.stringify(s));
    ws.close();
  } finally {
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
