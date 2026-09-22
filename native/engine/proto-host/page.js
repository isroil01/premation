/* C1 prototype page: draws engine frames (A, C) or reports the viewport rect
 * the engine's child window must cover (B), and records per-frame timing. */
'use strict';
/* global window, document, location, performance, navigator, requestAnimationFrame, setInterval,
   URLSearchParams, ResizeObserver, matchMedia, GPUBufferUsage, GPUTextureUsage -- a plain browser
   script loaded by index.html; the repo's lint config has no browser globals for native/ */

const params = new URLSearchParams(location.search);
const route = (params.get('route') || 'A').toUpperCase();
const $ = (id) => document.getElementById(id);
const vp = $('viewport');
const canvas = $('canvas');
$('routeLabel').textContent = `route ${route} · Electron ${window.host.electron}`;

// ── one clock for engine / main / page: epoch µs, calibrated to Date.now() edges ──
let clockCorr = 0;
{
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const d0 = Date.now();
    let d;
    while ((d = Date.now()) === d0) { /* spin to the next ms edge (<= 1 ms) */ }
    samples.push(d * 1000 - (performance.timeOrigin + performance.now()) * 1000);
  }
  samples.sort((a, b) => a - b);
  clockCorr = samples[2];
}
const epochUs = () => (performance.timeOrigin + performance.now()) * 1000 + clockCorr;

// ── HUD ────────────────────────────────────────────────────────────────────
let presented = 0;
let pageDrops = 0;
let lastLat = 0;
let engineLine = '';
window.host.on('engine-stats', (s) => {
  engineLine = `engine ${s.renderedFps.toFixed(0)} fps  cpu ${s.cpuPct.toFixed(0)}%  gpu ${s.gpuMsAvg.toFixed(1)} ms`;
});
window.host.on('engine-hello', (h) => {
  $('routeLabel').textContent += ` · ${h.adapter} ${h.compWidth}×${h.compHeight}`;
});
let rafCount = 0;
(function countRaf() {
  rafCount++;
  requestAnimationFrame(countRaf);
})();
let lastDrops = 0;
setInterval(() => {
  window.host.send('page-counters', { raf: rafCount, drops: pageDrops - lastDrops });
  rafCount = 0;
  lastDrops = pageDrops;
  $('hud').textContent = `${route === 'B' ? '' : `page ${presented} fps  lat ${lastLat.toFixed(1)} ms  drops ${pageDrops}   `}${engineLine}`;
  presented = 0;
}, 1000);

// Command pings: the newest one rides on the next frame the engine renders.
setInterval(() => window.host.send('ping', epochUs()), 100);

// ── layout: splitter, menu, holes, rect reporting ─────────────────────────
const inspector = $('inspector');
{
  let drag = null;
  $('splitter').addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, w: inspector.offsetWidth };
    e.target.setPointerCapture(e.pointerId);
  });
  $('splitter').addEventListener('pointermove', (e) => {
    if (drag) inspector.style.width = `${Math.max(150, drag.w - (e.clientX - drag.x))}px`;
  });
  $('splitter').addEventListener('pointerup', () => (drag = null));
}

let holesOn = params.get('holes') === '1';
const menu = $('menu');
function physRect(el) {
  const r = el.getBoundingClientRect();
  const d = window.devicePixelRatio;
  const x = Math.round(r.left * d);
  const y = Math.round(r.top * d);
  return { x, y, w: Math.round(r.right * d) - x, h: Math.round(r.bottom * d) - y };
}
function sendHoles() {
  window.host.send('holes', holesOn && menu.classList.contains('open') ? [physRect(menu)] : []);
}
function openMenu(on) {
  menu.classList.toggle('open', on);
  sendHoles();
}
function setHoles(on) {
  holesOn = on;
  $('holesBtn').textContent = `holes: ${on ? 'on' : 'off'}`;
  sendHoles();
}
$('viewBtn').addEventListener('click', () => openMenu(!menu.classList.contains('open')));
$('holesBtn').addEventListener('click', () => setHoles(!holesOn));
setHoles(holesOn);

function reportRect() {
  const r = physRect(vp);
  window.host.send('viewport-rect', { ...r, t: epochUs() });
  if (menu.classList.contains('open')) sendHoles();
  return r;
}
function sizeCanvas() {
  const r = physRect(vp);
  if (canvas.width !== r.w || canvas.height !== r.h) {
    canvas.width = Math.max(1, r.w);
    canvas.height = Math.max(1, r.h);
  }
}
new ResizeObserver(() => {
  sizeCanvas();
  reportRect();
}).observe(vp);
window.addEventListener('resize', reportRect);
(function watchDpr() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      sizeCanvas();
      reportRect();
      watchDpr();
    },
    { once: true },
  );
})();

vp.addEventListener('pointerdown', (e) => window.host.send('pointer', { x: e.clientX, y: e.clientY, t: epochUs() }));

function animateSplit(from, to, ms) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const tri = k < 0.5 ? k * 2 : 2 - k * 2;
      inspector.style.width = `${from + (to - from) * tri}px`;
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}
window.proto = { openMenu, setHoles, animateSplit };

// ── WebGPU presentation (A: uploaded pixels, C: imported shared texture) ────
const BLIT_WGSL = (external) => `
struct U { scale : vec2<f32> };
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var t : ${external ? 'texture_external' : 'texture_2d<f32>'};
@group(0) @binding(2) var s : sampler;
struct VO { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i : u32) -> VO {
  var c = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                              vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  var o : VO;
  let p = c[i];
  o.pos = vec4<f32>((p.x * 2.0 - 1.0) * u.scale.x, (1.0 - p.y * 2.0) * u.scale.y, 0.0, 1.0);
  o.uv = p;
  return o;
}
@fragment fn fs(v : VO) -> @location(0) vec4<f32> {
  return ${external ? 'textureSampleBaseClampToEdge(t, s, v.uv)' : 'textureSample(t, s, v.uv)'};
}`;

async function initGpu() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU unavailable in this page');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => window.host.send('page-log', `GPU error: ${e.error.message}`));
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const mk = (external) => {
    const module = device.createShaderModule({ code: BLIT_WGSL(external) });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  };
  const info = adapter.info || {};
  return {
    device,
    ctx,
    format,
    pipeTex: mk(false),
    pipeExt: route === 'C' ? mk(true) : null,
    sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    ubuf: device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    adapterInfo: { vendor: info.vendor, architecture: info.architecture, description: info.description },
  };
}

function letterbox(g, fw, fh) {
  const ca = canvas.width / canvas.height;
  const fa = fw / fh;
  const s = ca > fa ? [fa / ca, 1] : [1, ca / fa];
  g.device.queue.writeBuffer(g.ubuf, 0, new Float32Array([s[0], s[1], 0, 0]));
}

function draw(g, pipeline, bindGroup) {
  const enc = g.device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: g.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6);
  pass.end();
  g.device.queue.submit([enc.finish()]);
}

(async () => {
  let g = null;
  if (route !== 'B') {
    try {
      g = await initGpu();
    } catch (e) {
      window.host.send('page-log', String(e));
    }
  }
  const info = {
    route,
    rect: reportRect(),
    dpr: window.devicePixelRatio,
    webgpu: g ? g.adapterInfo : null,
    sharedTextureApi: !!window.host.sharedTexture,
  };

  if (route === 'A' && g) {
    let tex = null;
    let bind = null;
    let latest = null;
    let port = null;
    window.host.onFramePort((p) => {
      port = p;
      port.onmessage = (e) => {
        if (latest) pageDrops++;
        latest = e.data;
        latest.tPageRecv = epochUs();
      };
      port.start();
    });
    const frame = () => {
      requestAnimationFrame(frame);
      if (!latest) return;
      const { header: h, pixels } = latest;
      if (!tex || tex.width !== h.width || tex.height !== h.height) {
        tex?.destroy();
        tex = g.device.createTexture({ size: [h.width, h.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        bind = g.device.createBindGroup({
          layout: g.pipeTex.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: g.ubuf } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: g.sampler }],
        });
      }
      g.device.queue.writeTexture({ texture: tex }, pixels, { bytesPerRow: h.width * 4 }, [h.width, h.height]);
      letterbox(g, h.width, h.height);
      draw(g, g.pipeTex, bind);
      const tPresent = epochUs();
      lastLat = (tPresent - h.tRenderStartUs) / 1000;
      presented++;
      const rec = {
        f: h.frameIndex,
        tRenderStart: h.tRenderStartUs,
        tRenderDone: h.tRenderDoneUs,
        tSend: h.tSendUs,
        tMainRecv: h.tMainRecvUs,
        tMainPost: h.tMainPostUs,
        tPageRecv: latest.tPageRecv,
        tPresent,
        tCmd: h.tCmdUs,
      };
      latest = null;
      port.postMessage({ rec });
    };
    requestAnimationFrame(frame);
  }

  if (route === 'C' && g) {
    if (!window.host.sharedTexture) {
      window.host.send('page-log', `no sharedTexture in Electron ${window.host.electron}`);
    } else {
      // Arrivals bunch (two inside one vsync ~7×/s at 60-on-75 Hz), so keep a
      // 2-deep FIFO and present one per rAF; only a third arrival drops.
      const queue = [];
      window.host.sharedTexture.setReceiver(async (data, h) => {
        const tPageRecv = epochUs();
        if (queue.length >= 2) {
          const old = queue.shift();
          old.vf.close();
          old.imported.release();
          pageDrops++;
        }
        const imported = data.importedSharedTexture;
        queue.push({ imported, vf: imported.getVideoFrame(), h, tPageRecv });
      });
      const frame = () => {
        requestAnimationFrame(frame);
        if (!queue.length) return;
        const { imported, vf, h, tPageRecv } = queue.shift();
        const ext = g.device.importExternalTexture({ source: vf });
        const bind = g.device.createBindGroup({
          layout: g.pipeExt.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: g.ubuf } }, { binding: 1, resource: ext }, { binding: 2, resource: g.sampler }],
        });
        letterbox(g, h.width, h.height);
        draw(g, g.pipeExt, bind);
        const tPresent = epochUs();
        vf.close();
        imported.release();
        lastLat = (tPresent - h.tRenderStartUs) / 1000;
        presented++;
        window.host.send('frame-record', {
          f: h.frameIndex,
          tRenderStart: h.tRenderStartUs,
          tRenderDone: h.tRenderDoneUs,
          tSend: h.tSendUs,
          tMainRecv: h.tMainRecvUs,
          tMainPost: h.tMainPostUs,
          tPageRecv,
          tPresent,
          tCmd: h.tCmdUs,
        });
      };
      requestAnimationFrame(frame);
    }
  }

  window.host.send('page-ready', info);
})();
