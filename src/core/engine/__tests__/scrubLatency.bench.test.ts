/**
 * Scrub latency (docs/AUDIT_2026-11-02_RENDER_SCENE.md item 14, "scrub path"):
 * a timeline drag through the page's real transport (engineTransport.ts —
 * the playback clock store → `seek` → the engine → FrameReady), on a 1080p
 * comp whose every frame is a fresh build (40 animated rectangles with
 * effects, never cached before the sweep).
 *
 *   drags     three; in each the playhead moves one frame per pointer step,
 *             a step every 8 ms (a 120 Hz pointer), 120 steps, after a pause
 *             long enough for the engine's idle prefetch to be at work. Per
 *             frame the engine shows: pointer step → that frame's FrameReady
 *             (`lag`); `first` is the drag's first shown frame, `settle` its
 *             last step → that frame; `shown` counts the steps that got a
 *             frame of their own; `seekRtt` is one seek's round trip.
 *   clicks    16 ruler clicks to far-apart frames, 150 ms apart: click → frame.
 *
 * Main's relay is not in this path (the harness bridge is the supervisor
 * itself); main only peeks bytes per request (engineHost.ts). Needs the full
 * engine (GPU). Run with the bench jest config (`npm run bench`).
 */

import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { useProjectStore } from '@stores/projectStore';
import { setTime } from '@stores/playbackClockStore';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { recordBench } from '../../perf/bench/benchRecord';
import { onSharedEngineFrames, sec, settleEdits, setupAppEngine, type Harness } from '../__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '../__testHelpers__/nativeEngine';

// hrtime / performance / Date real: the bench measures wall time.
jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate', 'hrtime', 'performance', 'Date'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const pct = (xs: number[], q: number): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]! : 0);
const r1 = (v: number): number => Number(v.toFixed(1));

const FPS = 30;
const LAYERS = 40;
const STEPS = 120;
const STEP_MS = 8;
const SCENARIO = 'scrubLatency/40fx-1080p';
const HEAVY_LAYERS = 1500;
const HEAVY_SCENARIO = `scrubLatency/${HEAVY_LAYERS}layers-idlePrefetch`;

/** Short hops to the next pointer step (one sleep of 8 ms can land 15.6 ms later on Windows). */
async function until(t: number): Promise<void> {
  while (now() < t) await sleep(0);
}

describe('scrub latency through the page transport', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('drags the playhead and clicks the ruler on a 40-layer effects comp', async () => {
    if (nativeEngineIsHeadless()) return;
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1920, height: 1080, frameRate: { num: FPS, den: 1 }, duration: sec(20) } } as Command);
    for (let i = 0; i < LAYERS; i++) {
      const layer = ((await h.run({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] } as Command)) as unknown as { layer: string }).layer;
      const x = 120 + (i % 10) * 180;
      const y = 160 + Math.floor(i / 10) * 220;
      await h.run({
        type: 'addKeyframes',
        keys: [
          { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          { prop: { layer, path: 'transform/position' }, time: sec(20), value: { kind: 'vec2', value: { x: x + 300, y: y + 200 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
        ],
      } as Command);
      await h.run({ type: 'addEffect', layers: [layer], effect: i % 2 === 0 ? 'gaussian-blur' : 'glow', params: [] } as Command);
    }
    await settleEdits();
    const actions = useProjectStore.getState().actions;
    actions.openTab(comp, [comp], 'Main');
    const tab = useProjectStore.getState().activeTabId!;

    const shownAt = new Map<number, number>();
    /** Per first-shown frame: render start / done (engine epoch µs) and arrival (epoch ms). */
    const stage = new Map<number, { startUs: number; doneUs: number; atEpoch: number }>();
    const off = onSharedEngineFrames((m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      if (!shownAt.has(m.frame)) {
        shownAt.set(m.frame, now());
        stage.set(m.frame, { startUs: m.renderStartUs, doneUs: m.renderDoneUs, atEpoch: Date.now() });
      }
    });
    const metrics: Parameters<typeof recordBench>[0] = [];
    try {
      const go = (frame: number): void => setTime(tab, frame / FPS, frame);
      // Park on frame 0 and let it draw.
      go(1);
      await sleep(200);
      go(0);
      await sleep(100);

      // ── the drags: three, each over frames never drawn, each after a pause
      // long enough for the engine's idle prefetch to be running (300 ms) ──
      const lag: number[] = [];
      const firstLag: number[] = [];
      const settle: number[] = [];
      const rtt: number[] = [];
      const toRender: number[] = [];
      const render: number[] = [];
      const toHost: number[] = [];
      let shown = 0;
      const execute = h.client.execute.bind(h.client);
      (h.client as { execute: typeof execute }).execute = (async (cmd: Command) => {
        if (cmd.type !== 'seek') return execute(cmd);
        const ts = now();
        const r = await execute(cmd);
        rtt.push(now() - ts);
        return r;
      }) as typeof execute;
      for (const start of [30, 200, 370]) {
        await sleep(500);
        shownAt.clear();
        stage.clear();
        const stepAt = new Map<number, number>();
        const stepEpoch = new Map<number, number>();
        const t0 = now();
        for (let k = 0; k < STEPS; k++) {
          await until(t0 + k * STEP_MS);
          stepAt.set(start + k, now());
          stepEpoch.set(start + k, Date.now());
          go(start + k);
        }
        const last = start + STEPS - 1;
        while (!shownAt.has(last) && now() - t0 < 30_000) await sleep(2);
        let first = true;
        for (const [f, at] of stepAt) {
          const s = shownAt.get(f);
          if (s === undefined) continue;
          lag.push(s - at);
          shown += 1;
          const st = stage.get(f)!;
          toRender.push(st.startUs / 1000 - stepEpoch.get(f)!);
          render.push((st.doneUs - st.startUs) / 1000);
          toHost.push(st.atEpoch - st.doneUs / 1000);
          if (first) firstLag.push(s - at);
          first = false;
        }
        settle.push((shownAt.get(last) ?? now()) - stepAt.get(last)!);
      }
      (h.client as { execute: typeof execute }).execute = execute;
      const drag = {
        steps: 3 * STEPS, shown,
        lagP50Ms: r1(pct(lag, 0.5)), lagP95Ms: r1(pct(lag, 0.95)),
        firstMs: firstLag.map(r1), settleMs: settle.map(r1),
        stepToRenderP50Ms: r1(pct(toRender, 0.5)), renderP50Ms: r1(pct(render, 0.5)), renderToHostP50Ms: r1(pct(toHost, 0.5)),
        seekRttP50Ms: r1(pct(rtt, 0.5)), seekRttP95Ms: r1(pct(rtt, 0.95)), seeks: rtt.length,
      };
      console.log(`[scrub] ${JSON.stringify({ what: 'drag', ...drag })}`);

      // ── the clicks: far-apart frames, a pause between ──
      await sleep(150);
      const clicks: number[] = [];
      let seed = 11;
      let prev = -1;
      for (let i = 0; i < 16; i++) {
        seed = (seed * 48271) % 2147483647;
        let f = 490 + (seed % 110);  // past every drag: not cached
        if (f === prev) f = f === 599 ? 490 : f + 1;  // the same frame again sends no seek
        prev = f;
        shownAt.delete(f);
        const tc = now();
        go(f);
        while (!shownAt.has(f) && now() - tc < 5000) await sleep(1);
        clicks.push(shownAt.get(f)! - tc);
        await sleep(150);
      }
      const click = { clicks: clicks.length, p50Ms: r1(pct(clicks, 0.5)), p95Ms: r1(pct(clicks, 0.95)) };
      console.log(`[scrub] ${JSON.stringify({ what: 'clicks', ...click })}`);
      expect(shown).toBeGreaterThan(0);
      metrics.push(
        { name: SCENARIO, metric: 'drag.lagP50', unit: 'ms', value: drag.lagP50Ms, samples: lag.length },
        { name: SCENARIO, metric: 'drag.lagP95', unit: 'ms', value: drag.lagP95Ms, samples: lag.length },
        { name: SCENARIO, metric: 'drag.firstMax', unit: 'ms', value: Math.max(...drag.firstMs), samples: firstLag.length },
        { name: SCENARIO, metric: 'drag.settleMax', unit: 'ms', value: Math.max(...drag.settleMs), samples: settle.length },
        { name: SCENARIO, metric: 'drag.seekRttP50', unit: 'ms', value: drag.seekRttP50Ms, samples: rtt.length },
        { name: SCENARIO, metric: 'drag.shown', unit: 'count', value: drag.shown, samples: 3 * STEPS },
        { name: SCENARIO, metric: 'click.p50', unit: 'ms', value: click.p50Ms, samples: clicks.length },
        { name: SCENARIO, metric: 'click.p95', unit: 'ms', value: click.p95Ms, samples: clicks.length },
      );
    } finally {
      off();
      if (metrics.length > 0) recordBench(metrics);
    }
  }, 300_000);

  // A build-bound comp (GPU-light): 1500 animated rectangles, a ~50–100 ms build per
  // frame. Each grab comes after a pause past the idle quiet period, so the engine's
  // render-ahead builds are in flight when the playhead moves: grab → that frame.
  it('grabs the playhead on a build-heavy comp while the idle prefetch runs', async () => {
    if (nativeEngineIsHeadless()) return;
    h = await setupAppEngine({ gpu: true });
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1920, height: 1080, frameRate: { num: FPS, den: 1 }, duration: sec(20) } } as Command);
    let layers: string[] = [];
    for (let i = 0; i < 100; i++) {
      const layer = ((await h.run({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] } as Command)) as unknown as { layer: string }).layer;
      const x = 80 + (i % 20) * 92;
      const y = 120 + Math.floor(i / 20) * 180;
      await h.run({
        type: 'addKeyframes',
        keys: [
          { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          { prop: { layer, path: 'transform/position' }, time: sec(20), value: { kind: 'vec2', value: { x: x + 200, y: y + 100 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
        ],
      } as Command);
      layers.push(layer);
    }
    while (layers.length < HEAVY_LAYERS) {
      const batch = layers.slice(0, Math.min(500, HEAVY_LAYERS - layers.length));
      layers = layers.concat(((await h.run({ type: 'duplicateLayers', layers: batch } as Command)) as unknown as { layers: string[] }).layers);
    }
    await settleEdits();
    useProjectStore.getState().actions.openTab(comp, [comp], 'Main');
    const tab = useProjectStore.getState().activeTabId!;
    const shownAt = new Map<number, number>();
    const off = onSharedEngineFrames((m: EngineFrameMessage) => {
      if (m.type === 'frameReady' && !shownAt.has(m.frame)) shownAt.set(m.frame, now());
    });
    const metrics: Parameters<typeof recordBench>[0] = [];
    try {
      const go = (frame: number): void => setTime(tab, frame / FPS, frame);
      go(1);
      await sleep(1500);
      const grabs: number[] = [];
      for (let i = 0; i < 12; i++) {
        await sleep(700);  // past the 300 ms quiet: render-ahead builds are running
        const f = 40 + i * 45;  // far from the last grab: never prefetched
        shownAt.delete(f);
        const tg = now();
        go(f);
        while (!shownAt.has(f) && now() - tg < 10_000) await sleep(1);
        grabs.push((shownAt.get(f) ?? now()) - tg);
      }
      const grab = { grabs: grabs.length, p50Ms: r1(pct(grabs, 0.5)), p95Ms: r1(pct(grabs, 0.95)), all: grabs.map(r1) };
      console.log(`[scrub] ${JSON.stringify({ what: 'heavy grabs', layers: layers.length, ...grab })}`);
      expect(grabs.length).toBe(12);
      metrics.push(
        { name: HEAVY_SCENARIO, metric: 'grab.p50', unit: 'ms', value: grab.p50Ms, samples: grabs.length },
        { name: HEAVY_SCENARIO, metric: 'grab.p95', unit: 'ms', value: grab.p95Ms, samples: grabs.length },
      );
    } finally {
      off();
      if (metrics.length > 0) recordBench(metrics);
    }
  }, 300_000);
});
