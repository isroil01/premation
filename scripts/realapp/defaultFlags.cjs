/* global WebSocket -- Node 22 global */
/**
 * The flipped defaults in the real app: no PREMATION_* flags at all. Reports who
 * owns the document, whether the engine's frames are the viewport, the HUD on
 * bench.json, and main's export capabilities (engine export on).
 */
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const MAIN = path.join(REPO, 'dist-electron', 'main.js');
const ELECTRON = require(path.join(REPO, 'node_modules', 'electron'));
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej); });

(async () => {
  const env = { ...process.env, NODE_ENV: 'production' };
  for (const k of Object.keys(env)) if (k.startsWith('PREMATION_')) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = path.join(os.tmpdir(), `premation-default-${process.pid}`);
  const child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
  try {
    let page = null;
    for (let i = 0; i < 120 && !page; i++) {
      await sleep(250);
      try { page = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); } catch { /* booting */ }
    }
    if (!page) throw new Error('no page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws'))); });
    let seq = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const evalJs = (expression) => new Promise((res) => { const id = ++seq; pending.set(id, (m) => res(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description ?? m.error)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
    for (let i = 0; i < 120; i++) {
      if (await evalJs(`!!(window.__premationProcessEngineState && window.__premationProcessEngineState.instance && window.__premationViewportHud)`)) break;
      await sleep(250);
    }
    await sleep(3000);
    const r = await evalJs(`(async () => {
      const own = window.__premationEngineOwnership;
      const surf = window.__premationEngineSurface;
      const st = await window.motionEditor?.engine?.status?.();
      const caps = await window.motionEditor?.export?.capabilities?.().catch?.((e) => String(e));
      return JSON.stringify({ status: st && { enabled: st.enabled, ownsDocument: st.ownsDocument, state: st.state }, owns: own && own.ownsDocument, fellBack: own && own.fellBack, route: surf && surf.route, drawn: surf && surf.drawn, caps });
    })()`);
    console.log('[default]', r);
    ws.close();
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  const lines = log.join('').split(/\r?\n/).filter((l) => /engine_spawned|engine_ready|fallback|engine\]/.test(l)).slice(0, 6);
  for (const l of lines) console.log('[main]', l.slice(0, 200));
})().catch((e) => { console.error(e); process.exit(1); });
