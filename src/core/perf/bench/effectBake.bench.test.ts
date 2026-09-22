/**
 * CPU effect-bake benchmarks — `npm run bench:all` (or `BENCH_FULL=1 npm run
 * bench -- effectBake`).
 *
 * NOT part of the default `jest` run (jest.config.cjs ignores `*.bench.test.ts`),
 * and NOT part of the default `npm run bench` either: ~170 effects at up to
 * 2.5 s each is about 15 minutes, and this is a ranking tool rather than one
 * of the ratcheted T0 metrics (jest.bench.config.cjs skips it unless
 * BENCH_FULL=1). Its five headline numbers still go to results.json when it
 * runs, so `bench:check` reports them as `n/a` on a default run rather than
 * failing.
 *
 * Times every effect the bake chain can draw (`hasCanvas2dImplementation`) on a
 * 1920×1080 layer, one effect per chain, through `applyEffectChain` — so the
 * number includes the full-frame getImageData/putImageData pair a pixel pass
 * pays, which is what the GPU texture provider actually spends per baked layer.
 * The canvas is jest.setup.ts's @napi-rs/canvas (Skia, CPU raster), so the
 * kernels run for real; jsdom's own canvas is not involved.
 *
 * Two populations are reported:
 *
 *   cpuOnly   in CANVAS2D_ONLY — these force the bake by type alone
 *   ported    have a shader, but still run here whenever a layer bakes for
 *             another reason (mask-scoped effect, Compositing opacity, fill
 *             opacity, a path-following effect, or a cpuOnly sibling)
 *
 * plus the worker-job overhead (`runBakeJob` copy-in/copy-out) and the
 * scenarios that drag ported effects onto the CPU.
 *
 * ## Reading the numbers
 *
 * ts-jest + Skia-in-Node are not Chromium; use these for RANKING and A/B on one
 * machine, not as production milliseconds. Results land in
 * `.artifacts/bench/effectBake.latest.json`.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Effect } from '@core/effects/effects';
import { EFFECT_DEFS, defaultParams } from '@core/effects/effects';
import { applyEffectChain } from '@core/effects/effectBake';
import { hasCanvas2dImplementation, isCanvas2dOnlyEffect } from '@core/effects/canvas2dEffects';
import { packMaskPaths } from '@core/effects/strokePaint';
import type { MaskPath } from '@core/effects/mask';
import { runBakeJob } from '@core/effects/bakeWorkerCore';
import { recordBench } from './benchRecord';

const W = 1920;
const H = 1080;
const BUDGET_MS = 2500;
const MAX_RUNS = 3;

jest.setTimeout(60 * 60 * 1000);

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** A plausible layer: a gradient card with a soft-edged disc and a hole. */
function sourceCanvas(): HTMLCanvasElement {
  const c = canvas(W, H);
  const x = c.getContext('2d')!;
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#ff5a36');
  g.addColorStop(0.5, '#2b7eff');
  g.addColorStop(1, '#19c37d');
  x.fillStyle = g;
  x.fillRect(260, 190, 1400, 700);
  x.globalCompositeOperation = 'destination-out';
  x.beginPath();
  x.arc(960, 540, 160, 0, Math.PI * 2);
  x.fill();
  x.globalCompositeOperation = 'source-over';
  x.fillStyle = 'rgba(255,255,255,0.6)';
  x.beginPath();
  x.arc(600, 400, 120, 0, Math.PI * 2);
  x.fill();
  return c;
}

const corner = (px: number, py: number): MaskPath['points'][number] => ({ x: px, y: py, inX: px, inY: py, outX: px, outY: py });
const MASK: MaskPath = {
  id: 'm1', mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false,
  points: [corner(-600, -300), corner(600, -300), corner(600, 300), corner(-600, 300)],
};

/** Params buildSnapshot RESOLVES per frame (audio, mask polylines) — synthetic here. */
function resolvedExtras(type: string): Record<string, unknown> {
  const packed = packMaskPaths([MASK]);
  switch (type) {
    case 'audio-spectrum':
      return { magnitudes: Array.from({ length: 128 }, (_, i) => 0.5 + 0.5 * Math.sin(i * 0.3)) };
    case 'audio-waveform':
      return { samples: Array.from({ length: 2048 }, (_, i) => Math.sin(i * 0.05)) };
    case 'path-stroke':
    case 'scribble':
      return { maskPathsMeta: packed.meta, maskPathsXY: packed.xy, pathMaskIndex: -1 };
    default:
      return {};
  }
}

function effectOf(type: string, over: Partial<Effect> = {}): Effect {
  const def = EFFECT_DEFS.find((d) => d.type === type)!;
  return { id: 'fx', type, params: { ...defaultParams(def), ...resolvedExtras(type) }, ...over } as Effect;
}

const scratch = (w: number, h: number): HTMLCanvasElement => canvas(w, h);

interface Row { type: string; cpuOnly: boolean; ms: number; runs: number }

function time(src: HTMLCanvasElement, work: HTMLCanvasElement, run: (ctx: CanvasRenderingContext2D) => void): { ms: number; runs: number } {
  const ctx = work.getContext('2d')!;
  const reset = (): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  };
  reset();
  run(ctx); // warm-up (JIT, pools)
  const samples: number[] = [];
  const t0 = performance.now();
  while (samples.length < MAX_RUNS && performance.now() - t0 < BUDGET_MS) {
    reset();
    const s = performance.now();
    run(ctx);
    samples.push(performance.now() - s);
  }
  samples.sort((a, b) => a - b);
  return { ms: samples[samples.length >> 1] ?? 0, runs: samples.length };
}

describe('effect bake cost @1920×1080', () => {
  it('times every bake-drawable effect, the transfer floor, and the worker job', () => {
    const src = sourceCanvas();
    const work = canvas(W, H);
    const rows: Row[] = [];

    const floor = time(src, work, (ctx) => {
      const img = ctx.getImageData(0, 0, W, H);
      ctx.putImageData(img, 0, 0);
    });

    for (const def of EFFECT_DEFS) {
      if (!hasCanvas2dImplementation(def.type)) continue;
      const e = effectOf(def.type);
      try {
        const t = time(src, work, (ctx) => applyEffectChain(ctx, W, H, [e], scratch));
        rows.push({ type: def.type, cpuOnly: isCanvas2dOnlyEffect(def.type), ...t });
      } catch (err) {
        rows.push({ type: `${def.type} (threw: ${String(err).slice(0, 40)})`, cpuOnly: isCanvas2dOnlyEffect(def.type), ms: -1, runs: 0 });
      }
    }
    rows.sort((a, b) => b.ms - a.ms);

    // Scenarios: a ported effect dragged to the CPU by its compositing options.
    const scenarios: Array<{ name: string; ms: number }> = [];
    const blurOpacity = effectOf('gaussian-blur', { opacity: 50 });
    scenarios.push({ name: 'gaussian-blur @ opacity 50', ms: time(src, work, (ctx) => applyEffectChain(ctx, W, H, [blurOpacity], scratch)).ms });
    const bevelOpacity = effectOf('bevel', { opacity: 50 });
    scenarios.push({ name: 'bevel @ opacity 50', ms: time(src, work, (ctx) => applyEffectChain(ctx, W, H, [bevelOpacity], scratch)).ms });
    const blurPlain = effectOf('gaussian-blur');
    scenarios.push({ name: 'gaussian-blur (plain)', ms: time(src, work, (ctx) => applyEffectChain(ctx, W, H, [blurPlain], scratch)).ms });

    // Worker job overhead on the same chain: copy-in + chain + copy-out.
    const input = src.getContext('2d')!.getImageData(0, 0, W, H);
    const jobT0 = performance.now();
    for (let i = 0; i < 3; i++) {
      runBakeJob(
        { w: W, h: H, pixels: new Uint8ClampedArray(input.data), effects: [blurPlain], fillOpacity: 1 },
        scratch,
      );
    }
    const jobMs = (performance.now() - jobT0) / 3;

    // eslint-disable-next-line no-console
    console.table(rows.map((r) => ({ effect: r.type, cpuOnly: r.cpuOnly ? 'yes' : '', ms: +r.ms.toFixed(1), runs: r.runs })));
    // eslint-disable-next-line no-console
    console.log(`transfer floor (get+put 1080p): ${floor.ms.toFixed(1)} ms`);
    // eslint-disable-next-line no-console
    console.table(scenarios.map((s) => ({ scenario: s.name, ms: +s.ms.toFixed(1) })));
    // eslint-disable-next-line no-console
    console.log(`runBakeJob(gaussian-blur) incl. copies: ${jobMs.toFixed(1)} ms`);

    const dir = join(process.cwd(), '.artifacts', 'bench');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'effectBake.latest.json'),
      JSON.stringify({ at: new Date().toISOString(), w: W, h: H, floorMs: floor.ms, jobMs, rows, scenarios }, null, 2),
    );
    // The ratcheted headline: the transfer floor, the worker job, and the three
    // scenarios. The ~200 per-effect rows stay in the suite JSON only — Skia
    // medians of 3 runs are too noisy to gate one by one at 10 %.
    recordBench([
      { name: 'effectBake/transfer-floor-1080p', metric: 'get+put.median', unit: 'ms', value: floor.ms, samples: floor.runs },
      { name: 'effectBake/runBakeJob-gaussian-blur', metric: 'job.mean', unit: 'ms', value: jobMs, samples: 3 },
      ...scenarios.map((s) => ({
        name: `effectBake/${s.name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`,
        metric: 'chain.median' as const, unit: 'ms' as const, value: s.ms, samples: MAX_RUNS,
      })),
    ]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
