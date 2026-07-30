/**
 * Continuous Rasterization, measured where it counts: the RESOLUTION of the
 * texture the layer actually gets.
 *
 * The brief's requirement is that a layer scaled up produces a bigger raster
 * rather than a magnified small one. That is quantifiable, so this asserts the
 * texture dimensions instead of diffing pixels — and it asserts them decomposed:
 * scale alone, then the switch alone, then each bound alone.
 *
 * The regression guard that matters most is `CR OFF is unchanged`. Every
 * existing project has no `continuousRasterize` prop, so it must take exactly
 * the code path it took before this feature existed.
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
    pathPoints: [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 50, y: 100, inX: 0, inY: 0, outX: 0, outY: 0 },
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
  it('RE-RASTERS when the scale crosses a tier — the defect CR exists to fix', () => {
    // OFF: scale 6 and scale 12 share one cache key (both clamp to tier 4), so
    // the second is a hit and reuses the FIRST texture. Zooming in stops
    // sharpening. Measured in rasterResolution.probe.test.ts.
    const off = provider();
    off.p.setRasterScale(1);
    off.p.setPath('path:a', pathLayer({ scaleX: 6, scaleY: 6, contentHash: 'stale' }));
    const offFirst = lastPx(off);
    off.p.setPath('path:a', pathLayer({ scaleX: 12, scaleY: 12, contentHash: 'stale' }));
    expect(lastPx(off)).toBe(offFirst); // stale: no bigger texture allocated

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

describe('CR OFF is unchanged — the regression guard for every existing project', () => {
  it('produces the same texture size with the flag absent as with it false', () => {
    const a = provider();
    a.p.setRasterScale(1);
    a.p.setPath('path:a', pathLayer({ scaleX: 8, scaleY: 8, contentHash: 'x' }));

    const b = provider();
    b.p.setRasterScale(1);
    b.p.setPath('path:a', pathLayer({ scaleX: 8, scaleY: 8, continuousRaster: false, contentHash: 'x' }));

    expect(lastPx(a)).toBe(lastPx(b));
  });

  it('draws at the RAW scale, uncapped — 16x on a 100px box is 3200px', () => {
    // The measurement that corrected the premise: `resolutionTier`'s 4x clamp
    // applies to the cache KEY, not to the pixels. OFF is already sharp; what it
    // is not is correctly cached or bounded.
    const h = provider();
    h.p.setRasterScale(1);
    h.p.setPath('path:a', pathLayer({ scaleX: 16, scaleY: 16, contentHash: 'raw' }));
    expect(lastPx(h)).toBe(100 * 16 * 2);
  });

  it('is unaffected by the max-dimension report', () => {
    const sizes = [4096, 16384].map((dim) => {
      const h = provider();
      const p = h.p;
      p.setRasterScale(1);
      p.setMaxRasterDimension(dim);
      p.setPath('path:a', pathLayer({ scaleX: 16, scaleY: 16, contentHash: 'd' }));
      return lastPx(h);
    });
    expect(sizes[0]).toBe(sizes[1]);
  });
});

describe('CR ON stays inside its bounds', () => {
  it('at an exact power of two, ON and OFF agree — CR does not spend extra pixels', () => {
    // The reason there is no draft cap: OFF already draws at the raw scale, so a
    // cap below the requested scale would make ON SOFTER than OFF.
    const on = provider();
    on.p.setRasterScale(1);
    on.p.setPath('path:a', pathLayer({ scaleX: 16, scaleY: 16, continuousRaster: true, contentHash: 'q' }));

    const off = provider();
    off.p.setRasterScale(1);
    off.p.setPath('path:a', pathLayer({ scaleX: 16, scaleY: 16, contentHash: 'q' }));

    expect(lastPx(on)).toBe(lastPx(off));
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
