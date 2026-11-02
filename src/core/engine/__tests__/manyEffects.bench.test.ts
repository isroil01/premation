/**
 * "A lot of effects": STRESS_LAYERS animated layers (default 100) with
 * STRESS_FX effects each (default 10, a mix of the common AE blur / glow /
 * shadow / colour / distort / generate effects), played uncached on the GPU
 * engine. Reports what an editor feels:
 *
 * - edit: each addEffect command's round trip as the stack grows (the first
 *   and last hundred), and the whole build;
 * - play: frames shown in two seconds, the engine's own CPU build and GPU
 *   cost per frame, dropped frames;
 * - health: "engine busy" notices, restarts, engine RAM and GPU memory.
 *
 * Run with the bench jest config; needs the full engine (GPU).
 */
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};

const LAYERS = Number(process.env.STRESS_LAYERS ?? 100);
const FX = Number(process.env.STRESS_FX ?? 10);
/** Effects in the order a stack takes them (cycled). */
const MIX = [
  'gaussian-blur', 'glow', 'drop-shadow', 'levels', 'hue-saturation', 'directional-blur',
  'curves', 'tint', 'turbulent-displace', 'sharpen', 'vignette', 'exposure', 'bevel', 'noise',
  'color-balance', 'radial-blur', 'brightness-contrast', 'fill', 'fractal-noise', 'wave-warp',
];

describe('many effects', () => {
  it(`${LAYERS} layers × ${FX} effects: edit, play, stay alive`, async () => {
    if (!nativeEngineExe()) return;
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '0', '--log-level', process.env.STRESS_LOG ?? 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    const busy: Array<{ what: string; ms: number } | null> = [];
    let restarts = 0;
    native.supervisor.on('busy', (b: { what: string; ms: number } | null) => busy.push(b));
    native.supervisor.on('engine-restarted', () => { restarts++; });
    const frames: { frame: number; ms: number; dropped: number; at: number }[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      if (phase === 'playing') frames.push({ frame: m.frame, ms: (m.renderDoneUs - m.renderStartUs) / 1000, dropped: m.dropped, at: performance.now() });
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(3), width: 1920, height: 1080 } });
      await client.execute({ type: 'setActiveComposition', comp });
      const catalog = new Set(unwrap(await client.query({ type: 'listEffects', category: '' })).effects.map((e) => e.matchName));
      const mix = MIX.filter((t) => catalog.has(t));
      const missing = MIX.filter((t) => !catalog.has(t));
      if (missing.length) console.log(`[manyfx] not in the catalog: ${missing.join(', ')}`);

      const tBuild = performance.now();
      const layers: string[] = [];
      for (let i = 0; i < LAYERS; i++) {
        const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] })).layer;
        layers.push(layer);
        const cols = Math.ceil(Math.sqrt(LAYERS * 16 / 9));
        const x = 60 + (i % cols) * (1800 / cols);
        const y = 60 + Math.floor(i / cols) * (1000 / Math.ceil(LAYERS / cols));
        await client.execute({
          type: 'addKeyframes',
          keys: [
            { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(2), value: { kind: 'vec2', value: { x: x + 40, y: y + 25 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          ],
        });
      }
      // One addEffect per effect per layer, as the Effects panel sends them.
      const editMs: number[] = [];
      for (let k = 0; k < FX; k++) {
        for (let i = 0; i < LAYERS; i++) {
          const t0 = performance.now();
          const r = await client.execute({ type: 'addEffect', layers: [layers[i]!], effect: mix[(i + k) % mix.length]!, params: [] });
          editMs.push(performance.now() - t0);
          if (!r.ok) throw new Error(`addEffect: ${JSON.stringify(r)}`);
        }
      }
      const buildMs = performance.now() - tBuild;
      const first = editMs.slice(0, 100);
      const last = editMs.slice(-100);
      console.log('[manyfx] ' + JSON.stringify({
        layers: LAYERS, fxPerLayer: FX, effects: LAYERS * FX, buildS: Number((buildMs / 1000).toFixed(1)),
        addEffectFirst100: { p50: Number(pct(first, 0.5).toFixed(1)), p95: Number(pct(first, 0.95).toFixed(1)) },
        addEffectLast100: { p50: Number(pct(last, 0.5).toFixed(1)), p95: Number(pct(last, 0.95).toFixed(1)), max: Number(Math.max(...last).toFixed(1)) },
      }));

      await client.execute({
        type: 'setViewport', viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      for (const resolution of ['full', 'half'] as const) {
        await client.execute({ type: 'setPreviewQuality', resolution, fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: resolution });
        frames.length = 0;
        phase = 'starting';
        const t0 = performance.now();
        await client.execute({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(2) }, audio: false, cacheFirst: false, cacheOnly: false });
        const until = Date.now() + 180_000;
        while (phase !== 'stopped' && Date.now() < until) await sleep(50);
        const wallS = (performance.now() - t0) / 1000;
        const stats = unwrap(await client.query({ type: 'getRenderStats' }));
        console.log('[manyfx] ' + JSON.stringify({
          resolution,
          frames: frames.length,
          wallS: Number(wallS.toFixed(1)),
          fps: Number((frames.length / Math.max(0.001, wallS)).toFixed(1)),
          renderP50Ms: Number(pct(frames.map((f) => f.ms), 0.5).toFixed(1)),
          renderP95Ms: Number(pct(frames.map((f) => f.ms), 0.95).toFixed(1)),
          cpuFrameMs: Number(stats.cpuFrameMs.toFixed(1)),
          gpuFrameMs: Number(stats.gpuFrameMs.toFixed(1)),
          engineMB: Math.round((stats.engineMemoryBytes ?? 0) / 2 ** 20),
          gpuUsedMB: Math.round((stats.gpuMemoryUsed ?? 0) / 2 ** 20),
        }));
      }
      const busyNotices = busy.filter((b) => b !== null) as Array<{ what: string; ms: number }>;
      console.log('[manyfx] ' + JSON.stringify({
        busyNotices: busyNotices.length,
        longestBusy: busyNotices.reduce((m, b) => Math.max(m, b.ms), 0),
        busyWhat: [...new Set(busyNotices.map((b) => b.what))].slice(0, 5),
        restarts,
      }));
      expect(restarts).toBe(0);
    } finally {
      await native.stop();
    }
  }, 1_200_000);
});

/**
 * STRESS_SWEEP=1: each effect of the mix alone on STRESS_LAYERS layers, ten
 * frames at full resolution — which effects cost the frame.
 */
const sweep = process.env.STRESS_SWEEP === '1' ? describe : describe.skip;
sweep('many effects: cost per effect type', () => {
  it('ranks the mix', async () => {
    if (!nativeEngineExe()) return;
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '0', '--log-level', process.env.STRESS_LOG ?? 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    const frames: number[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      if (phase === 'playing') frames.push((m.renderDoneUs - m.renderStartUs) / 1000);
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    const rows: Array<{ effect: string; p50Ms: number; gpuMs: number; cpuMs: number }> = [];
    try {
      const catalog = new Set(unwrap(await client.query({ type: 'listEffects', category: '' })).effects.map((e) => e.matchName));
      // STRESS_ONLY=<effect>[,<effect>]: just those.
      const only = process.env.STRESS_ONLY?.split(',');
      for (const effect of ['none', ...MIX.filter((t) => catalog.has(t))].filter((t) => !only || only.includes(t))) {
        await client.execute({ type: 'newProject' });
        const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
        const comp = doc.comps[0]!.id;
        await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(3), width: 1920, height: 1080 } });
        await client.execute({ type: 'setActiveComposition', comp });
        const layers: string[] = [];
        const cols = Math.ceil(Math.sqrt(LAYERS * 16 / 9));
        for (let i = 0; i < LAYERS; i++) {
          const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] })).layer;
          layers.push(layer);
          const x = 60 + (i % cols) * (1800 / cols);
          const y = 60 + Math.floor(i / cols) * (1000 / Math.ceil(LAYERS / cols));
          await client.execute({
            type: 'addKeyframes',
            keys: [
              { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y } }, spatialIn: [], spatialOut: [], easing: 'linear' },
              { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(2), value: { kind: 'vec2', value: { x: x + 40, y: y + 25 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            ],
          });
        }
        if (effect !== 'none') await client.execute({ type: 'addEffect', layers, effect, params: [] });
        await client.execute({
          type: 'setViewport', viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
          pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
        });
        await client.execute({ type: 'setLoop', mode: 'once' });
        await client.execute({ type: 'setPreviewQuality', resolution: 'full', fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'full' });
        frames.length = 0;
        phase = 'starting';
        await client.execute({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(1 / 3) }, audio: false, cacheFirst: false, cacheOnly: false });
        const until = Date.now() + 120_000;
        while (phase !== 'stopped' && Date.now() < until) await sleep(20);
        const stats = unwrap(await client.query({ type: 'getRenderStats' }));
        rows.push({ effect, p50Ms: Number(pct(frames, 0.5).toFixed(1)), gpuMs: Number(stats.gpuFrameMs.toFixed(1)), cpuMs: Number(stats.cpuFrameMs.toFixed(1)) });
      }
      rows.sort((a, b) => b.p50Ms - a.p50Ms);
      for (const r of rows) console.log('[fxsweep] ' + JSON.stringify(r));
    } finally {
      await native.stop();
    }
  }, 1_200_000);
});
