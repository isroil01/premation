/**
 * Continuous Rasterization, measured where it counts: the RESOLUTION of the
 * texture the layer actually gets.
 *
 * The brief's requirement is that a layer scaled up produces a bigger raster
 * rather than a magnified small one. That is quantifiable, so this asserts the
 * texture dimensions instead of diffing pixels — and it asserts them decomposed:
 * scale alone, then the switch alone, then each bound alone.
 *
 * The regression guard that matters most is `CR OFF is unchanged BELOW THE
 * CEILING`. Every existing project has no `continuousRasterize` prop, and for
 * the scales almost every layer actually lives at it must take exactly the code
 * path it took before this feature existed.
 *
 * ABOVE 4x that guarantee was deliberately given up. The clamped ladder stopped
 * climbing there and magnified instead, which is the softening reported on
 * titles and logos scaled past 400% — in exports as much as in the preview.
 * `tierFor` now escalates onto the bounded extended ladder regardless of the
 * switch, so those layers render sharp by default. An existing project holding
 * a layer past 4x DOES render differently than before: sharper, and costing
 * more VRAM. That was the accepted trade.
 */

import { ResourceManager, NullBackend } from '@motion/renderer';
import { AppTextureProvider } from './AppTextureProvider';
import type { RenderLayer } from './RenderBackend';

/**
 * A provider plus a record of every raster texture it ALLOCATES.
 *
 * `TextureHandle` is opaque, so the observable fact is the descriptor handed to
 * `ResourceManager.texture` — which is also the thing that costs VRAM, making it
 * the right quantity to assert. Captured by spy rather than by adding a
 * production accessor nothing but a test would read.
 */
function provider(): { p: AppTextureProvider; sizes: () => number[] } {
  const backend = new NullBackend();
  const r = new ResourceManager(backend);
  r.beginFrame(1);
  const seen: number[] = [];
  const real = r.texture.bind(r);
  jest.spyOn(r, 'texture').mockImplementation(((key: string, desc: { width: number; height: number }, ...rest: unknown[]) => {
    if (typeof key === 'string' && key.startsWith('raster:')) seen.push(Math.max(desc.width, desc.height));
    return (real as unknown as (...a: unknown[]) => unknown)(key, desc, ...rest);
  }) as never);
  return { p: new AppTextureProvider(r), sizes: () => seen };
}

/** A vector path layer — real geometry, so CR is meaningful for it. */
function pathLayer(over: Partial<RenderLayer> = {}): RenderLayer {
  return {
    id: 'p1',
    kind: 'shape',
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1,
    width: 100, height: 100,
    fill: '#ff0000',
    contentHash: 'cr-test',
    primitive: 'path',
    // CENTRED local space (−w/2..w/2), which is what `shapeOutline` emits and
    // what every real path carries. These were 0..100, i.e. a box-sized
    // triangle sitting entirely in the lower-right quadrant — harmless while
    // padding ignored the path, but it reads as 50px of escape now that padding
    // measures how far the geometry leaves the box, and inflated every texture
    // in this file.
    pathPoints: [
      { x: -50, y: -50, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 50, y: -50, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 0, y: 50, inX: 0, inY: 0, outX: 0, outY: 0 },
    ],
    ...over,
  } as unknown as RenderLayer;
}

/** Longest edge of the last raster texture allocated. */
function lastPx(h: { sizes: () => number[] }): number {
  const s = h.sizes();
  return s.length ? s[s.length - 1]! : 0;
}

describe('CR ON: the raster resolution follows the scale', () => {
  it('RE-RASTERS when the scale crosses a tier — with or without the switch', () => {
    // OFF used to go STALE here: scale 6 and scale 12 both clamped to tier 4,
    // shared one cache key, and the second came back a hit reusing the first
    // texture — so zooming in stopped sharpening and stayed soft. Past the 4x
    // ceiling the tier now escalates for OFF too, so each scale gets its own
    // key and its own texture. This assertion is inverted from what it was,
    // deliberately: the staleness it used to pin is the bug that was fixed.
    const off = provider();
    off.p.setRasterScale(1);
    off.p.setPath('path:a', pathLayer({ scaleX: 6, scaleY: 6, contentHash: 'stale' }));
    const offFirst = lastPx(off);
    off.p.setPath('path:a', pathLayer({ scaleX: 12, scaleY: 12, contentHash: 'stale' }));
    expect(lastPx(off)).toBeGreaterThan(offFirst);
    expect(lastPx(off) / offFirst).toBeCloseTo(2, 1);

    // ON: tier 8 then tier 16 are different keys, so the zoom re-rasters.
    const on = provider();
    on.p.setRasterScale(1);
    on.p.setPath('path:a', pathLayer({ scaleX: 6, scaleY: 6, continuousRaster: true, contentHash: 'fresh' }));
    const onFirst = lastPx(on);
    on.p.setPath('path:a', pathLayer({ scaleX: 12, scaleY: 12, continuousRaster: true, contentHash: 'fresh' }));
    expect(lastPx(on)).toBeGreaterThan(onFirst);
    expect(lastPx(on) / onFirst).toBeCloseTo(2, 1);
  });

  it('doubling the scale doubles the raster, up the ladder', () => {
    const sizes = [4, 8, 16].map((s) => {
      const h = provider();
      const p = h.p;
      p.setRasterScale(1);
      p.setPath('path:a', pathLayer({ scaleX: s, scaleY: s, continuousRaster: true, contentHash: `s${s}` }));
      return lastPx(h);
    });
    expect(sizes[1]! / sizes[0]!).toBeCloseTo(2, 1);
    expect(sizes[2]! / sizes[1]!).toBeCloseTo(2, 1);
  });

  it('3D camera magnification drives it too — sx is decomposed from the PROJECTED matrix', () => {
    // buildSnapshot hands a 3D layer an sx that already includes the perspective
    // divide (see rasterScale.probe.test.ts), so CR needs nothing extra for 3D:
    // a larger sx is a larger raster, whatever produced it.
    const near = provider();
    near.p.setRasterScale(1);
    near.p.setPath('path:a', pathLayer({ scaleX: 6, scaleY: 6, continuousRaster: true, contentHash: 'near' }));

    const far = provider();
    far.p.setRasterScale(1);
    far.p.setPath('path:a', pathLayer({ scaleX: 1, scaleY: 1, continuousRaster: true, contentHash: 'far' }));

    expect(lastPx(near)).toBeGreaterThan(lastPx(far));
  });

  it('viewport zoom composes with layer scale', () => {
    const h = provider();
      const p = h.p;
    p.setRasterScale(4); // zoomed in 4x
    p.setPath('path:a', pathLayer({ scaleX: 4, scaleY: 4, continuousRaster: true, contentHash: 'zoom' }));
    // effectiveScale 16 → tier 16 for a 100px box (well inside both bounds).
    expect(lastPx(h)).toBe(100 * 16 * 2); // ×2 supersample
  });
});

describe('CR OFF: bounded and deterministic, drawn at the tier it is keyed on', () => {
  it('produces the same texture size with the flag absent as with it false', () => {
    const a = provider();
    a.p.setRasterScale(1);
    a.p.setPath('path:a', pathLayer({ scaleX: 8, scaleY: 8, contentHash: 'x' }));

    const b = provider();
    b.p.setRasterScale(1);
    b.p.setPath('path:a', pathLayer({ scaleX: 8, scaleY: 8, continuousRaster: false, contentHash: 'x' }));

    expect(lastPx(a)).toBe(lastPx(b));
  });

  it('draws at the TIER, so the pixels and the cache key are the same number', () => {
    // OFF used to draw at the raw scale while keying on the 4x-clamped tier.
    // That was sharp above 4x but ORDER-DEPENDENT — one key served every scale
    // past the ceiling, so whichever rasterized first was reused for all of
    // them, and below the ceiling a scale animation stretched one texture
    // across a whole tier and snapped at each boundary. Drawing at the tier
    // makes the two agree: bounded, deterministic and never magnified.
    const h = provider();
    h.p.setRasterScale(1);
    h.p.setPath('path:a', pathLayer({ scaleX: 16, scaleY: 16, contentHash: 'raw' }));
    expect(lastPx(h)).toBe(100 * 16 * 2); // tier 16 (escalated) x2 supersample
  });

  it('below the ceiling the tier rounds UP, so the raster is never magnified', () => {
    const h = provider();
    h.p.setRasterScale(1);
    h.p.setPath('path:a', pathLayer({ scaleX: 3, scaleY: 3, contentHash: 'up' }));
    expect(lastPx(h)).toBe(100 * 4 * 2); // tier 4 for a requested 3
  });

  it('below the ceiling it takes the CLAMPED ladder verbatim, box bounds and all', () => {
    // The escalation must not leak downwards. The extended ladder also applies
    // the pixel budget, which rounds a very large box DOWN — so a box the old
    // path happily rasterized at tier 4 must still get tier 4, or the fix for
    // big scales becomes a regression for big boxes. 2048 at tier 4 is 8192px,
    // past the 16M pixel budget; the clamped path does not consult it.
    //
    // Asserted as a floor rather than an equality because the supersample
    // factor is itself size-dependent (it drops to 1 on a box this large), and
    // the claim under test is about the TIER, not about supersampling.
    const h = provider();
    h.p.setRasterScale(1);
    h.p.setPath('path:a', pathLayer({ width: 2048, height: 2048, scaleX: 4, scaleY: 4, contentHash: 'wide' }));
    expect(lastPx(h)).toBeGreaterThanOrEqual(2048 * 4);
  });

  it('past the ceiling it IS bounded by the max-dimension report', () => {
    // The mirror of the test above: once escalated, the bounds that keep CR
    // from allocating past the GPU's limit apply to the default path too. That
    // is precisely what makes escalating safe to do without a switch.
    const h = provider();
    h.p.setRasterScale(1);
    h.p.setMaxRasterDimension(2048);
    h.p.setPath('path:a', pathLayer({ width: 500, height: 500, scaleX: 16, scaleY: 16, contentHash: 'd' }));
    expect(lastPx(h)).toBeLessThanOrEqual(2048 * 2);
  });
});

describe('CR ON stays inside its bounds', () => {
  it('past the old ceiling the SWITCH no longer changes the result — both are sharp', () => {
    // The switch used to be the only way past 4x, which meant the DEFAULT
    // experience was the soft one and a user had to know the switch existed to
    // get a sharp title. Escalation applies to both paths now, so ON and OFF
    // land on the same rung. The switch is kept — it is the AE-parity control,
    // and below the ceiling it still opts into the extended ladder's box
    // bounds — but it is no longer what rescues a scaled-up layer.
    const on = provider();
    on.p.setRasterScale(1);
    on.p.setPath('path:a', pathLayer({ scaleX: 16, scaleY: 16, continuousRaster: true, contentHash: 'q' }));

    const off = provider();
    off.p.setRasterScale(1);
    off.p.setPath('path:a', pathLayer({ scaleX: 16, scaleY: 16, contentHash: 'q' }));

    expect(lastPx(on)).toBe(100 * 16 * 2); // the ladder keeps up
    expect(lastPx(off)).toBe(100 * 16 * 2); // and now so does the default
  });

  it('between tiers, ON rounds UP — never softer than OFF', () => {
    const on = provider();
    on.p.setRasterScale(1);
    on.p.setPath('path:a', pathLayer({ scaleX: 6, scaleY: 6, continuousRaster: true, contentHash: 'r' }));

    const off = provider();
    off.p.setRasterScale(1);
    off.p.setPath('path:a', pathLayer({ scaleX: 6, scaleY: 6, contentHash: 'r' }));

    expect(lastPx(on)).toBeGreaterThanOrEqual(lastPx(off));
    expect(lastPx(on)).toBe(100 * 8 * 2); // tier 8, not raw 6
  });

  it('a low max texture dimension clamps it rather than allocating past the limit', () => {
    const h = provider();
      const p = h.p;
    p.setRasterScale(1);
    p.setMaxRasterDimension(4096);
    // 500px box at 16x would be 8000px — over the reported limit.
    p.setPath('path:a', pathLayer({ width: 500, height: 500, scaleX: 16, scaleY: 16, continuousRaster: true, contentHash: 'lim' }));
    // The supersample doubles it again, so the tier itself must have been
    // clamped well below 16; what matters is that the tier respected the limit.
    expect(lastPx(h)).toBeLessThanOrEqual(4096 * 2);
  });

  it('a huge box does not blow the pixel budget', () => {
    const h = provider();
      const p = h.p;
    p.setRasterScale(1);
    p.setPath('path:a', pathLayer({ width: 2048, height: 2048, scaleX: 32, scaleY: 32, continuousRaster: true, contentHash: 'big' }));
    const px = lastPx(h);
    // Without the budget this would ask for 2048×32 = 65536px on a side.
    expect(px).toBeLessThanOrEqual(8192);
  });

  it('a degenerate zero-size box does not produce a zero texture', () => {
    const h = provider();
      const p = h.p;
    p.setRasterScale(1);
    p.setPath('path:a', pathLayer({ width: 0, height: 0, scaleX: 8, scaleY: 8, continuousRaster: true, contentHash: 'zero' }));
    expect(lastPx(h)).toBeGreaterThan(0);
  });
});

describe('text takes the same path as shapes', () => {
  const textSpec = (over: Record<string, unknown> = {}) => ({
    text: 'Sharp',
    fontSize: 48,
    color: '#fff',
    width: 200,
    height: 60,
    ...over,
  });

  it('text re-rasters across a tier crossing too', () => {
    const on = provider();
    on.p.setRasterScale(1);
    on.p.setText('text:t', textSpec({ scaleX: 6, scaleY: 6, continuousRaster: true }) as never);
    const first = lastPx(on);
    on.p.setText('text:t', textSpec({ scaleX: 12, scaleY: 12, continuousRaster: true }) as never);
    expect(lastPx(on)).toBeGreaterThan(first);
  });

  it('text between tiers rounds UP, never softer than OFF', () => {
    const on = provider();
    on.p.setRasterScale(1);
    on.p.setText('text:t', textSpec({ scaleX: 6, scaleY: 6, continuousRaster: true }) as never);
    const off = provider();
    off.p.setRasterScale(1);
    off.p.setText('text:t', textSpec({ scaleX: 6, scaleY: 6 }) as never);
    expect(lastPx(on)).toBeGreaterThanOrEqual(lastPx(off));
  });

  it('text with CR off is identical to before', () => {
    const a = provider();
    a.p.setRasterScale(1);
    a.p.setText('text:t', textSpec({ scaleX: 8, scaleY: 8 }) as never);
    const b = provider();
    b.p.setRasterScale(1);
    b.p.setText('text:t', textSpec({ scaleX: 8, scaleY: 8, continuousRaster: false }) as never);
    expect(lastPx(a)).toBe(lastPx(b));
  });
});
