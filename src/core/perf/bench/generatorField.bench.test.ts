/**
 * Plugin generator layers — `npm run bench`, not the default `jest` run.
 *
 * ## What this measures, and what it cannot
 *
 * Everything on the HOST's side of a generator frame at 50 000 instances: the
 * contract validation, the bounds measurement, the scene flatten, and the whole
 * renderer walk down to the draw call. Those are the costs that scale with the
 * particle count on the CPU, and they are the ones a regression would land in.
 *
 * It does NOT measure fill rate. There is no GPU here — the renderer runs
 * against `NullBackend` — so the one number this cannot produce is how long the
 * driver takes to rasterise 50 000 blended quads at 1080p. What it CAN prove
 * about the GPU side is the shape of the submission, which is what decides
 * whether the fill rate is ever reached: one draw call and one buffer upload,
 * asserted in `packages/renderer/src/__tests__/generatorInstancing.test.ts`.
 *
 * jsdom + ts-jest inflates tight loops (see repo conventions), so these are
 * A/B numbers for one machine, not production milliseconds. The per-instance
 * loops here are the worst case for that: measured 2026-09-16, the bounds pass
 * over 50 000 instances reads 27 ms under this harness and **0.36 ms** in plain
 * V8 — a 75× gap, because the loop is four global lookups (`Number.isFinite`,
 * `Math.abs`) per instance and jest makes each of those ~120 ns instead of ~1.
 * Re-measure a regression in plain Node before believing a number from here.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { NullBackend, Renderer } from '@motion/renderer';
import { GEN_STRIDE, measureInstanceBounds, validateGeneratorFrame } from '@core/plugins/generator';
import { snapshotToFrameScene } from '@core/rendering/snapshotToFrameScene';
import type { RenderLayer, RenderSnapshot } from '@core/rendering/RenderBackend';
import { recordBench, type BenchMetricInput } from './benchRecord';

const W = 1920;
const H = 1080;
const WARMUP = 3;
const RUNS = 20;
const COUNTS = [10_000, 50_000];

const LAYER = { width: 800, height: 600 };

/** A plausible frame: a spiral, so no two instances share a position. */
function field(count: number): Float32Array {
  const out = new Float32Array(count * GEN_STRIDE);
  for (let i = 0; i < count; i++) {
    const o = i * GEN_STRIDE;
    const a = i * 0.13;
    const r = 2 + i * 0.006;
    out[o] = Math.cos(a) * r;
    out[o + 1] = Math.sin(a) * r;
    out[o + 2] = (i % 400) - 200;
    out[o + 3] = 3 + (i % 7);
    out[o + 4] = a;
    out[o + 5] = 1;
    out[o + 6] = 0.6;
    out[o + 7] = 0.2;
    out[o + 8] = 1;
  }
  return out;
}

function stats(samples: number[]): { mean: number; p50: number; p95: number; min: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return {
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: at(0.5),
    p95: at(0.95),
    // What the ratchet gates — see `Stat` in benchScenes.ts.
    min: sorted[0] ?? 0,
  };
}

function timed(fn: () => void): number[] {
  for (let i = 0; i < WARMUP; i++) fn();
  const out: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

describe('generator field', () => {
  const results: Record<string, unknown> = {};

  for (const count of COUNTS) {
    const instances = field(count);
    const raw = { instances, count, primitive: 'point' as const };

    it(`validates ${count} instances`, () => {
      const s = stats(timed(() => { validateGeneratorFrame(raw, 1, LAYER); }));
      results[`validate-${count}`] = s;
      // eslint-disable-next-line no-console
      console.log(`validate ${count}: mean ${s.mean.toFixed(2)} ms  p95 ${s.p95.toFixed(2)} ms`);
    });

    it(`measures bounds for ${count} instances`, () => {
      const s = stats(timed(() => { measureInstanceBounds(instances, count, GEN_STRIDE, LAYER); }));
      results[`bounds-${count}`] = s;
      // eslint-disable-next-line no-console
      console.log(`bounds ${count}: mean ${s.mean.toFixed(2)} ms  p95 ${s.p95.toFixed(2)} ms`);
    });

    it(`flattens and renders a ${count}-instance layer`, async () => {
      const validated = validateGeneratorFrame(raw, 1, LAYER);
      if ('error' in validated) throw new Error(validated.error);
      const layer: RenderLayer = {
        id: 'g1', kind: 'shape', x: W / 2, y: H / 2, rotation: 0, scaleX: 1, scaleY: 1,
        opacity: 1, width: LAYER.width, height: LAYER.height, fill: '#000', visible: true,
        generator: validated.frame,
      };
      const snap = { width: W, height: H, background: '#101014', layers: [layer] } as RenderSnapshot;

      const flatten = stats(timed(() => { snapshotToFrameScene(snap); }));
      results[`flatten-${count}`] = flatten;

      const backend = new NullBackend();
      const renderer = new Renderer({ backend, now: () => 16 });
      await renderer.initialize();
      const vp = renderer.createViewport({ width: W, height: H, overlays: { grid: false, checkerboard: false } });
      vp.camera.setState({ center: { x: W / 2, y: H / 2 }, zoom: 1 });
      const scene = snapshotToFrameScene(snap);
      // The steady state a paused viewport is in: the same revision every
      // frame, so the instance upload happens once and never again.
      const render = stats(timed(() => { renderer.render(vp, scene); }));
      results[`render-${count}`] = render;
      results[`draws-${count}`] = backend.draws.filter((d) => d.pass === 'generator-field').length;

      // eslint-disable-next-line no-console
      console.log(
        `flatten ${count}: mean ${flatten.mean.toFixed(2)} ms  |  render ${count}: `
        + `mean ${render.mean.toFixed(2)} ms  p95 ${render.p95.toFixed(2)} ms`,
      );
      // One instanced draw per rendered frame — the claim the fill rate rests on.
      expect(backend.draws.filter((d) => d.pass === 'generator-field').every((d) => d.instanceCount === count)).toBe(true);
    });
  }

  afterAll(() => {
    const dir = join(process.cwd(), '.artifacts', 'bench');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'generatorField.latest.json'), JSON.stringify(results, null, 2));

    // The ratcheted headline: MIN ms of each stage per instance count (mean,
    // p50 and p95 stay in the suite JSON).
    const metrics: BenchMetricInput[] = [];
    for (const count of COUNTS) {
      for (const stage of ['validate', 'bounds', 'flatten', 'render'] as const) {
        const s = results[`${stage}-${count}`] as { min: number } | undefined;
        if (s) metrics.push({ name: `generatorField/${count}`, metric: `${stage}.min`, unit: 'ms', value: s.min, samples: RUNS });
      }
    }
    recordBench(metrics);
  });
});
