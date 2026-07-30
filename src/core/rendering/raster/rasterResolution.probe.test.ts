/**
 * PROBE: input scale → actual rasterized pixels.
 *
 * The measurement that decides what Continuous Rasterization has left to build.
 * `Canvas2DVectorRasterizer` passes `resolutionScale` STRAIGHT to the draw
 * (box × scale × supersample) while keying its cache on `resolutionTier(scale)`,
 * which clamps at 4 — so the drawn size and the cache identity may not agree.
 * Reading the code twice gave two different answers; this measures it.
 */

import { ResourceManager, NullBackend, resolutionTier } from '@motion/renderer';
import { Canvas2DVectorRasterizer } from './Canvas2DVectorRasterizer';

describe('PROBE: rasterized size vs requested scale', () => {
  let rasterizer: Canvas2DVectorRasterizer;

  beforeEach(() => {
    const backend = new NullBackend();
    const resources = new ResourceManager(backend);
    resources.beginFrame(1);
    rasterizer = new Canvas2DVectorRasterizer(resources);
  });

  /** Longest edge of the produced texture for a 100×100 box at `scale`. */
  const rasterAt = (scale: number, hash: string): number =>
    rasterizer.rasterize({
      drawable: { kind: 'shape', contentHash: hash, width: 100, height: 100, fill: '#f00' },
      resolutionScale: scale,
      padding: 0,
    }).texture.width;

  it('records the size produced at each scale', () => {
    // Distinct hashes so nothing is served from cache — one variable at a time.
    const rows = [0.5, 1, 2, 4, 6, 8, 16].map((s) => ({
      scale: s,
      px: rasterAt(s, `h${s}`),
      tier: resolutionTier(s),
    }));
    for (const r of rows) {
      console.log(`[probe] scale=${r.scale} → ${r.px}px  (resolutionTier says ${r.tier})`);
    }
    expect(rows.every((r) => r.px > 0)).toBe(true);
  });

  it('shows whether the CACHE KEY collapses distinct scales onto one texture', () => {
    // Same content hash, two scales above the 4× clamp. If the key is tiered,
    // the second is a HIT and silently reuses the first's pixel size.
    const first = rasterAt(6, 'shared');
    const before = rasterizer.stats();
    const second = rasterAt(12, 'shared');
    const after = rasterizer.stats();
    console.log(
      `[probe] scale 6 → ${first}px, then scale 12 → ${second}px; ` +
        `hits ${before.hits}→${after.hits}, misses ${before.misses}→${after.misses}`,
    );
    expect(second).toBeGreaterThan(0);
  });
});
