/* global WebSocket -- Node 22 global */
/**
 * F1 real-app Render Queue run (the engine owns the document, draws the
 * viewport and renders the export — the only path since phase 4). Main's folder dialog is stubbed through its inspector;
 * the queue job is added by the AI export_video tool (the same store action as
 * Composition ▸ Add to Render Queue) and started with the panel's Render button.
 *   node scripts/realapp/f1RenderQueue.cjs [project.json] [--om16] [--default]
 */
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, readdirSync, statSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const MAIN = path.join(REPO, 'dist-electron', 'main.js');
// PREMATION_APP_EXE: drive a packaged build (e.g. release/0.9.0/win-unpacked/Premation.exe) instead of dev.
const APP_EXE = process.env.PREMATION_APP_EXE || null;
const ELECTRON = APP_EXE || require(path.join(REPO, 'node_modules', 'electron'));
const ENGINE = path.join(REPO, 'native', 'build', 'windows-clang-cl-engine', 'engine', 'premation-engine.exe');
const FILE = path.resolve(process.argv.find((a) => a.endsWith('.json')) ?? path.join(__dirname, 'fixtures', 'bench.json'));
const OM16 = process.argv.includes('--om16');
const PORT = 9335;
const INSPECT = 9239;
const OUT = mkdtempSync(path.join(os.tmpdir(), 'premation-rq-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }).on('error', reject);
  });
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
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
}
async function ws(url) {
  const s = new WebSocket(url);
  await new Promise((res, rej) => { s.addEventListener('open', res); s.addEventListener('error', () => rej(new Error('ws failed'))); });
  const c = new Cdp(s); await c.send('Runtime.enable'); return { c, s };
}

(async () => {
  const userData = path.join(os.tmpdir(), `premation-rq-ud-${process.pid}`);
  const env = { ...process.env, NODE_ENV: 'production', PREMATION_ENGINE_PATH: ENGINE, MOTION_EDITION: 'local' };
  delete env.ELECTRON_RUN_AS_NODE;
  // --default: no flags at all (the defaults flipped 2026-09-28 must pick the engine).
  if (process.argv.includes('--default')) for (const k of Object.keys(env)) if (k.startsWith('PREMATION_')) delete env[k];
  const child = spawn(ELECTRON, [`--inspect=${INSPECT}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, ...(APP_EXE ? [] : [MAIN])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  const take = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) log.push(l); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  try {
    let page = null;
    for (let i = 0; i < 120 && !page; i++) {
      await sleep(250);
      try { page = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); } catch { /* booting */ }
    }
    if (!page) throw new Error('no page');
    const mainTargets = JSON.parse(await get(`http://127.0.0.1:${INSPECT}/json/list`));
    const m = await ws(mainTargets[0].webSocketDebuggerUrl);
    await m.c.eval(`(() => { const { dialog } = process.mainModule.require('electron'); const dir = ${JSON.stringify(OUT)};
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: require('path').join(dir, ((o || _w || {}).defaultPath || 'out.mp4').split(/[\\\\/]/).pop()) });
      const cp = process.mainModule.require('child_process'); const fs = process.mainModule.require('fs');
      globalThis.__rqSpawns = [];
      for (const k of ['spawn', 'execFile']) { const o = cp[k]; cp[k] = function (file, args, ...rest) {
        try { const a = Array.isArray(args) ? args : []; const rec = { file: String(file), args: a.map(String) };
          const jobArg = a.indexOf('--export'); if (jobArg >= 0) { try { rec.job = JSON.parse(fs.readFileSync(a[jobArg + 1], 'utf8')); } catch (e) { rec.jobErr = String(e); } }
          globalThis.__rqSpawns.push(rec); } catch {}
        return o.call(this, file, args, ...rest); }; }
      return 'stubbed'; })()`);
    const p = await ws(page.webSocketDebuggerUrl);
    for (let i = 0; i < 120; i++) {
      if (await p.c.eval(`!!(window.__premationAutomation && window.__premationProcessEngineState && window.__premationProcessEngineState.instance)`)) break;
      await sleep(250);
    }
    await p.c.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Skip tour'))?.click()`);
    // The project replaces the open document through the app's own engine
    // client (restoreDocument, one undoable entry), keyed to the active comp id,
    // so every UI view follows it (as d5-window's TS measurement does).
    const idSrc = "// @permissions document.read\nconst doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });\nreturn doc.comps[0].id;";
    const id = await p.c.eval(`window.__premationAutomation.runScript(${JSON.stringify(idSrc)}, { grant: ['document.read'] })`);
    let text = require('node:fs').readFileSync(FILE, 'utf8');
    if (id.ok && id.value !== 'comp_root') text = text.split('comp_root').join(id.value);
    const restoreSrc = `// @permissions document.read, document.write\nconst bytes = new TextEncoder().encode(${JSON.stringify(text)});\nawait premation.execute({ type: 'restoreDocument', document: bytes, label: 'rq' });\nreturn bytes.length;`;
    const opened = await p.c.eval(`window.__premationAutomation.runScript(${JSON.stringify(restoreSrc)}, { grant: ['document.read', 'document.write'] })`);
    console.log('[rq] restored', JSON.stringify(opened).slice(0, 200), 'comp', id.value);
    await sleep(1500);
    const queued = await p.c.eval(`(async () => JSON.stringify(await window.__premationAutomation.runToolTurn('export', [{ name: 'export_video', args: { format: 'mp4', mode: 'queue' } }])).slice(0, 400))()`);
    console.log('[rq] queued', queued);
    await sleep(1000);
    if (OM16) console.log('[rq] om16 requested (set in the Output Module dialog by hand)');
    // Render Queue ▸ Add Comp: addToRenderQueue → main's supervisor (the engine export when the flag is on).
    const clicked = await p.c.eval(`(() => {
      const bs = [...document.querySelectorAll('button')].filter((b) => /^\\s*Add Comp\\s*$/.test(b.textContent || '') && !b.disabled);
      if (!bs.length) return 'no render button: ' + [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 60).join(' | ');
      bs[0].click(); return 'clicked ' + bs[0].textContent.trim();
    })()`);
    console.log('[rq]', clicked);
    await sleep(800);
    // The Output Module dialog: its selects (format, bits) and its confirm button.
    console.log('[rq] dialog:', await p.c.eval(`(() => {
      const d = document.querySelector('[role=dialog]') || document.body;
      const sels = [...d.querySelectorAll('select')].map((s, i) => i + ':' + (s.getAttribute('aria-label') || s.name || s.id || '') + '=' + s.value + ' [' + [...s.options].map((o) => o.value + '/' + o.textContent.trim()).join(', ') + ']');
      const btns = [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
      return JSON.stringify({ sels, btns }).slice(0, 3000);
    })()`));
    const FORMAT = OM16 ? 'mov' : 'mp4';
    console.log('[rq] set:', await p.c.eval(`(async () => {
      const d = document.querySelector('[role=dialog]') || document.body;
      const setSel = (s, v) => { const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'); proto.set.call(s, v); s.dispatchEvent(new Event('change', { bubbles: true })); };
      const fmt = [...d.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(FORMAT)}));
      if (!fmt) return 'no format select';
      setSel(fmt, ${JSON.stringify(FORMAT)});
      await new Promise((r) => setTimeout(r, 300));
      let bits = 'n/a';
      if (${OM16}) {
        const b = [...d.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === '16'));
        if (b) { setSel(b, '16'); bits = '16'; } else bits = 'no bits select';
      }
      await new Promise((r) => setTimeout(r, 300));
      const ok = [...d.querySelectorAll('button')].find((b) => /^(Add|Add to Queue|OK|Queue)$/i.test(b.textContent.trim()));
      if (!ok) return 'no confirm: ' + [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|');
      ok.click();
      return 'format ' + fmt.value + ' bits ' + bits + ' confirmed ' + ok.textContent.trim();
    })()`));
    await sleep(4000);
    console.log('[rq] ui after click:', await p.c.eval(`document.body.innerText.split('\\n').filter((l) => /render|queue|export|folder|save|engine|portable|H\\.264|mp4/i.test(l)).slice(0, 30).join(' | ')`));
    let files = [];
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      files = readdirSync(OUT).filter((f) => !f.startsWith('.'));
      if (files.length && files.every((f) => statSync(path.join(OUT, f)).size > 0) && log.some((l) => /\[export\/engine\].*(done|delivered|finished)|export done/i.test(l))) break;
    }
    await sleep(1500);
    files = readdirSync(OUT);
    console.log('[rq] output', OUT, files.map((f) => `${f} ${statSync(path.join(OUT, f)).size}`).join(', '));
    for (const l of log.filter((l) => /export|engine|ffmpeg|render/i.test(l)).slice(-40)) console.log('[main]', l.slice(0, 300));
    const toasts = await p.c.eval(`[...document.querySelectorAll('[role=status],[role=alert]')].map((e) => e.textContent.trim()).filter(Boolean).slice(-5).join(' || ')`);
    console.log('[rq] toasts', toasts);
    const spawns = await m.c.eval(`JSON.stringify((globalThis.__rqSpawns || []).filter((s) => /ffmpeg|premation-engine/i.test(s.file) && !s.args.includes('--host-pid')).map((s) => ({ file: s.file.split(/[\\\\/]/).pop(), depth: s.job ? s.job.depth : undefined, jobKeys: s.job ? Object.keys(s.job).join(',') : undefined, pix: s.args.filter((a, i) => s.args[i - 1] === '-pix_fmt').join(' '), err: s.jobErr })))`);
    console.log('[rq] spawns', spawns);
    for (const f of files) {
      const probe = spawnSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,width,height,nb_frames', '-of', 'compact', path.join(OUT, f)], { encoding: 'utf8' });
      console.log('[rq] ffprobe', f, (probe.stdout || probe.error?.message || '').trim());
    }
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
})().catch((e) => { console.error(e); process.exit(1); });
