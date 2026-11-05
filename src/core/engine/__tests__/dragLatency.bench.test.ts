/**
 * A fast drag on a comp full of effects: the pointer moves every 8 ms (a 120 Hz
 * mouse) and each step goes to the engine as the page's GestureSession sends it
 * (at most three on the wire, latest wins). Reports the rate the picture
 * follows and each frame's render time, per preview
 * resolution, for the layer dragged being plain (`plain`) and carrying the same
 * effects as the rest (`fx`).
 *
 * This is the number Adaptive Resolution exists for: if Half holds the rate
 * where Full cannot, a heavy comp must drop to Half for the drag.
 *
 *   PREMATION_BENCH_LAYERS=<n>   effect layers (default 60)
 *   PREMATION_BENCH_FX=<a,b,c>   effects on each layer (default blur, glow, shadow)
 *   PREMATION_BENCH_SCALE=<pct>  layer scale (default 60)
 *   PREMATION_BENCH_DISTINCT=1   no two layers the same size
 *   PREMATION_BENCH_PLUGINS=<d>  plugin folder, for a plugin effect in PREMATION_BENCH_FX
 *
 * Run with the bench jest config — the default suite ignores `*.bench.test.ts`.
 */
import { ProcessEngineClient, secondsToFlicks, unwrap, type Command } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { recordBench } from '../../perf/bench/benchRecord';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

type FrameReady = Extract<EngineFrameMessage, { type: 'frameReady' }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], q: number): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]! : 0);
const r1 = (v: number): number => Number(v.toFixed(1));

const LAYERS = Number(process.env.PREMATION_BENCH_LAYERS ?? '60');
const STEP_MS = 8;
const STEPS = 240;
const EFFECTS = (process.env.PREMATION_BENCH_FX ?? 'gaussian-blur,glow,drop-shadow').split(',').filter(Boolean);
const SCALE = Number(process.env.PREMATION_BENCH_SCALE ?? '60');
/** Each layer a slightly different size: no two share a kept result (default: duplicates, which do). */
const DISTINCT = process.env.PREMATION_BENCH_DISTINCT === '1';
/** A folder of plugin bundles, for PREMATION_BENCH_FX to name a plugin's effect. */
const PLUGINS = process.env.PREMATION_BENCH_PLUGINS;

describe('fast drag on a comp full of effects', () => {
  it(`follows a 120 Hz pointer over ${LAYERS} effect layers`, async () => {
    if (!nativeEngineExe()) {
      console.log('[drag] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({ extraArgs: ['--log-level', 'warn', ...(PLUGINS ? ['--plugins', PLUGINS] : [])] });
    const client = new ProcessEngineClient(native.bridge);
    const seen: FrameReady[] = [];
    const arrivals: number[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      seen.push(m);
      arrivals.push(performance.now());
    });
    const metrics: Parameters<typeof recordBench>[0] = [];
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(2), width: 1920, height: 1080 } });
      await client.execute({ type: 'setActiveComposition', comp });
      const place = (x: number, y: number, scale = SCALE): { path: string; value: { kind: 'vec2'; value: { x: number; y: number } } }[] => [
        { path: 'transform/position', value: { kind: 'vec2', value: { x, y } } },
        { path: 'transform/scale', value: { kind: 'vec2', value: { x: scale, y: scale } } },
      ];
      const heavy: string[] = [];
      for (let i = 0; i < LAYERS; i++) {
        const layer = unwrap(await client.execute({
          type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`,
          init: place(100 + (i % 10) * 190, 100 + Math.floor(i / 10) * 170, DISTINCT ? SCALE + i : SCALE),
        })).layer;
        heavy.push(layer);
        for (const effect of EFFECTS) unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect, params: [] }));
      }
      const plain = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: 'plain', init: place(960, 540) })).layer;

      await client.execute({
        type: 'setViewport', viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
      });
      await sleep(1500);

      for (const resolution of ['full', 'half', 'quarter'] as const) {
        await client.execute({ type: 'setPreviewQuality', resolution, fastPreview: 'off', draft3d: false, motionBlur: false, adaptiveFloor: resolution });
        await sleep(800);
        for (const which of ['plain', 'fx'] as const) {
          const layer = which === 'plain' ? plain : heavy[Math.floor(LAYERS / 2)]!;
          unwrap(await client.beginGesture(`drag ${which}`));
          const flights = new Set<Promise<unknown>>();
          const rtt: number[] = [];
          let waiting: Command | null = null;
          const dispatch = (c: Command): void => {
            const at = performance.now();
            const f: Promise<unknown> = client.execute(c).then(() => {
              rtt.push(performance.now() - at);
              flights.delete(f);
              if (waiting) {
                const next = waiting;
                waiting = null;
                dispatch(next);
              }
            });
            flights.add(f);
          };
          seen.length = 0;
          arrivals.length = 0;
          const t0 = performance.now();
          for (let k = 0; k < STEPS; k++) {
            const a = (k / STEPS) * Math.PI * 8;
            const c: Command = { type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 960 + Math.cos(a) * 600, y: 540 + Math.sin(a) * 300 } } };
            if (flights.size >= 3) waiting = c;
            else dispatch(c);
            const due = t0 + (k + 1) * STEP_MS;
            const wait = due - performance.now();
            if (wait > 0) await sleep(wait);
          }
          const pointerS = (performance.now() - t0) / 1000;
          const inDrag = seen.length;
          while (flights.size > 0) await Promise.allSettled([...flights]);
          unwrap(await client.endGesture(0, true));
          const renderMs = seen.map((m) => (m.renderDoneUs - m.renderStartUs) / 1000);
          const row = {
            resolution, drag: which, fps: r1(inDrag / pointerS),
            renderP50Ms: r1(pct(renderMs, 0.5)), renderP95Ms: r1(pct(renderMs, 0.95)),
            commandP95Ms: r1(pct(rtt, 0.95)),
            worstGapMs: r1(arrivals.reduce((w, a, i) => (i > 0 ? Math.max(w, a - arrivals[i - 1]!) : w), 0)),
          };
          console.log('[drag] ' + JSON.stringify(row));
          metrics.push({ name: `dragLatency/${LAYERS}fx-1080p-${resolution}-${which}`, metric: 'render.p50', unit: 'ms', value: row.renderP50Ms, samples: renderMs.length });
          await sleep(500);
        }
      }
    } finally {
      await native.stop();
      if (metrics.length > 0) recordBench(metrics);
    }
  }, 300000);
});
