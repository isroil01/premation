/**
 * The Distort family: Bulge, Twirl, Spherize and Corner Pin.
 *
 * These are inverse resamples, and the failure mode they share is that a WRONG
 * warp and a MISSING warp look equally plausible in a unit test if you only
 * assert "the pixels changed". Each test below pins a property that the
 * specific geometry has and its neighbours do not — a twirl that rotates the
 * wrong way, a corner pin that degenerated to an affine map, or a bulge that
 * pinched instead of magnifying would all still "change pixels".
 */

import {
  bulgeData, twirlData, spherizeData, cornerPinData, defaultCorners, remap,
} from './distort';
import { applyCanvas2dEffect, isCanvas2dOnlyEffect } from './canvas2dEffects';
import { EFFECT_DEFS, defaultParams, type Effect, type EffectParams, type EffectType } from './effects';

const W = 64, H = 64;

/** A frame with a single opaque white dot at (x,y) on transparent black. */
function dotAt(x: number, y: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  const i = (y * W + x) * 4;
  d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255;
  return d;
}

/** Centroid of the opaque content, or null when the frame is empty. */
function centroid(d: Uint8ClampedArray): { x: number; y: number; mass: number } | null {
  let sx = 0, sy = 0, m = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = d[(y * W + x) * 4 + 3]!;
      if (a === 0) continue;
      sx += x * a; sy += y * a; m += a;
    }
  }
  return m === 0 ? null : { x: sx / m, y: sy / m, mass: m };
}

/** A four-quadrant colour field — content everywhere, so a warp has something
 *  to move at every radius. */
function quadrants(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      d[i] = x < W / 2 ? 240 : 20;
      d[i + 1] = y < H / 2 ? 240 : 20;
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  return d;
}

describe('remap — the shared sampler', () => {
  it('the identity map returns the image unchanged', () => {
    const src = quadrants();
    const out = remap(src, W, H, (x, y) => ({ x, y }));
    expect([...out]).toEqual([...src]);
  });

  it('a null map leaves the destination transparent rather than black', () => {
    const out = remap(quadrants(), W, H, () => null);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('sampling outside the source is transparent, NOT an edge smear', () => {
    // Edge-clamping would invent opaque content beyond the layer, which on any
    // layer with an alpha edge is visible as a streak.
    const out = remap(quadrants(), W, H, (x, y) => ({ x: x + W, y }));
    expect(centroid(out)).toBeNull();
  });

  it('does not read its own output — a shift cannot smear', () => {
    // In-place resampling would drag the dot into a streak, because a later
    // destination pixel would read a source pixel an earlier one overwrote.
    const out = remap(dotAt(20, 20), W, H, (x, y) => ({ x: x - 5, y }));
    const c = centroid(out)!;
    expect(c.x).toBeCloseTo(25, 0);
    expect(c.y).toBeCloseTo(20, 0);
    // Mass is conserved (one dot in, one dot out) — a smear would multiply it.
    expect(c.mass).toBeCloseTo(255, -1);
  });
});

describe('Bulge', () => {
  it('magnifies: content is pushed AWAY from the centre', () => {
    // A dot between centre and radius must move outward under a positive
    // height. If the sign were inverted this would move inward and the effect
    // would be a pinch wearing a bulge's label.
    const out = bulgeData(dotAt(40, 32), W, H, 32, 32, 24, 80);
    const c = centroid(out)!;
    expect(c.x).toBeGreaterThan(40);
    expect(c.y).toBeCloseTo(32, 0);
  });

  it('a negative height pinches — the same dot moves inward', () => {
    const out = bulgeData(dotAt(40, 32), W, H, 32, 32, 24, -80);
    expect(centroid(out)!.x).toBeLessThan(40);
  });

  it('leaves everything outside the radius exactly alone', () => {
    const src = quadrants();
    const out = bulgeData(new Uint8ClampedArray(src), W, H, 32, 32, 10, 90);
    // A pixel well outside the disc must be byte-identical.
    const far = (2 * W + 2) * 4;
    expect([out[far], out[far + 1], out[far + 2], out[far + 3]])
      .toEqual([src[far], src[far + 1], src[far + 2], src[far + 3]]);
  });

  it('zero height is a no-op', () => {
    const src = quadrants();
    expect([...bulgeData(new Uint8ClampedArray(src), W, H, 32, 32, 24, 0)]).toEqual([...src]);
  });
});

describe('Twirl', () => {
  it('rotates about the centre, and the direction follows the angle sign', () => {
    const pos = centroid(twirlData(dotAt(32, 12), W, H, 32, 32, 30, 90))!;
    const neg = centroid(twirlData(dotAt(32, 12), W, H, 32, 32, 30, -90))!;
    // The dot starts directly above the centre. Opposite angles must send it to
    // opposite sides — the single property that distinguishes a twirl from any
    // other radial warp.
    expect(Math.sign(pos.x - 32)).toBe(-Math.sign(neg.x - 32));
    expect(Math.abs(pos.x - 32)).toBeGreaterThan(2);
  });

  it('preserves distance from the centre — it rotates, it does not scale', () => {
    const r0 = 20;
    const out = twirlData(dotAt(32, 32 - r0), W, H, 32, 32, 30, 70);
    const c = centroid(out)!;
    expect(Math.hypot(c.x - 32, c.y - 32)).toBeCloseTo(r0, 0);
  });

  it('the disc edge is a fixed point — the falloff really reaches zero', () => {
    const src = quadrants();
    const out = twirlData(new Uint8ClampedArray(src), W, H, 32, 32, 20, 180);
    const far = (2 * W + 2) * 4;
    expect(out[far]).toBe(src[far]);
  });
});

describe('Spherize', () => {
  it('is not the same warp as Bulge at equal settings', () => {
    // Both are radial magnifications, so "the pixels moved" cannot tell them
    // apart. The refraction curve differs from the smoothstep falloff, and if
    // Spherize were ever aliased onto Bulge this is what would catch it.
    const args = [W, H, 32, 32, 28, 70] as const;
    const b = bulgeData(quadrants(), ...args);
    const s = spherizeData(quadrants(), ...args);
    expect([...s]).not.toEqual([...b]);
  });

  it('magnifies outward like a lens', () => {
    const c = centroid(spherizeData(dotAt(42, 32), W, H, 32, 32, 28, 80))!;
    expect(c.x).toBeGreaterThan(42);
  });

  it('zero amount is a no-op', () => {
    const src = quadrants();
    expect([...spherizeData(new Uint8ClampedArray(src), W, H, 32, 32, 28, 0)]).toEqual([...src]);
  });
});

describe('Corner Pin', () => {
  it('the natural rectangle is the identity map', () => {
    const src = quadrants();
    const out = cornerPinData(src, W, H, defaultCorners(W, H));
    // Bilinear resampling at exact pixel centres is exact, so this must be
    // byte-identical, not merely close.
    expect([...out]).toEqual([...src]);
  });

  it('is PROJECTIVE, not affine — parallel edges converge', () => {
    // Pull the two right-hand corners towards each other vertically. Under an
    // affine map the horizontal scanlines would all shrink equally; under a
    // projective one the shrink grows across the frame. Measuring the opaque
    // width at two scanlines is what tells the two apart, and it is the whole
    // reason this effect exists next to the Transform effect.
    const out = cornerPinData(quadrants(), W, H, [0, 0, W, 16, W, H - 16, 0, H]);
    const widthAt = (y: number): number => {
      let n = 0;
      for (let x = 0; x < W; x++) if (out[(y * W + x) * 4 + 3]! > 0) n++;
      return n;
    };
    // Near the left edge the quad is full height; near the right it is inset.
    // A row near the top must be narrower at its right end.
    expect(widthAt(2)).toBeLessThan(widthAt(32));
  });

  it('a degenerate quad clears the layer instead of rendering noise', () => {
    // All four corners collapsed to a point: the homography is singular.
    const out = cornerPinData(quadrants(), W, H, [0, 0, 0, 0, 0, 0, 0, 0]);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('outside the quad is transparent', () => {
    // Inset the whole quad; the border must be empty rather than smeared.
    const out = cornerPinData(quadrants(), W, H, [16, 16, W - 16, 16, W - 16, H - 16, 16, H - 16]);
    expect(out[(0 * W + 0) * 4 + 3]).toBe(0);
    expect(out[(32 * W + 32) * 4 + 3]).toBeGreaterThan(0);
  });
});

describe('the Distort family reaches the bake chain', () => {
  function fx(type: EffectType, params: Record<string, unknown>): Effect {
    const def = EFFECT_DEFS.find((d) => d.type === type)!;
    return { id: 'e1', type, params: { ...defaultParams(def), ...params } as EffectParams };
  }

  const CASES: ReadonlyArray<readonly [EffectType, Record<string, unknown>]> = [
    ['bulge', { radius: 30, height: 80 }],
    ['twirl', { radius: 30, angle: 150 }],
    ['spherize', { radius: 30, amount: 80 }],
    ['corner-pin', { topLeftX: 12, bottomRightY: -8 }],
  ];

  it.each(CASES)('%s changes pixels through applyCanvas2dEffect', (type, params) => {
    expect(isCanvas2dOnlyEffect(type)).toBe(true);
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    // A gradient, so a resample has something to move at every radius. A flat
    // fill would survive most warps unchanged and pass vacuously.
    const grad = ctx.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, '#2b3cff');
    grad.addColorStop(1, '#ff7a1a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const before = [...ctx.getImageData(0, 0, 64, 64).data];

    applyCanvas2dEffect(ctx, 64, 64, fx(type, params));
    expect([...ctx.getImageData(0, 0, 64, 64).data]).not.toEqual(before);
  });

  it('an untouched Corner Pin is a no-op, so adding it costs no sharpness', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#c83232';
    ctx.fillRect(0, 0, 32, 32);
    const before = [...ctx.getImageData(0, 0, 32, 32).data];
    applyCanvas2dEffect(ctx, 32, 32, fx('corner-pin', {}));
    expect([...ctx.getImageData(0, 0, 32, 32).data]).toEqual(before);
  });

  it('the centre params are resolved as offsets from the layer centre', () => {
    // A Bulge with zero offset must sit at the middle of the layer. If the
    // offset resolution were dropped the disc would land at the top-left corner
    // and the layer's centre would be untouched — so this asserts the centre
    // MOVED and a far corner did not.
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, '#000000');
    grad.addColorStop(1, '#ffffff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const before = ctx.getImageData(0, 0, 64, 64).data;
    const mid = [...before].slice((32 * 64 + 20) * 4, (32 * 64 + 20) * 4 + 3);
    const corner = [...before].slice((60 * 64 + 60) * 4, (60 * 64 + 60) * 4 + 3);

    applyCanvas2dEffect(ctx, 64, 64, fx('bulge', { radius: 24, height: 90 }));
    const after = ctx.getImageData(0, 0, 64, 64).data;
    expect([...after].slice((32 * 64 + 20) * 4, (32 * 64 + 20) * 4 + 3)).not.toEqual(mid);
    expect([...after].slice((60 * 64 + 60) * 4, (60 * 64 + 60) * 4 + 3)).toEqual(corner);
  });
});
