/**
 * C1 viewport prototype host (docs/VIEWPORT_ROUTE.md). Self-contained: it
 * shares no code with electron/ or src/, so it cannot break the app.
 *
 *   npx electron native/engine/proto-host [--route=A|B|C] [--res=1080|2160] [--scale=1|0.5]
 *        [--seconds=8] [--warmup=2] [--tests=1] [--out=result.json] [--shots=dir]
 *        [--interactive=1] [--power=auto|low|high] [--fps=60] [--engine=path]
 *
 * Route C needs Electron >= 40 (sharedTexture); run it with that electron.exe.
 * The host spawns premation-engine, relays frames/commands, measures, runs the
 * scripted overlap/resize/move/minimize/DPR tests, writes JSON and quits.
 */
'use strict';

const { app, BrowserWindow, ipcMain, MessageChannelMain, screen } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const electronApi = require('electron');
const sharedTexture = electronApi.sharedTexture; // Electron >= 40 only

// ── config ─────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(
  process.argv
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => {
      const i = a.indexOf('=');
      return [a.slice(2, i), a.slice(i + 1)];
    }),
);
const cfg = {
  route: (argv.route || 'A').toUpperCase(),
  res: Number(argv.res || 1080),
  scale: Number(argv.scale || 1),
  seconds: Number(argv.seconds || 8),
  warmup: Number(argv.warmup || 2),
  tests: argv.tests !== '0',
  interactive: argv.interactive === '1',
  out: argv.out || '',
  shots: argv.shots || '',
  power: argv.power || 'auto',
  fps: Number(argv.fps || 60),
  holesDefault: argv.holes === '1',
  engine:
    argv.engine ||
    path.resolve(__dirname, '..', '..', 'build', 'windows-clang-cl-engine', 'engine', 'premation-engine.exe'),
};
// --chromium-gpu=low: ask Chromium for the integrated GPU (the engine then
// follows it via --gpu-vendor), to measure the whole stack on the iGPU.
if (argv['chromium-gpu'] === 'low') app.commandLine.appendSwitch('force_low_power_gpu');
if (argv['chromium-gpu'] === 'high') app.commandLine.appendSwitch('force_high_performance_gpu');
const compW = cfg.res === 2160 ? 3840 : 1920;
const compH = cfg.res === 2160 ? 2160 : 1080;

// Epoch µs on the same clock as the engine (system clock) and the page:
// performance.now() anchored to a Date.now() millisecond edge.
const clockCorr = (() => {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const d0 = Date.now();
    let d;
    while ((d = Date.now()) === d0) { /* spin to the next ms edge (<= 1 ms) */ }
    samples.push(d * 1000 - (performance.timeOrigin + performance.now()) * 1000);
  }
  return samples.sort((a, b) => a - b)[2];
})();
const epochUs = () => (performance.timeOrigin + performance.now()) * 1000 + clockCorr;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[host]', ...a);

// ── measurement state ──────────────────────────────────────────────────────
const M = {
  measuring: false,
  frames: [], // per presented frame timing records (A, C from page; B from engine)
  engineStats: [],
  appMetrics: [],
  mainDrops: 0,
  mainForwarded: 0,
  rectLag: [],
  pageCounters: [],
  pointer: [],
  events: [],
  hello: null,
  errors: [],
};

let win = null;
let engine = null;
let port = null; // MessagePortMain to the page (route A)
let pageBusy = false;
let pendingFrame = null; // { header, buf }
let spareBuf = null;

// ── engine stdout parser ───────────────────────────────────────────────────
const HDR = 64;
function makeParser(onMessage) {
  let head = Buffer.alloc(0);
  let hdr = null;
  let payload = null;
  let filled = 0;
  return (chunk) => {
    let off = 0;
    while (off < chunk.length) {
      if (!hdr) {
        const need = HDR - head.length;
        const take = Math.min(need, chunk.length - off);
        head = Buffer.concat([head, chunk.subarray(off, off + take)]);
        off += take;
        if (head.length < HDR) return;
        const magic = head.readUInt32LE(0);
        if (magic !== 0x4d524650) throw new Error(`bad magic ${magic.toString(16)}`);
        hdr = {
          type: head.readUInt32LE(4),
          payloadBytes: head.readUInt32LE(8),
          frameIndex: head.readUInt32LE(12),
          width: head.readUInt32LE(16),
          height: head.readUInt32LE(20),
          slot: head.readUInt32LE(24),
          tRenderStartUs: head.readDoubleLE(32),
          tRenderDoneUs: head.readDoubleLE(40),
          tCmdUs: head.readDoubleLE(48),
          tSendUs: head.readDoubleLE(56),
        };
        head = Buffer.alloc(0);
        filled = 0;
        if (hdr.payloadBytes > 0) {
          // Reuse a spare frame buffer of the right size (no per-frame allocation at steady state).
          if (hdr.type === 1 && spareBuf && spareBuf.length === hdr.payloadBytes) {
            payload = spareBuf;
            spareBuf = null;
          } else payload = Buffer.allocUnsafe(hdr.payloadBytes);
        } else payload = null;
        if (!payload) {
          const h = hdr;
          hdr = null;
          onMessage(h, null);
          continue;
        }
      }
      const take = Math.min(hdr.payloadBytes - filled, chunk.length - off);
      chunk.copy(payload, filled, off, off + take);
      filled += take;
      off += take;
      if (filled === hdr.payloadBytes) {
        const h = hdr;
        const p = payload;
        hdr = null;
        payload = null;
        onMessage(h, p);
      }
    }
  };
}

function onEngineMessage(h, payload) {
  const tRecv = epochUs();
  if (h.type === 2) {
    const msg = JSON.parse(payload.toString('utf8'));
    if (msg.type === 'hello') {
      M.hello = msg;
      log('engine hello', msg.adapter, msg.backend, `${msg.compWidth}x${msg.compHeight}`);
      win?.webContents.send('engine-hello', msg);
      if (cfg.route === 'C') setupRouteC(msg);
    } else if (msg.type === 'stats') {
      if (M.measuring) M.engineStats.push(msg);
      win?.webContents.send('engine-stats', msg);
    } else if (msg.type === 'rectApplied') {
      M.rectLag.push((msg.tAppliedUs - msg.tReqUs) / 1000);
    } else if (msg.type === 'error') {
      M.errors.push(msg.message);
      log('engine error:', msg.message);
    }
    return;
  }
  if (h.type === 1) {
    // Route A frame. Forward the newest; never queue more than one behind the page.
    h.tMainRecvUs = tRecv;
    if (pageBusy) {
      if (pendingFrame) {
        M.mainDrops++;
        spareBuf = pendingFrame.buf;
      }
      pendingFrame = { header: h, buf: payload };
      return;
    }
    postFrame(h, payload);
    return;
  }
  if (h.type === 3) {
    h.tMainRecvUs = tRecv;
    forwardSharedTexture(h);
    return;
  }
  if (h.type === 4) {
    // Route B: the engine presented a frame into its child window.
    if (M.measuring) {
      M.frames.push({
        f: h.frameIndex,
        tRenderStart: h.tRenderStartUs,
        tPresent: h.tRenderDoneUs,
        tCmd: h.tCmdUs,
      });
    }
  }
}

function postFrame(h, buf) {
  pageBusy = true;
  h.tMainPostUs = epochUs();
  // Structured clone copies the bytes into the message synchronously, so the
  // buffer is free again as soon as postMessage returns.
  port.postMessage({ header: h, pixels: buf });
  M.mainForwarded++;
  spareBuf = buf;
}

// ── route C: shared textures ───────────────────────────────────────────────
let cHandles = [];
let cSending = false;
function setupRouteC(hello) {
  if (!sharedTexture) {
    M.errors.push(`Electron ${process.versions.electron} has no sharedTexture module (needs >= 40)`);
    log(M.errors.at(-1));
    return;
  }
  cHandles = hello.handles.map((s) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(s));
    return b;
  });
}

async function forwardSharedTexture(h) {
  if (!sharedTexture || !cHandles.length || cSending) {
    if (cSending) M.mainDrops++;
    engine.stdin.write(`free ${h.slot}\n`);
    return;
  }
  cSending = true;
  try {
    const imported = sharedTexture.importSharedTexture({
      textureInfo: {
        pixelFormat: 'rgba',
        codedSize: { width: h.width, height: h.height },
        handle: { ntHandle: cHandles[h.slot] },
      },
      // Every process (main + renderer, incl. the GPU work) is done with it:
      // the engine may render into this slot again.
      allReferencesReleased: () => engine?.stdin.write(`free ${h.slot}\n`),
    });
    h.tMainPostUs = epochUs();
    await sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported }, h);
    imported.release();
    M.mainForwarded++;
  } catch (e) {
    M.errors.push(`sharedTexture: ${e.message}`);
    engine.stdin.write(`free ${h.slot}\n`);
  } finally {
    cSending = false;
  }
}

// ── engine process ─────────────────────────────────────────────────────────
function pickPower() {
  if (cfg.power !== 'auto') return cfg.power;
  // Match Chromium's GPU so routes are compared on the same adapter (and
  // route C's shared handle is openable at all).
  return M.chromiumGpuIsDiscrete ? 'high' : 'low';
}

function spawnEngine(rect) {
  const args = [
    '--route', cfg.route,
    '--width', String(compW),
    '--height', String(compH),
    '--scale', String(cfg.scale),
    '--fps', String(cfg.fps),
    '--power', pickPower(),
  ];
  // Same adapter as Chromium: vendor id wins over the power heuristic. An
  // explicit --power=low|high is a deliberate mismatch test, so it is not sent.
  if (cfg.power === 'auto' && M.chromiumGpu) args.push('--gpu-vendor', String(M.chromiumGpu.vendorId));
  if (cfg.route === 'B') {
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
    args.push('--parent', hwnd.toString(), '--rect', `${rect.x},${rect.y},${rect.w},${rect.h}`);
  }
  if (cfg.route === 'C') args.push('--host-pid', String(process.pid), '--slots', '3');
  log('spawn', path.basename(cfg.engine), args.join(' '));
  engine = spawn(cfg.engine, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const parse = makeParser(onEngineMessage);
  engine.stdout.on('data', (c) => {
    try {
      parse(c);
    } catch (e) {
      M.errors.push(`parser: ${e.message}`);
    }
  });
  engine.stderr.on('data', (c) => process.stderr.write(`[engine] ${c}`));
  engine.on('exit', (code, sig) => {
    log('engine exit', code, sig);
    M.events.push({ t: Date.now(), engineExit: code ?? sig });
    engine = null;
  });
}

function sendEngine(line) {
  if (engine && engine.stdin.writable) engine.stdin.write(`${line}\n`);
}

// ── page IPC ───────────────────────────────────────────────────────────────
let lastRect = null;
let readyResolve;
const pageReady = new Promise((r) => (readyResolve = r));

ipcMain.on('page-ready', (_e, info) => {
  lastRect = info.rect;
  M.pageInfo = info;
  readyResolve(info);
});
ipcMain.on('viewport-rect', (_e, r) => {
  lastRect = r;
  if (cfg.route === 'B') sendEngine(`rect ${r.x} ${r.y} ${r.w} ${r.h} ${r.t}`);
});
ipcMain.on('holes', (_e, holes) => {
  if (cfg.route === 'B') sendEngine(`holes ${holes.length} ${holes.map((h) => `${h.x} ${h.y} ${h.w} ${h.h}`).join(' ')}`);
});
ipcMain.on('ping', (_e, t) => sendEngine(`ping ${t}`));
ipcMain.on('pointer', (_e, p) => M.pointer.push(p));
ipcMain.on('page-counters', (_e, c) => {
  if (M.measuring) M.pageCounters.push(c);
});
ipcMain.on('frame-record', (_e, rec) => {
  if (M.measuring) M.frames.push(rec);
});
ipcMain.on('page-log', (_e, s) => log('page:', s));

// ── OS-level evidence (captures what the USER sees, native windows included) ─
const psDir = path.join(__dirname, 'tools');
function physicalBounds() {
  const b = win.getContentBounds();
  return screen.dipToScreenRect(win, b);
}
function osShot(name) {
  if (!cfg.shots) return null;
  fs.mkdirSync(cfg.shots, { recursive: true });
  const out = path.resolve(cfg.shots, name);
  const r = physicalBounds();
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(psDir, 'shot.ps1'),
      '-X', String(r.x), '-Y', String(r.y), '-W', String(r.width), '-H', String(r.height), '-Out', out],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) M.errors.push(`shot ${name}: ${res.stderr}`);
  return out;
}
function osClick(xPhys, yPhys) {
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(psDir, 'click.ps1'),
    '-X', String(Math.round(xPhys)), '-Y', String(Math.round(yPhys))], { encoding: 'utf8' });
}
const page = (js) => win.webContents.executeJavaScript(js, true);

// ── measurement ────────────────────────────────────────────────────────────
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}
function summarize(values) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: +mean.toFixed(2), p50: +pct(s, 0.5).toFixed(2), p95: +pct(s, 0.95).toFixed(2), max: +s.at(-1).toFixed(2) };
}

function sampleAppMetrics() {
  const byType = {};
  for (const m of app.getAppMetrics()) {
    const key = m.type === 'Tab' ? 'renderer' : m.type === 'Browser' ? 'main' : m.type === 'GPU' ? 'gpu' : 'other';
    byType[key] = (byType[key] || 0) + m.cpu.percentCPUUsage;
  }
  return byType;
}

async function measure(label, seconds) {
  M.frames = [];
  M.engineStats = [];
  M.appMetrics = [];
  M.mainDrops = 0;
  M.mainForwarded = 0;
  M.pageCounters = [];
  sampleAppMetrics(); // reset the "since last call" window
  M.measuring = true;
  const t0 = epochUs();
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    M.appMetrics.push(sampleAppMetrics());
  }
  M.measuring = false;
  const secs = (epochUs() - t0) / 1e6;

  const frames = M.frames;
  const lat = frames.map((f) => (f.tPresent - f.tRenderStart) / 1000);
  // Command latency: first frame carrying each new ping timestamp.
  const seen = new Set();
  const cmd = [];
  for (const f of frames) {
    if (f.tCmd > 0 && !seen.has(f.tCmd)) {
      seen.add(f.tCmd);
      cmd.push((f.tPresent - f.tCmd) / 1000);
    }
  }
  const breakdown = {};
  for (const key of ['engineGpu', 'pipe', 'mainHop', 'ipc', 'upload']) breakdown[key] = [];
  for (const f of frames) {
    if (f.tRenderDone) breakdown.engineGpu.push((f.tRenderDone - f.tRenderStart) / 1000);
    if (f.tMainRecv && f.tSend) breakdown.pipe.push((f.tMainRecv - f.tSend) / 1000);
    if (f.tMainPost && f.tMainRecv) breakdown.mainHop.push((f.tMainPost - f.tMainRecv) / 1000);
    if (f.tPageRecv && f.tMainPost) breakdown.ipc.push((f.tPageRecv - f.tMainPost) / 1000);
    if (f.tPresent && f.tPageRecv) breakdown.upload.push((f.tPresent - f.tPageRecv) / 1000);
  }
  const avg = (arr, k) => (arr.length ? +(arr.reduce((a, m) => a + (m[k] || 0), 0) / arr.length).toFixed(1) : null);
  const eng = M.engineStats;
  const engAvg = (k) => (eng.length ? +(eng.reduce((a, s) => a + s[k], 0) / eng.length).toFixed(2) : null);
  const cpu = {
    engine: engAvg('cpuPct'),
    main: avg(M.appMetrics, 'main'),
    renderer: avg(M.appMetrics, 'renderer'),
    gpuProcess: avg(M.appMetrics, 'gpu'),
    other: avg(M.appMetrics, 'other'),
  };
  cpu.total = +Object.values(cpu).reduce((a, b) => a + (b || 0), 0).toFixed(1);
  return {
    label,
    secs: +secs.toFixed(2),
    presentedFps: +(frames.length / secs).toFixed(1),
    engine: {
      renderedFps: engAvg('renderedFps'),
      sentFps: engAvg('sentFps'),
      droppedFps: engAvg('droppedFps'),
      gpuMsAvg: engAvg('gpuMsAvg'),
    },
    mainDropsPerSec: +(M.mainDrops / secs).toFixed(1),
    pageRafPerSec: avg(M.pageCounters, 'raf'),
    pageDropsPerSec: avg(M.pageCounters, 'drops'),
    latencyFrameMs: summarize(lat),
    latencyCmdMs: summarize(cmd),
    breakdownMs: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, summarize(v)])),
    cpuPctOfOneCore: cpu,
  };
}

// ── scripted tests ─────────────────────────────────────────────────────────
async function runTests(result) {
  const t = {};
  const tag = `${cfg.route}-${cfg.res}${cfg.scale !== 1 ? '-half' : ''}`;
  // 1. dropdown over the viewport
  await page('window.proto.openMenu(true)');
  await sleep(600);
  t.menuShot = osShot(`menu-open-${tag}.png`);
  // Does an HTML layer over the viewport cost frames?
  t.presentedFpsMenuOpen = (await measure('menu-open', 3)).presentedFps;
  if (cfg.route === 'B') {
    await page('window.proto.setHoles(true)');
    await sleep(600);
    t.menuHolesShot = osShot(`menu-open-holes-${tag}.png`);
    await page('window.proto.setHoles(false)');
  }
  await page('window.proto.openMenu(false)');
  await sleep(300);

  // 2. does a real OS click over the viewport reach the page?
  M.pointer = [];
  const r = physicalBounds();
  const vr = lastRect; // physical px relative to the content area
  osClick(r.x + vr.x + vr.w / 2, r.y + vr.y + vr.h / 2);
  await sleep(500);
  t.clickReachedPage = M.pointer.length > 0;

  // 3. split-drag: inspector width animates, the viewport resizes every frame
  M.rectLag = [];
  const before = M.frames.length;
  M.measuring = true;
  const t0 = Date.now();
  await page('window.proto.animateSplit(360, 760, 1500)');
  await sleep(700);
  t.resizeMidShot = osShot(`split-drag-mid-${tag}.png`);
  await sleep(1200);
  M.measuring = false;
  t.splitDrag = {
    presentedFpsDuring: +(((M.frames.length - before) * 1000) / (Date.now() - t0)).toFixed(1),
    rectApplyLagMs: summarize(M.rectLag),
  };

  // 4. OS window resize
  const b0 = win.getBounds();
  for (let i = 0; i <= 30; i++) {
    win.setBounds({ ...b0, width: b0.width - i * 8, height: b0.height - i * 5 });
    await sleep(16);
    if (i === 15) t.windowResizeMidShot = osShot(`window-resize-mid-${tag}.png`);
  }
  win.setBounds(b0);
  await sleep(500);

  // 5. window move
  win.setPosition(b0.x + 120, b0.y + 60);
  await sleep(500);
  t.movedShot = osShot(`moved-${tag}.png`);
  win.setPosition(b0.x, b0.y);
  await sleep(300);

  // 6. minimize / restore, engine must survive and keep going
  win.minimize();
  await sleep(1500);
  win.restore();
  win.focus();
  await sleep(1000);
  t.restoredShot = osShot(`restored-${tag}.png`);
  t.engineAliveAfterRestore = engine !== null;

  // 7. DPR change (zoom changes devicePixelRatio exactly as a monitor change would for the page)
  win.webContents.setZoomFactor(1.25);
  await sleep(800);
  t.zoomShot = osShot(`zoom125-${tag}.png`);
  t.dprAfterZoom = await page('window.devicePixelRatio');
  win.webContents.setZoomFactor(1);
  await sleep(500);

  // 8. drag the window to the OTHER monitor (real DPR change, e.g. 1.09 → 2.18)
  const others = screen.getAllDisplays().filter((d) => d.id !== screen.getDisplayMatching(win.getBounds()).id);
  if (others.length) {
    const home = win.getBounds();
    const wa2 = others[0].workArea;
    win.setBounds({ x: wa2.x + 20, y: wa2.y + 20, width: Math.min(home.width, wa2.width - 40), height: Math.min(home.height, wa2.height - 40) });
    await sleep(1500);
    t.otherMonitor = { dpr: await page('window.devicePixelRatio'), rect: lastRect };
    t.otherMonitorShot = osShot(`other-monitor-${tag}.png`);
    win.setBounds(home);
    await sleep(1000);
  }

  // 9. B only: the engine thread stops pumping messages for 4 s. Does the
  //    Electron UI still take a click (its input queue is attached)?
  if (cfg.route === 'B') {
    await page('window.proto.openMenu(false)');
    const btn = await page('(() => { const r = document.getElementById("viewBtn").getBoundingClientRect(); const d = devicePixelRatio; return { x: (r.left + r.width / 2) * d, y: (r.top + r.height / 2) * d }; })()');
    const hangMs = Number(argv.hang ?? 4000); // --hang=0 is the baseline (click cost incl. PowerShell start-up)
    sendEngine(`hang ${hangMs}`);
    await sleep(300);
    const tClick = Date.now();
    const pb = physicalBounds();
    osClick(pb.x + btn.x, pb.y + btn.y);
    let opened = false;
    while (Date.now() - tClick < 6000) {
      opened = await page('document.getElementById("menu").classList.contains("open")');
      if (opened) break;
      await sleep(20);
    }
    // ...and can the window still be resized / minimized while the child's thread is stuck?
    const b1 = win.getBounds();
    const tResize = performance.now();
    win.setBounds({ ...b1, width: b1.width - 100 });
    win.setBounds(b1);
    const resizeMs = performance.now() - tResize;
    const tMin = performance.now();
    win.minimize();
    win.restore();
    const minRestoreMs = performance.now() - tMin;
    t.engineHang = { uiClickHandledMs: opened ? Date.now() - tClick : null, hangMs, resizeMs: +resizeMs.toFixed(1), minRestoreMs: +minRestoreMs.toFixed(1) };
    await page('window.proto.openMenu(false)');
    await sleep(hangMs);
  }

  const after = await measure('after-tests', 3);
  t.presentedFpsAfterTests = after.presentedFps;
  result.tests = t;
}

// ── lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    const info = await app.getGPUInfo('complete');
    const active = (info.gpuDevice || []).find((d) => d.active) || (info.gpuDevice || [])[0];
    M.chromiumGpu = active ? { vendorId: active.vendorId, deviceId: active.deviceId } : null;
    // 0x10de NVIDIA, 0x1002 AMD, 0x8086 Intel — on this laptop the 780M is AMD (integrated).
    M.chromiumGpuIsDiscrete = active?.vendorId === 0x10de;
  } catch {
    M.chromiumGpu = null;
  }

  // --display=internal|external puts the window on that monitor (this laptop:
  // internal panel at DPR ~2.18, external monitor at ~1.09).
  const displays = screen.getAllDisplays();
  const target =
    (argv.display === 'internal' && displays.find((d) => d.internal)) ||
    (argv.display === 'external' && displays.find((d) => !d.internal)) ||
    screen.getPrimaryDisplay();
  const wa = target.workArea;
  win = new BrowserWindow({
    width: Math.min(1500, wa.width - 40),
    height: Math.min(900, wa.height - 40),
    x: wa.x + 20,
    y: wa.y + 20,
    show: true,
    backgroundColor: '#17171a',
    autoHideMenuBar: true,
    title: `premation C1 — route ${cfg.route}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // Prototype only: route C's VideoFrame cannot cross a contextBridge.
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  await win.loadFile(path.join(__dirname, 'index.html'), {
    query: { route: cfg.route, holes: cfg.holesDefault ? '1' : '0' },
  });
  if (cfg.route === 'A') {
    const { port1, port2 } = new MessageChannelMain();
    port = port1;
    port.on('message', (e) => {
      // Page finished presenting a frame: send the newest pending one.
      pageBusy = false;
      if (e.data && e.data.rec && M.measuring) M.frames.push(e.data.rec);
      if (pendingFrame) {
        const p = pendingFrame;
        pendingFrame = null;
        postFrame(p.header, p.buf);
      }
    });
    port.start();
    win.webContents.postMessage('frame-port', null, [port2]);
  }
  const info = await pageReady;
  log('page ready', JSON.stringify(info));
  spawnEngine(info.rect);

  if (cfg.interactive) return;
  await sleep(cfg.warmup * 1000);
  const result = {
    config: { ...cfg, compW, compH, electron: process.versions.electron, chrome: process.versions.chrome },
    chromiumGpu: M.chromiumGpu,
    page: M.pageInfo,
    display: (({ scaleFactor, size, label, internal }) => ({ scaleFactor, size, label, internal }))(
      screen.getDisplayMatching(win.getBounds()),
    ),
    displays: screen.getAllDisplays().map((d) => ({ scaleFactor: d.scaleFactor, size: d.size, internal: d.internal })),
  };
  result.hello = M.hello;
  result.steady = await measure('steady', cfg.seconds);
  if (cfg.tests && engine) await runTests(result);
  result.errors = M.errors;
  result.events = M.events;
  if (cfg.out) {
    fs.mkdirSync(path.dirname(path.resolve(cfg.out)), { recursive: true });
    fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2));
  }
  log('RESULT', JSON.stringify(result.steady));
  shutdown(0);
});

function shutdown(code) {
  if (engine) {
    sendEngine('quit');
    const e = engine;
    setTimeout(() => e.kill(), 1000);
  }
  setTimeout(() => app.exit(code), 1200);
}
app.on('window-all-closed', () => shutdown(0));
