/**
 * Raster cache-key cost — `npm run bench`, not the default `jest` run.
 *
 * `AppTextureProvider` signs every text and path layer it rasterises with a
 * string built from the layer's inputs — several `JSON.stringify` calls per
 * layer, per frame, whenever the `RasterReuse` fast path misses (any animated
 * property misses it). NATIVE_CORE_PLAN §4 T3 names this as the per-frame cost
 * to replace with a key memoised per node revision; this is the number that
 * change moves.
 *
 * The bench times ONLY the key construction (`textRasterSignature` /
 * `pathRasterSignature`, exported for this purpose) over the layers of a real
 * `buildSnapshot` of each scene, at a moving playhead. The snapshot build and
 * any rasterisation are outside the timed region.
 *
 *   text-200             200 text layers → the text signature
 *   animated-paths-300   300 bezier blobs with animated x + rotation → the
 *                        path signature (subpath points serialised by value)
 *   flat-shapes-1000     1000 primitive shapes → the path signature's cheap
 *                        case (no custom points), which is what a big flat
 *                        comp pays
 *
 * Reported as ms per frame for the whole layer set. jsdom + ts-jest inflate
 * string and JSON work; compare A/B on one machine or through `bench:check`.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { textRasterSignature, pathRasterSignature, type TextSpec } from '@core/rendering/AppTextureProvider';
import type { RenderLayer } from '@core/rendering/RenderBackend';
import { recordBench, type BenchMetricInput } from './benchRecord';
import { W, H, FPS, type Scene, type Stat, stats, texts, animatedPaths, flatShapes } from './benchScenes';

// Min over ROUNDS x RUNS pooled samples, for the reason buildSnapshot.bench.test.ts gives.
const WARMUP = 10;
const RUNS = 60;
const ROUNDS = 3;
/** A fixed resolution tier: the tier is an input to the key, not a cost. */
const TIER = 1;

/** The TextSpec MotionRendererBackend hands `setText` for a text layer. */
function textSpecOf(l: RenderLayer): TextSpec {
  return {
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
  } as TextSpec;
}

interface Result { id: string; layers: number; keyed: number; keyMs: Stat; bytesPerFrame: number; checksum: number }

function run(id: string, make: () => Scene): Result {
  const { graph, anim, layers } = make();
  const comp = { width: W, height: H, fps: FPS, background: '#101014', rootId: 'root' } as never;
  const keyMs: number[] = [];
  let keyed = 0;
  let bytes = 0;
  // Something observable, so the JIT cannot drop the key strings.
  let sink = 0;
  for (let i = 0; i < ROUNDS * (WARMUP + RUNS); i++) {
    const snap = buildSnapshot(graph, anim, (i / FPS) % 4, undefined, undefined, undefined, undefined, comp);
    const a = performance.now();
    let n = 0;
    let b = 0;
    for (const l of snap.layers) {
      let key: string;
      if (l.kind === 'text') key = textRasterSignature(textSpecOf(l), TIER);
      else key = pathRasterSignature(l, TIER);
      n += 1;
      b += key.length;
      sink ^= key.charCodeAt(key.length - 1);
    }
    const c = performance.now();
    if (i % (WARMUP + RUNS) >= WARMUP) keyMs.push(c - a);
    keyed = n;
    bytes = b;
  }
  return { id, layers, keyed, keyMs: stats(keyMs), bytesPerFrame: bytes, checksum: sink };
}

const results: Result[] = [];

describe('raster key cost', () => {
  const scenarios: Array<[string, () => Scene]> = [
    ['text-200', () => texts(200)],
    ['animated-paths-300', () => animatedPaths(300)],
    ['flat-shapes-1000', () => flatShapes(1000)],
  ];

  it.each(scenarios)('%s', (id, make) => {
    const r = run(id, make);
    results.push(r);
    expect(r.keyed).toBe(r.layers);
  });

  afterAll(() => {
    const lines = [
      `raster key bench — ${RUNS} runs after ${WARMUP} warm-ups, ms/frame for every layer's key`,
      `${'scenario'.padEnd(22)} ${'layers'.padStart(6)} │ ${'mean'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} │ ${'key bytes'.padStart(10)}`,
      ...results.map((r) => `${r.id.padEnd(22)} ${String(r.layers).padStart(6)} │ ${r.keyMs.mean.toFixed(3).padStart(8)} ${r.keyMs.p50.toFixed(3).padStart(8)} ${r.keyMs.p95.toFixed(3).padStart(8)} │ ${String(r.bytesPerFrame).padStart(10)}`),
    ];
    console.log(lines.join('\n'));

    const dir = join(process.cwd(), '.artifacts', 'bench');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rasterKey.latest.json'), JSON.stringify({ at: new Date().toISOString(), runs: RUNS, warmup: WARMUP, results }, null, 2));

    const metrics: BenchMetricInput[] = results.map((r) => ({
      name: `rasterKey/${r.id}`, metric: 'key.min', unit: 'ms', value: r.keyMs.min, samples: RUNS * ROUNDS,
    }));
    recordBench(metrics);
  });
});
