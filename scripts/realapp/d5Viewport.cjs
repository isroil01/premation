/* global WebSocket -- Node 22 global */
/**
 * D5 / D4 in the real app (NATIVE_CORE_PLAN D4, D5): the built Electron
 * (dist-electron + the engine build) driven over CDP, the engine HUD on the
 * fixtures/ comps; `--cache` = D4 cache-first playback. (The TypeScript path it
 * was compared against is gone — docs/TS_ENGINE_REMOVAL.md phase 4.)
 *   node scripts/realapp/d5Viewport.cjs [--cache]
 * Real-window HUD on the same fixture projects. Flags are this process only.
 * Does not start Vite. Does not write engine.json.
 */
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const MAIN = path.join(REPO, 'dist-electron', 'main.js');
const ELECTRON = require(path.join(REPO, 'node_modules', 'electron'));
const ENGINE = path.join(REPO, 'native', 'build', 'windows-clang-cl-engine', 'engine', 'premation-engine.exe');
const FILES = ['bench.json', 'shapes8.json', 'shapes32.json', 'styles.json', 'grades.json'].map((n) => path.join(__dirname, 'fixtures', n));
const PORT = 9334;

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function p50(xs) {
  const s = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.floor(s.length / 2)];
}

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
  async eval(expression, ms = 20000) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      sleep(ms).then(() => { throw new Error('eval timed out'); }),
    ]);
    if (r.exceptionDetails) {
      const text = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(text);
    }
    return r.result?.value;
  }
}

async function launch(mode) {
  const userData = path.join(os.tmpdir(), `premation-d5-${mode}-${process.pid}`);
  const env = { ...process.env, NODE_ENV: 'production', PREMATION_ENGINE_PATH: ENGINE };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    MAIN,
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; if (log.length > 8000) log = log.slice(-8000); });
  child.stderr.on('data', (d) => { log += d; if (log.length > 8000) log = log.slice(-8000); });
  let targets = null;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`electron exited ${child.exitCode} before the debugger:\n${log.slice(-1500)}`);
    try {
      targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return { child, page, log: () => log };
    } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error(`debugger never came up:\n${log.slice(-1500)}`);
}

function kill(child) {
  if (!child || child.exitCode !== null) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('cdp websocket failed')));
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  for (let i = 0; i < 80; i++) {
    const ready = await cdp.eval(`!!(window.__premationAutomation && window.__premationViewportHud)`);
    if (ready) break;
    await sleep(250);
    if (i === 79) throw new Error('the editor never exposed the HUD');
  }
  await cdp.eval(`document.querySelector('button') && [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Skip tour'))?.click()`);
  const win = await cdp.send('Browser.getWindowForTarget').catch(() => null);
  if (win && win.windowId) {
    await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'maximized' } }).catch(() => {});
  }
  await sleep(500);
  return { cdp, ws };
}

async function measureEngine(cdp, file) {
  const pathJson = JSON.stringify(file);
  const opened = await cdp.eval(`(async () => {
    const c = window.__premationProcessEngineState && window.__premationProcessEngineState.instance;
    if (!c) return { error: 'no process client' };
    const r = await c.execute({ type: 'openProject', path: ${pathJson} });
    if (!r.ok) return { error: r.error.code + ' ' + r.error.message };
    const doc = await c.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    if (!doc.ok) return { error: doc.error.code + ' ' + doc.error.message };
    const comp = doc.value.comps[0].id;
    await c.execute({ type: 'setActiveComposition', comp });
    await c.execute({ type: 'setLoop', mode: 'once' });
    window.__premationViewportHud.reset();
    const play = await c.execute({
      type: 'play', rate: 1, range: 'custom',
      custom: { start: 0, duration: 2 * 705600000 },
      audio: false, cacheFirst: false,
    });
    if (!play.ok) return { error: play.error.code + ' ' + play.error.message, comp };
    return { comp };
  })()`);
  if (opened.error) return { file: path.basename(file), ...opened };
  await sleep(300);
  const sample = await cdp.eval(`(async () => {
    const hud = window.__premationViewportHud;
    const frames = [];
    let last = hud.sample().cacheMisses;
    const t0 = performance.now();
    while (performance.now() - t0 < 2200) {
      await new Promise((r) => setTimeout(r, 8));
      const s = hud.sample();
      if (s.cacheMisses !== last) {
        last = s.cacheMisses;
        const surf = window.__premationEngineSurface;
        frames.push({ frameMs: s.lastFrameMs, latency: surf ? surf.lastLatencyMs : null, render: surf ? surf.lastRenderMs : null, build: surf ? surf.engineBuildMs : null });
      }
    }
    const surf = window.__premationEngineSurface;
    const own = window.__premationEngineOwnership;
    return {
      frames,
      route: surf ? surf.route : null,
      drawn: surf ? surf.drawn : 0,
      fps: surf ? surf.fps : 0,
      viewport: surf ? surf.lastViewport : null,
      errors: surf ? surf.errors.slice(-3) : [],
      owns: !!(own && own.ownsDocument),
      fellBack: !!(own && own.fellBack),
      dpr: window.devicePixelRatio,
    };
  })()`);
  const steady = sample.frames.slice(8);
  const use = steady.length >= 8 ? steady : sample.frames;
  return {
    file: path.basename(file),
    comp: opened.comp,
    frames: sample.frames.length,
    hudP50: p50(use.map((f) => f.frameMs)),
    latencyP50: p50(use.map((f) => f.latency)),
    renderP50: p50(use.map((f) => f.render)),
    build: use.length ? use[use.length - 1].build : null,
    route: sample.route,
    drawn: sample.drawn,
    surfaceFps: sample.fps,
    viewport: sample.viewport,
    errors: sample.errors,
    owns: sample.owns,
    fellBack: sample.fellBack,
    dpr: sample.dpr,
  };
}

/** D4: cache-first playback of a heavy project in the engine viewport (fill, then play from RAM/VRAM). */
async function measureCacheFile(cdp, file) {
  const pathJson = JSON.stringify(file);
  const opened = await cdp.eval(`(async () => {
    const c = window.__premationProcessEngineState && window.__premationProcessEngineState.instance;
    if (!c) return { error: 'no process client' };
    let phase = 'idle';
    c.subscribe((batch) => { for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state; });
    window.__d4Phase = () => phase;
    const r = await c.execute({ type: 'openProject', path: ${pathJson} });
    if (!r.ok) return { error: r.error.code + ' ' + r.error.message };
    const doc = await c.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    const comp = doc.value.comps[0].id;
    await c.execute({ type: 'setActiveComposition', comp });
    await c.execute({ type: 'setLoop', mode: 'once' });
    window.__premationViewportHud.reset();
    const play = await c.execute({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: 2 * 705600000 }, audio: false, cacheFirst: true });
    if (!play.ok) return { error: play.error.code + ' ' + play.error.message };
    return { comp };
  })()`);
  if (opened.error) return { case: 'cache ' + path.basename(file), ...opened };
  const sample = await cdp.eval(`(async () => {
    const hud = window.__premationViewportHud;
    const surf0 = window.__premationEngineSurface;
    const phases = { caching: [], playing: [] };
    const shown = { caching: 0, playing: 0 };
    let last = hud.sample().cacheMisses;
    let drawn = surf0 ? surf0.drawn : 0;
    const t0 = performance.now();
    let phase = 'idle';
    let playStart = 0, playEnd = 0;
    while (performance.now() - t0 < 30000) {
      phase = window.__d4Phase();
      await new Promise((r) => setTimeout(r, 4));
      const s = hud.sample();
      const surf = window.__premationEngineSurface;
      if (surf && surf.drawn !== drawn && (phase === 'caching' || phase === 'playing')) {
        shown[phase] += surf.drawn - drawn;
        if (phase === 'playing') { if (!playStart) playStart = performance.now(); playEnd = performance.now(); }
      }
      if (surf) drawn = surf.drawn;
      if (s.cacheMisses !== last && (phase === 'caching' || phase === 'playing')) { last = s.cacheMisses; phases[phase].push(s.lastFrameMs); }
      if (phase === 'stopped') break;
    }
    return { phases, shown, phase, playMs: playEnd - playStart };
  })()`);
  const p = (xs) => ({ n: xs.length, p50: p50(xs.slice(2).length ? xs.slice(2) : xs) });
  return {
    case: 'cache ' + path.basename(file),
    fill: p(sample.phases.caching),
    play: p(sample.phases.playing),
    shownWhilePlaying: sample.shown.playing,
    playSpanMs: Math.round(sample.playMs),
    playFps: sample.playMs > 0 ? Number(((sample.shown.playing - 1) * 1000 / sample.playMs).toFixed(1)) : null,
    phaseEnd: sample.phase,
  };
}

(async () => {
  if (process.argv.includes('--cache')) {
    const launched = await launch('engine');
    try {
      const { cdp, ws } = await connect(launched.page);
      for (const f of ['heavy.json', 'styles.json']) console.log(JSON.stringify(await measureCacheFile(cdp, path.join(__dirname, 'fixtures', f))));
      ws.close();
    } finally {
      kill(launched.child);
    }
    return;
  }
  for (const mode of ['engine']) {
    const launched = await launch(mode);
    try {
      const { cdp, ws } = await connect(launched.page);
      for (const file of FILES) {
        const row = await measureEngine(cdp, file);
        row.mode = mode;
        console.log(JSON.stringify(row));
      }
      ws.close();
    } finally {
      kill(launched.child);
      await sleep(400);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
