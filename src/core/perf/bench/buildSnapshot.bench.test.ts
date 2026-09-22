/**
 * buildSnapshot / snapshotToFrameScene benchmarks — `npm run bench`.
 *
 * NOT part of the default `jest` run (jest.config.cjs ignores `*.bench.test.ts`).
 *
 * The scenes are the shapes the engine audit named as the expensive ones
 * (builders in ./benchScenes.ts):
 *
 *   flat-shapes-500      500 animated shape layers, every one a comp root —
 *   flat-shapes-1000     the ~0.45 ms/root case (docs/VIEWPORT_WORKER_PLAN.md
 *   flat-shapes-2000     §3); 500 and 2000 are the NATIVE_CORE_PLAN T0 sizes
 *   text-200             200 text layers
 *   animated-paths-300   300 bezier path layers with animated x + rotation
 *   deep-chains-1000x8   1000 layers in 125 parent chains of depth 8
 *   deep-chain-200x50    200 layers in 4 chains of depth 50
 *   precomps-50x20       50 moving sealed comp layers over 50 STATIC comps of
 *                        20 layers — the static sealed-precomp cache; run
 *                        beside a `cache-off` twin for an in-process A/B
 *   text-feed-200-paused 200 text layers redrawn at a fixed time, each fed to
 *                        AppTextureProvider.setText (NullBackend) — the raster
 *                        reuse fast path; beside a `reuse-off` twin
 *
 * Each scenario reports ms per frame (mean, p50, p95) for the scene walk
 * (`buildSnapshot`) and the renderer-scene flatten (`snapshotToFrameScene`)
 * separately, at a moving playhead so the animation samplers do real work.
 *
 * ## Reading the numbers
 *
 * jsdom + ts-jest inflates tight-loop costs (see repo conventions), so these
 * are NOT production milliseconds. They are for A/B on one machine: run once
 * before a change, once after, compare `.artifacts/bench/buildSnapshot.latest.json`
 * with the timestamped copy the earlier run left beside it — or let
 * `npm run bench:check` compare the min of each against `bench/baseline.json`.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ResourceManager, NullBackend } from '@motion/renderer';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { snapshotToFrameScene } from '@core/rendering/snapshotToFrameScene';
import { setStaticPrecompCacheEnabled } from '@core/rendering/staticPrecompCache';
import { AppTextureProvider } from '@core/rendering/AppTextureProvider';
import { gitCommit, recordBench, type BenchMetricInput } from './benchRecord';
import {
  W, H, FPS, type Scene, type Stat, stats,
  flatShapes, texts, animatedPaths, chains, staticPrecomps,
} from './benchScenes';

// The ratchet gates the MIN over ROUNDS × RUNS samples (see `Stat` in
// benchScenes.ts). Measured 2026-09-22 on one laptop shared with other
// sessions' jest/tsc runs: a 30-sample mean moved ±20–50 % between two runs
// of unchanged code, a 60-sample median ±30–90 %, and a 60-sample min still
// ±35 % on the scenarios that landed on a bad heap state — so each scenario
// samples three rounds, each with its own warm-up, and pools them.
const WARMUP = 10;
const RUNS = 60;
const ROUNDS = 3;

interface ScenarioResult {
  id: string;
  layers: number;
  snapshotLayers: number;
  buildSnapshotMs: Stat;
  flattenMs: Stat;
  /** Texture-feed time (text-feed scenarios only). */
  feedMs?: Stat;
}

function run(id: string, make: () => Scene, opts: { precompCache?: boolean } = {}): ScenarioResult {
  const { graph, anim, layers, comp: extra } = make();
  const comp = { width: W, height: H, fps: FPS, background: '#101014', rootId: 'root', ...extra } as never;
  const snapMs: number[] = [];
  const flatMs: number[] = [];
  let snapshotLayers = 0;
  setStaticPrecompCacheEnabled(opts.precompCache ?? true);
  try {
    for (let i = 0; i < ROUNDS * (WARMUP + RUNS); i++) {
      const t = (i / FPS) % 4;
      const a = performance.now();
      const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
      const b = performance.now();
      snapshotToFrameScene(snap);
      const c = performance.now();
      if (i % (WARMUP + RUNS) >= WARMUP) {
        snapMs.push(b - a);
        flatMs.push(c - b);
      }
      snapshotLayers = snap.layers.length;
    }
  } finally {
    setStaticPrecompCacheEnabled(true);
  }
  return { id, layers, snapshotLayers, buildSnapshotMs: stats(snapMs), flattenMs: stats(flatMs) };
}

/**
 * A PAUSED comp redrawn over and over (selection change, overlay toggle, a
 * panel resize): the snapshot is rebuilt at the same time and every text layer
 * is fed to the texture provider, exactly as MotionRendererBackend does — the
 * signature built, the raster cache hit. `reuse` passes the layer's content
 * hash, which lets an unchanged text skip rebuilding its signature
 * (AppTextureProvider `RasterReuse`); off is the pre-reuse path.
 */
function runTextFeed(id: string, n: number, reuse: boolean): ScenarioResult {
  const { graph, anim, layers } = texts(n);
  const comp = { width: W, height: H, fps: FPS, background: '#101014', rootId: 'root' } as never;
  const resources = new ResourceManager(new NullBackend());
  const provider = new AppTextureProvider(resources, {});
  const snapMs: number[] = [];
  const flatMs: number[] = [];
  const feedMs: number[] = [];
  let snapshotLayers = 0;
  for (let i = 0; i < ROUNDS * (WARMUP + RUNS); i++) {
    resources.beginFrame(i + 1);
    const a = performance.now();
    const snap = buildSnapshot(graph, anim, 1, undefined, undefined, undefined, undefined, comp);
    const b = performance.now();
    snapshotToFrameScene(snap);
    const c = performance.now();
    for (const l of snap.layers) {
      if (l.kind !== 'text') continue;
      provider.setText(`text:${l.id}`, {
        text: l.text ?? 'Text', fontSize: l.fontSize ?? 48, color: l.fill ?? '#ffffff',
        width: l.width, height: l.height, scaleX: l.scaleX, scaleY: l.scaleY,
        continuousRaster: l.continuousRaster, fontFamily: l.fontFamily, fontWeight: l.fontWeight,
        fontWidth: l.fontWidth, fontSlant: l.fontSlant, fontStyle: l.fontStyle, align: l.align,
        letterSpacing: l.letterSpacing, lineHeight: l.lineHeight, paragraphSpacing: l.paragraphSpacing,
        strokeOverFill: l.strokeOverFill, textTransform: l.textTransform, fontVariant: l.fontVariant,
        verticalAlign: l.verticalAlign, verticalScale: l.verticalScale, horizontalScale: l.horizontalScale,
        baselineShift: l.baselineShift, textStroke: l.textStroke, textStrokeWidth: l.textStrokeWidth,
        textExtras: l.textExtras, runs: l.runs, glyphs: l.glyphs, textPath: l.textPath, fontAxes: l.fontAxes,
        fillPaint: l.fillPaint && l.fillPaint.type !== 'solid' ? l.fillPaint : undefined,
        strokePaint: l.textStrokePaint, effects: l.effects, mask: l.mask,
      }, reuse ? l.contentHash : undefined);
    }
    const d = performance.now();
    if (i % (WARMUP + RUNS) >= WARMUP) {
      snapMs.push(b - a);
      flatMs.push(c - b);
      feedMs.push(d - c);
    }
    snapshotLayers = snap.layers.length;
  }
  return { id, layers, snapshotLayers, buildSnapshotMs: stats(snapMs), flattenMs: stats(flatMs), feedMs: stats(feedMs) };
}

const results: ScenarioResult[] = [];

describe('buildSnapshot bench', () => {
  const scenarios: Array<[string, () => Scene]> = [
    ['flat-shapes-500', () => flatShapes(500)],
    ['flat-shapes-1000', () => flatShapes(1000)],
    ['flat-shapes-2000', () => flatShapes(2000)],
    ['text-200', () => texts(200)],
    ['animated-paths-300', () => animatedPaths(300)],
    ['deep-chains-1000x8', () => chains(1000, 8)],
    ['deep-chain-200x50', () => chains(200, 50)],
  ];

  it.each(scenarios)('%s', (id, make) => {
    const r = run(id, make);
    results.push(r);
    // A sanity floor, not a threshold: the scene must actually have rendered.
    expect(r.snapshotLayers).toBeGreaterThan(0);
  });

  // In-run A/B pairs: the same scene with a cache off, so the comparison is
  // taken on one machine in one process rather than against an old JSON.
  it('precomps-50x20 (static precomp cache off / on)', () => {
    for (const [id, on] of [['precomps-50x20 cache-off', false], ['precomps-50x20', true]] as const) {
      const r = run(id, () => staticPrecomps(50, 20), { precompCache: on });
      results.push(r);
      expect(r.snapshotLayers).toBe(50);
    }
  });

  it('text-feed-200-paused (raster reuse off / on)', () => {
    for (const [id, on] of [['text-feed-200 reuse-off', false], ['text-feed-200-paused', true]] as const) {
      const r = runTextFeed(id, 200, on);
      results.push(r);
      expect(r.snapshotLayers).toBe(200);
    }
  });

  afterAll(() => {
    const f = (s: Stat): string => `${s.mean.toFixed(2).padStart(8)} ${s.p50.toFixed(2).padStart(8)} ${s.p95.toFixed(2).padStart(8)}`;
    const lines = [
      `buildSnapshot bench — ${RUNS} runs after ${WARMUP} warm-ups, ms/frame (jsdom: compare A/B only)`,
      `${'scenario'.padEnd(26)} ${'layers'.padStart(6)} │ ${'snap mean'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} │ ${'flat mean'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} │ ${'feed mean'.padStart(8)}`,
      ...results.map((r) => `${r.id.padEnd(26)} ${String(r.layers).padStart(6)} │ ${f(r.buildSnapshotMs)} │ ${f(r.flattenMs)} │ ${r.feedMs ? r.feedMs.mean.toFixed(2).padStart(8) : ''.padStart(8)}`),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    const out = {
      suite: 'buildSnapshot',
      at: new Date().toISOString(),
      rev: gitCommit(),
      node: process.version,
      runs: RUNS,
      warmup: WARMUP,
      results,
    };
    const dir = join(process.cwd(), '.artifacts', 'bench');
    mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(out, null, 2);
    writeFileSync(join(dir, 'buildSnapshot.latest.json'), json);
    writeFileSync(join(dir, `buildSnapshot.${out.at.replace(/[:.]/g, '-')}.json`), json);

    // The ratcheted headline: MIN ms per frame for the walk and the flatten
    // (mean/p50/p95 stay in the suite JSON; see `Stat` in benchScenes.ts for
    // why none of them is stable enough to gate on a shared machine).
    const metrics: BenchMetricInput[] = [];
    for (const r of results) {
      const name = `buildSnapshot/${r.id.replace(/\s+/g, '-')}`;
      metrics.push({ name, metric: 'buildSnapshot.min', unit: 'ms', value: r.buildSnapshotMs.min, samples: RUNS * ROUNDS });
      metrics.push({ name, metric: 'flatten.min', unit: 'ms', value: r.flattenMs.min, samples: RUNS * ROUNDS });
      if (r.feedMs) metrics.push({ name, metric: 'feed.min', unit: 'ms', value: r.feedMs.min, samples: RUNS * ROUNDS });
    }
    recordBench(metrics);
  });
});
