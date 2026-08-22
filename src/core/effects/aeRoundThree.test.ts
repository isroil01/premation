/**
 * Round three of the AE effect set — seventeen effects across six families.
 *
 * ── What this file is for, and what it deliberately does not repeat ─────────
 *
 * Three structural guards already cover these additions and are not duplicated
 * here:
 *
 *   effectRegistryComplete   every type has a definition, label and params
 *   canvas2dEffects.test     every CANVAS2D_ONLY type has a dispatch `case`
 *   colourRoundTwo.test      every LUT type moves its table off identity
 *
 * The last two are the interesting limitation. The dispatch guard reads from
 * SOURCE — it proves a `case` was written, not that the case draws anything —
 * and it says so in its own comment. So an effect can be registered, filed,
 * dispatched, and still render nothing, which is the exact failure mode this
 * subsystem has produced four separate times (Compound Blur, Lumetri, and the
 * Fill/Stroke/Sharpen/Noise group).
 *
 * This file closes that gap in two directions:
 *
 *   1. WIRING — every new pixel-pass effect run through `applyCanvas2dEffect`
 *      on a real canvas, with settings that MUST move pixels. Nothing here is
 *      scraped from source; the assertion is on the bytes afterwards.
 *   2. BEHAVIOUR — for each effect, the one claim a plausible-but-wrong
 *      implementation would fail. Direction for the warps and wipes, seam
 *      continuity for Offset, channel independence for Channel Blur, boundary
 *      preservation for Minimax's compound operations. "It changed some pixels"
 *      is necessary and nowhere near sufficient — a twirl that spins the wrong
 *      way changes pixels too.
 */

import {
  EFFECT_DEFS, defaultParams, isGpuOnlyEffect,
  type Effect, type EffectParams, type EffectType,
} from './effects';
import { applyCanvas2dEffect, isCanvas2dOnlyEffect } from './canvas2dEffects';
import { isLutEffect, buildChannelLut } from './colorLut';
import { EFFECT_CATEGORY } from '@/layout/Effects/EffectsPanel';

import { photoFilterData, blackAndWhiteData, tritoneData, thresholdData } from './aeColor';
import { polarCoordinatesData, mirrorData, offsetData } from './distort';
import { embossData, scatterData } from './stylize';
import { radialWipeData, blockDissolveData } from './transitions';
import { lumaKeyData, minimaxData } from './keyingEffects';
import { channelBlurData, unsharpMaskData } from './blurs';

// ── Fixtures ──────────────────────────────────────────────────────

function fx(type: EffectType, params: Record<string, unknown> = {}): Effect {
  const def = EFFECT_DEFS.find((d) => d.type === type)!;
  return { id: 'e1', type, params: { ...defaultParams(def), ...params } as EffectParams };
}

/** A `w`×`h` RGBA buffer, filled by a per-pixel function. */
function buffer(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const o = (y * w + x) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
    }
  }
  return d;
}

const px = (d: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] => {
  const o = (y * w + x) * 4;
  return [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!];
};

/** Every type added in this round, with its expected render path. */
const ROUND_THREE: ReadonlyArray<readonly [EffectType, 'lut' | 'pixel' | 'ported']> = [
  ['color-balance', 'lut'],
  ['gamma-pedestal-gain', 'lut'],
  ['photo-filter', 'ported'],
  ['black-and-white', 'ported'],
  ['tritone', 'ported'],
  ['threshold', 'ported'],
  ['polar-coordinates', 'pixel'],
  ['mirror', 'ported'],
  ['offset', 'ported'],
  ['emboss', 'ported'],
  ['scatter', 'pixel'],
  ['radial-wipe', 'pixel'],
  ['block-dissolve', 'pixel'],
  ['luma-key', 'pixel'],
  ['minimax', 'pixel'],
  ['channel-blur', 'pixel'],
  ['unsharp-mask', 'pixel'],
];

// ── Registration ──────────────────────────────────────────────────

describe('round three is registered on the right path', () => {
  it.each(ROUND_THREE)('%s is defined, categorised and animatable', (type) => {
    const def = EFFECT_DEFS.find((d) => d.type === type);
    expect(def).toBeTruthy();
    expect(def!.params.length).toBeGreaterThan(0);
    expect(EFFECT_CATEGORY[type]).toBeTruthy();
    // None of these has a shader, so claiming GPU-only would strand them: an
    // effect flagged gpuOnly is carried PAST a CPU bake rather than drawn by it.
    expect(isGpuOnlyEffect(type)).toBe(false);
  });

  /**
   * The path split is the load-bearing decision in this round.
   *
   * A per-channel effect wrongly listed as a pixel pass still renders, and
   * costs every layer carrying it a full CPU bake for something the GPU does
   * free. A pixel-pass effect wrongly listed as a LUT renders WRONG — silently,
   * because a table can only express what a table can express.
   *
   * Neither shows up as a failure anywhere else, so it is asserted directly.
   */
  // 'ported' (round six, 2026-08-14): a GPU shader draws these on live layers
  // so they no longer force a bake — the Canvas2D pass remains, the exact
  // both-paths position portedEffectContract.test.ts pins in full.
  it.each(ROUND_THREE)('%s is on exactly one render path', (type, path) => {
    expect({ type, lut: isLutEffect(type), pixel: isCanvas2dOnlyEffect(type) })
      .toEqual({ type, lut: path === 'lut', pixel: path === 'pixel' });
  });

  it('the two LUT effects are EXACTLY the identity at their defaults', () => {
    // A grading control that changes the picture the moment it is dropped on a
    // layer is one people stop trusting. Asserted on the composed table rather
    // than on pixels, so it is exact rather than within a tolerance.
    for (const type of ['color-balance', 'gamma-pedestal-gain'] as EffectType[]) {
      const lut = buildChannelLut([fx(type)])!;
      expect(lut).not.toBeNull();
      const identity = Array.from({ length: 256 }, (_, i) => i);
      expect({ type, r: [...lut.r] }).toEqual({ type, r: identity });
      expect({ type, g: [...lut.g] }).toEqual({ type, g: identity });
      expect({ type, b: [...lut.b] }).toEqual({ type, b: identity });
    }
  });
});

// ── Wiring ────────────────────────────────────────────────────────

/**
 * Settings under which each pixel-pass effect MUST change the canvas.
 *
 * Chosen to defeat every early-out in the wrapper — a zero completion, a zero
 * radius or a 100% blend all legitimately return without touching a pixel, so a
 * fixture left at its defaults would pass this test while proving nothing.
 */
const WIRING: ReadonlyArray<readonly [EffectType, Record<string, unknown>]> = [
  ['photo-filter', { density: 100 }],
  ['black-and-white', {}],
  ['tritone', { blend: 0 }],
  ['threshold', { level: 128 }],
  ['polar-coordinates', { interpolation: 100 }],
  ['mirror', { angle: 0 }],
  ['offset', { shiftX: 7, shiftY: 5, blend: 0 }],
  ['emboss', { relief: 2, contrast: 300 }],
  ['scatter', { amount: 6 }],
  ['radial-wipe', { completion: 50 }],
  ['block-dissolve', { completion: 50, blockWidth: 4, blockHeight: 4 }],
  ['luma-key', { keyType: 0, threshold: 100, softness: 0 }],
  ['minimax', { operation: 0, radius: 2, channel: 1 }],
  ['channel-blur', { redBlurriness: 4 }],
  ['unsharp-mask', { amount: 200, radius: 2 }],
];

describe('every round-three pixel pass actually draws', () => {
  it('the wiring table covers every pixel-pass effect in the round', () => {
    // Guards the guard. Without this, adding an effect to ROUND_THREE and
    // forgetting the wiring fixture leaves it untested by the loop below.
    const covered = new Set(WIRING.map(([t]) => t));
    const uncovered = ROUND_THREE.filter(([t, p]) => p === 'pixel' && !covered.has(t)).map(([t]) => t);
    expect(uncovered).toEqual([]);
  });

  it.each(WIRING)('%s changes pixels through applyCanvas2dEffect', (type, params) => {
    const w = 32;
    const h = 32;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // A diagonal ramp with a hard square in it: gradients alone would let a
    // broken spatial effect look plausible, and a flat fill would make several
    // of these legitimately no-ops (an emboss of a flat field IS mid-grey
    // everywhere, and a max filter of a constant is that constant).
    const img = ctx.createImageData(w, h);
    img.data.set(buffer(w, h, (x, y) => (
      x >= 8 && x < 20 && y >= 8 && y < 20
        ? [240, 30, 30, 255]
        : [x * 8, y * 8, 128, 255]
    )));
    ctx.putImageData(img, 0, 0);
    const before = [...ctx.getImageData(0, 0, w, h).data];

    applyCanvas2dEffect(ctx, w, h, fx(type, params));

    const after = [...ctx.getImageData(0, 0, w, h).data];
    // Compared by VALUE — `after !== before` compares two fresh arrays by
    // reference and is true however little was drawn.
    const drew = after.some((v, i) => v !== before[i]);
    expect({ type, drew }).toEqual({ type, drew: true });
  });
});

// ── Colour ────────────────────────────────────────────────────────

describe('Photo Filter', () => {
  it('warms the image — the gel is a multiply, so blue falls', () => {
    const d = photoFilterData(buffer(1, 1, () => [128, 128, 128, 255]), 255, 138, 0, 100, false);
    const [r, g, b] = px(d, 1, 0, 0);
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
  });

  it('Preserve Luminosity holds luminance while still changing hue', () => {
    const grey = 128;
    const lumaOf = ([r, g, b]: readonly number[]): number => 0.299 * r! + 0.587 * g! + 0.114 * b!;

    const off = px(photoFilterData(buffer(1, 1, () => [grey, grey, grey, 255]), 255, 138, 0, 100, false), 1, 0, 0);
    const on = px(photoFilterData(buffer(1, 1, () => [grey, grey, grey, 255]), 255, 138, 0, 100, true), 1, 0, 0);

    // Without the checkbox the gel darkens, which is the physical behaviour.
    expect(lumaOf(off)).toBeLessThan(grey - 5);
    // With it, luminance returns to where it started — that is the whole claim.
    expect(lumaOf(on)).toBeCloseTo(grey, 0);
    // ...without simply undoing the filter. Hue must still have moved.
    expect(on[0]).toBeGreaterThan(on[2]);
  });

  it('a black pixel survives Preserve Luminosity rather than becoming NaN', () => {
    // The divisor guard. Without it this is 0/0, which clamps to 0 and looks
    // correct by accident — until the pixel is merely very dark.
    const d = photoFilterData(buffer(1, 1, () => [0, 0, 0, 255]), 255, 138, 0, 100, true);
    expect(px(d, 1, 0, 0)).toEqual([0, 0, 0, 255]);

    const dark = photoFilterData(buffer(1, 1, () => [4, 4, 4, 255]), 255, 138, 0, 100, true);
    for (const c of px(dark, 1, 0, 0)) expect(Number.isFinite(c)).toBe(true);
  });
});

describe('Black & White', () => {
  const W = { reds: 0.4, yellows: 0.6, greens: 0.4, cyans: 0.6, blues: 0.2, magentas: 0.8 };

  it('returns exactly the named weight at each of the six primaries', () => {
    // The decomposition is exact at the primaries by construction; if it is
    // not, the sector selection is wrong and everything between them is too.
    const cases: ReadonlyArray<readonly [[number, number, number], number]> = [
      [[255, 0, 0], W.reds],
      [[255, 255, 0], W.yellows],
      [[0, 255, 0], W.greens],
      [[0, 255, 255], W.cyans],
      [[0, 0, 255], W.blues],
      [[255, 0, 255], W.magentas],
    ];
    for (const [[r, g, b], weight] of cases) {
      const out = px(blackAndWhiteData(buffer(1, 1, () => [r, g, b, 255]), W, null), 1, 0, 0);
      expect({ rgb: [r, g, b], grey: out[0] }).toEqual({ rgb: [r, g, b], grey: Math.round(weight * 255) });
      // Grey means all three channels agree.
      expect(out[1]).toBe(out[0]);
      expect(out[2]).toBe(out[0]);
    }
  });

  it('separates two colours a flat luma conversion would collapse together', () => {
    // The entire reason the effect exists. Under the default mix, red and blue
    // must land on different greys — otherwise a red logo on a blue field
    // vanishes, which is what `grayscale` already does.
    const red = px(blackAndWhiteData(buffer(1, 1, () => [255, 0, 0, 255]), W, null), 1, 0, 0)[0];
    const blue = px(blackAndWhiteData(buffer(1, 1, () => [0, 0, 255, 255]), W, null), 1, 0, 0)[0];
    expect(Math.abs(red - blue)).toBeGreaterThan(20);
  });

  it('leaves neutrals alone and preserves alpha', () => {
    const d = blackAndWhiteData(buffer(1, 1, () => [90, 90, 90, 77]), W, null);
    expect(px(d, 1, 0, 0)).toEqual([90, 90, 90, 77]);
  });

  it('tint colourises rather than flattening to the tint colour', () => {
    const dark = px(blackAndWhiteData(buffer(1, 1, () => [40, 40, 40, 255]), W, [216, 180, 138]), 1, 0, 0);
    const light = px(blackAndWhiteData(buffer(1, 1, () => [200, 200, 200, 255]), W, [216, 180, 138]), 1, 0, 0);
    // Both carry the tint's warm bias...
    expect(dark[0]).toBeGreaterThan(dark[2]);
    expect(light[0]).toBeGreaterThan(light[2]);
    // ...but they are not the same pixel: brightness still varies.
    expect(light[0]).toBeGreaterThan(dark[0] + 40);
  });
});

describe('Tritone', () => {
  const S = [10, 0, 40] as const;
  const M = [120, 90, 60] as const;
  const H = [255, 240, 200] as const;

  it('maps black, mid and white onto the three stops', () => {
    const black = px(tritoneData(buffer(1, 1, () => [0, 0, 0, 255]), S, M, H, 0), 1, 0, 0);
    const white = px(tritoneData(buffer(1, 1, () => [255, 255, 255, 255]), S, M, H, 0), 1, 0, 0);
    expect([black[0], black[1], black[2]]).toEqual([...S]);
    expect([white[0], white[1], white[2]]).toEqual([...H]);

    // Mid-grey lands on the midtone stop, which is the property a smooth spline
    // through the three would NOT have.
    const mid = px(tritoneData(buffer(1, 1, () => [128, 128, 128, 255]), S, M, H, 0), 1, 0, 0);
    for (let c = 0; c < 3; c++) expect(mid[c]).toBeCloseTo(M[c]!, -1);
  });

  it('blend 100 is exactly a no-op', () => {
    const d = tritoneData(buffer(1, 1, () => [17, 200, 90, 255]), S, M, H, 100);
    expect(px(d, 1, 0, 0)).toEqual([17, 200, 90, 255]);
  });
});

describe('Threshold', () => {
  it('cuts on luminance, not per channel', () => {
    // A saturated blue is DARK (luma 0.114) and must go black even though its
    // blue channel is maxed. Thresholding per channel would return pure blue,
    // which is the bug a per-channel LUT would have shipped.
    const d = thresholdData(buffer(1, 1, () => [0, 0, 255, 255]), 128);
    expect(px(d, 1, 0, 0)).toEqual([0, 0, 0, 255]);

    // Yellow is bright (luma ~0.886) and must go white.
    const y = thresholdData(buffer(1, 1, () => [255, 255, 0, 255]), 128);
    expect(px(y, 1, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('preserves alpha, so a shaped layer keeps its shape', () => {
    const d = thresholdData(buffer(1, 1, () => [255, 255, 255, 64]), 128);
    expect(px(d, 1, 0, 0)[3]).toBe(64);
  });
});

// ── Distort ───────────────────────────────────────────────────────

describe('Polar Coordinates', () => {
  it('interpolation 0 is exactly a no-op', () => {
    const src = buffer(8, 8, (x, y) => [x * 30, y * 30, 0, 255]);
    const out = polarCoordinatesData(new Uint8ClampedArray(src), 8, 8, 0, 'rect-to-polar');
    expect([...out]).toEqual([...src]);
  });

  it('rect-to-polar puts the source ROW at the top of the frame on the CENTRE', () => {
    /*
      The direction claim, and the one a plausible-but-wrong implementation
      fails silently. Under Rect to Polar the source's Y is a RADIUS, so row 0
      — the top of the source — becomes the centre of the result, and the
      bottom row becomes the rim. Swapping the two produces a perfectly
      believable ring that is inside-out.
    */
    const w = 32;
    const h = 32;
    // Top half red, bottom half green.
    const src = buffer(w, h, (_x, y) => (y < h / 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const out = polarCoordinatesData(src, w, h, 100, 'rect-to-polar');

    const centre = px(out, w, w / 2, h / 2);
    expect(centre[0]).toBeGreaterThan(centre[1]);

    // A pixel near the rim, on the vertical axis above the centre.
    const rim = px(out, w, w / 2, 1);
    expect(rim[1]).toBeGreaterThan(rim[0]);
  });

  it('polar-to-rect reads angle zero from twelve o-clock', () => {
    /*
      Angle convention, asserted directly. `Math.atan2(y, x)` puts zero at three
      o'clock; AE puts it at twelve. The difference is a quarter-turn — an
      effect that looks entirely correct until it has to line up with a
      hand-authored ramp or a Radial Wipe.

      Under Polar to Rect the destination's X is the ANGLE, so destination
      column 0 reads from straight up from the centre.
    */
    const w = 32;
    const h = 32;
    // A single bright band straight ABOVE the centre; everything else black.
    const src = buffer(w, h, (x, y) => (
      Math.abs(x - w / 2) < 2 && y < h / 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]
    ));
    const out = polarCoordinatesData(src, w, h, 100, 'polar-to-rect');

    // Column 0 (angle 0 = up) should be bright well down the frame; the column
    // a quarter of the way across (angle 90° = right) should not.
    const up = px(out, w, 0, h / 2);
    const right = px(out, w, Math.floor(w / 4), h / 2);
    expect(up[0]).toBeGreaterThan(right[0] + 60);
  });
});

describe('Mirror', () => {
  it('replaces the far side and leaves the near side byte-identical', () => {
    const w = 16;
    const h = 4;
    // Left half red, right half green.
    const src = buffer(w, h, (x) => (x < w / 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    // Normal pointing right (angle 0) through the centre: the RIGHT half is
    // replaced by a mirror of the left.
    const out = mirrorData(new Uint8ClampedArray(src), w, h, w / 2, h / 2, 0);

    // Near side untouched.
    for (let x = 0; x < w / 2; x++) {
      expect({ x, p: px(out, w, x, 1) }).toEqual({ x, p: [255, 0, 0, 255] });
    }
    // Far side now shows the near side's colour — the green is gone.
    for (let x = w / 2; x < w; x++) {
      expect({ x, red: px(out, w, x, 1)[0] > 200 }).toEqual({ x, red: true });
    }
  });

  it('rotating the normal by 180 degrees keeps the OTHER half', () => {
    const w = 16;
    const h = 4;
    const src = buffer(w, h, (x) => (x < w / 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const out = mirrorData(new Uint8ClampedArray(src), w, h, w / 2, h / 2, 180);
    // Now the LEFT is replaced, so the surviving colour is green everywhere.
    expect(px(out, w, 2, 1)[1]).toBeGreaterThan(200);
    expect(px(out, w, 13, 1)[1]).toBeGreaterThan(200);
  });
});

describe('Offset', () => {
  it('wraps — a shift of the full width is the identity', () => {
    const w = 16;
    const h = 8;
    const src = buffer(w, h, (x, y) => [x * 16, y * 32, 64, 255]);
    // shiftX is "move the centre TO", so centre + w is a whole-width shift.
    const out = offsetData(new Uint8ClampedArray(src), w, h, w / 2 + w, h / 2, 0);
    expect([...out]).toEqual([...src]);
  });

  it('leaves NO transparent seam at the wrap — the whole point of the effect', () => {
    /*
      The regression this guards is specific and would be invisible in a
      "did it change pixels" test: sampling through `remap`, whose out-of-range
      taps read transparent, puts a one-pixel transparent scar down the wrap.
      A fractional shift is used deliberately, because an integer shift never
      exercises the bilinear footprint that straddles the edge.
    */
    const w = 16;
    const h = 4;
    const src = buffer(w, h, () => [200, 100, 50, 255]);
    const out = offsetData(new Uint8ClampedArray(src), w, h, w / 2 + 3.5, h / 2 + 1.5, 0);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        expect({ x, y, a: px(out, w, x, y)[3] }).toEqual({ x, y, a: 255 });
      }
    }
  });

  it('actually moves content, in the direction named', () => {
    const w = 8;
    const h = 1;
    // One bright pixel at x=0.
    const src = buffer(w, h, (x) => (x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = offsetData(new Uint8ClampedArray(src), w, h, w / 2 + 3, h / 2, 0);
    // Shifting the centre right by 3 carries the pixel from 0 to 3.
    expect(px(out, w, 3, 0)[0]).toBe(255);
    expect(px(out, w, 0, 0)[0]).toBe(0);
  });

  it('blend 100 is exactly a no-op', () => {
    const src = buffer(8, 2, (x, y) => [x * 9, y * 9, 3, 255]);
    const out = offsetData(new Uint8ClampedArray(src), 8, 2, 4 + 3, 1, 100);
    expect([...out]).toEqual([...src]);
  });
});

// ── Stylize ───────────────────────────────────────────────────────

describe('Emboss', () => {
  it('renders a flat field as mid-grey — there is no relief to light', () => {
    const out = embossData(buffer(8, 8, () => [90, 140, 200, 255]), 8, 8, 135, 1, 100, 0);
    for (let i = 0; i < 8 * 8; i++) {
      expect(out[i * 4]).toBe(128);
    }
  });

  it('keeps the SIGN of the gradient — one side lights, the other darkens', () => {
    /*
      What separates this from Find Edges, which takes the magnitude and so
      reports both sides of an edge identically. If both sides come back the
      same, the implementation has quietly become an edge detector with a
      mid-grey bias.
    */
    const w = 32;
    const h = 4;
    /*
      A BAR, not a single step, and the distinction matters. A lone step has a
      positive derivative on both of its sides — within `relief` of it, every
      forward tap is bright and every backward tap is dark — so it produces only
      one sign and could not tell the two effects apart. A bar has a RISING edge
      and a FALLING edge, which is exactly where Find Edges reports the same
      magnitude twice and Emboss must report opposite signs.
    */
    const src = buffer(w, h, (x) => (x >= 12 && x < 20 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    // Light straight along +X so the derivative is purely horizontal.
    const out = embossData(src, w, h, 0, 2, 100, 0);

    const rising = px(out, w, 11, 2)[0];
    const falling = px(out, w, 21, 2)[0];
    expect(rising).toBeGreaterThan(128);
    expect(falling).toBeLessThan(128);
    // And symmetric about mid-grey, since the two edges are the same height.
    expect(rising - 128).toBeCloseTo(128 - falling, -1);
  });

  it('relief sets how far the effect reaches from the edge', () => {
    const w = 32;
    const h = 4;
    const mk = (): Uint8ClampedArray => buffer(w, h, (x) => (x < w / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const thin = embossData(mk(), w, h, 0, 1, 100, 0);
    const thick = embossData(mk(), w, h, 0, 6, 100, 0);

    const lit = (d: Uint8ClampedArray): number => {
      let n = 0;
      for (let x = 0; x < w; x++) if (px(d, w, x, 2)[0] !== 128) n++;
      return n;
    };
    expect(lit(thick)).toBeGreaterThan(lit(thin));
  });

  it('blend 100 is exactly a no-op', () => {
    const src = buffer(8, 8, (x, y) => [x * 30, y * 30, 10, 255]);
    const out = embossData(new Uint8ClampedArray(src), 8, 8, 135, 1, 100, 100);
    expect([...out]).toEqual([...src]);
  });
});

describe('Scatter', () => {
  it('moves pixels without inventing colours', () => {
    /*
      The property that distinguishes Scatter from Noise: the palette survives
      exactly. Any interpolation between neighbours would create colours that
      were never in the source, and the effect would be a blur.
    */
    const w = 24;
    const h = 24;
    const src = buffer(w, h, (x, y) => ((x + y) % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const out = scatterData(src, w, h, 5, 'both', 1, 0);

    for (let i = 0; i < w * h; i++) {
      const r = out[i * 4]!;
      const b = out[i * 4 + 2]!;
      const isRed = r === 255 && b === 0;
      const isBlue = r === 0 && b === 255;
      expect({ i, ok: isRed || isBlue }).toEqual({ i, ok: true });
    }
  });

  it('is deterministic in the seed, and different seeds differ', () => {
    // Stability is what stops a still layer boiling; without it every frame
    // re-randomises and the effect is unusable on anything static.
    const mk = (): Uint8ClampedArray => buffer(16, 16, (x, y) => [x * 16, y * 16, 0, 255]);
    const a = scatterData(mk(), 16, 16, 4, 'both', 7, 0);
    const b = scatterData(mk(), 16, 16, 4, 'both', 7, 0);
    const c = scatterData(mk(), 16, 16, 4, 'both', 8, 0);
    expect([...a]).toEqual([...b]);
    expect([...a]).not.toEqual([...c]);
  });

  it('horizontal grain leaves rows intact', () => {
    // Each row is a solid colour, so a purely horizontal scatter cannot change
    // anything; a vertical component would drag other rows in.
    const w = 16;
    const h = 16;
    const src = buffer(w, h, (_x, y) => [y * 16, 0, 0, 255]);
    const out = scatterData(new Uint8ClampedArray(src), w, h, 6, 'horizontal', 3, 0);
    expect([...out]).toEqual([...src]);
  });
});

// ── Transition ────────────────────────────────────────────────────

describe('Radial Wipe', () => {
  const solid = (w: number, h: number): Uint8ClampedArray => buffer(w, h, () => [255, 255, 255, 255]);

  it('completion 0 is a no-op and 100 clears the layer', () => {
    const w = 16;
    const h = 16;
    const none = radialWipeData(solid(w, h), w, h, 0, 0, 'clockwise', w / 2, h / 2, 0);
    expect([...none]).toEqual([...solid(w, h)]);

    const all = radialWipeData(solid(w, h), w, h, 1, 0, 'clockwise', w / 2, h / 2, 0);
    for (let i = 3; i < all.length; i += 4) expect(all[i]).toBe(0);
  });

  it('a clockwise quarter wipe removes the top-RIGHT quadrant first', () => {
    /*
      The direction assertion. A wipe that sweeps anticlockwise, or starts at
      three o'clock, still "removes a quarter of the frame" and would satisfy
      any coverage-counting test. Starting at twelve and going clockwise, the
      first quadrant to go is up-and-to-the-right.
    */
    const w = 32;
    const h = 32;
    const out = radialWipeData(solid(w, h), w, h, 0.25, 0, 'clockwise', w / 2, h / 2, 0);

    // Up and to the right — inside the swept arc.
    expect(px(out, w, 24, 8)[3]).toBe(0);
    // Up and to the left — the LAST quadrant a clockwise sweep reaches.
    expect(px(out, w, 8, 8)[3]).toBe(255);
    // Down-right and down-left are also still present at 25%.
    expect(px(out, w, 24, 24)[3]).toBe(255);
    expect(px(out, w, 8, 24)[3]).toBe(255);
  });

  it('counterclockwise removes the mirror-image quadrant', () => {
    const w = 32;
    const h = 32;
    const out = radialWipeData(solid(w, h), w, h, 0.25, 0, 'counterclockwise', w / 2, h / 2, 0);
    expect(px(out, w, 8, 8)[3]).toBe(0);
    expect(px(out, w, 24, 8)[3]).toBe(255);
  });

  it('both directions open symmetrically about the start angle', () => {
    const w = 32;
    const h = 32;
    const out = radialWipeData(solid(w, h), w, h, 0.5, 0, 'both', w / 2, h / 2, 0);
    // Half of 50% each side: the top is gone on both sides of twelve o'clock...
    expect(px(out, w, 20, 6)[3]).toBe(0);
    expect(px(out, w, 12, 6)[3]).toBe(0);
    // ...and the bottom survives.
    expect(px(out, w, 16, 28)[3]).toBe(255);
  });
});

describe('Block Dissolve', () => {
  const solid = (w: number, h: number): Uint8ClampedArray => buffer(w, h, () => [255, 255, 255, 255]);

  it('completion 0 is a no-op and 100 clears the layer', () => {
    const w = 16;
    const h = 16;
    expect([...blockDissolveData(solid(w, h), w, h, 0, 4, 4, 0, 1)]).toEqual([...solid(w, h)]);
    const all = blockDissolveData(solid(w, h), w, h, 1, 4, 4, 0, 1);
    for (let i = 3; i < all.length; i += 4) expect(all[i]).toBe(0);
  });

  it('removes whole blocks, not individual pixels', () => {
    const w = 16;
    const h = 16;
    const out = blockDissolveData(solid(w, h), w, h, 0.5, 4, 4, 0, 1);
    // Every 4×4 block must be uniform — a per-pixel threshold would speckle.
    for (let by = 0; by < 4; by++) {
      for (let bx = 0; bx < 4; bx++) {
        const first = px(out, w, bx * 4, by * 4)[3];
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            expect({ bx, by, a: px(out, w, bx * 4 + x, by * 4 + y)[3] }).toEqual({ bx, by, a: first });
          }
        }
      }
    }
  });

  it('is monotone in completion — a block never comes back', () => {
    /*
      This is what makes the transition scrubbable. A shuffled reveal order
      regenerated per frame satisfies every other test here and still pops
      blocks in and out when the playhead moves backwards.
    */
    const w = 32;
    const h = 32;
    const goneAt = (t: number): Set<number> => {
      const out = blockDissolveData(solid(w, h), w, h, t, 4, 4, 0, 5);
      const s = new Set<number>();
      for (let i = 0; i < w * h; i++) if (out[i * 4 + 3] === 0) s.add(i);
      return s;
    };
    const early = goneAt(0.3);
    const late = goneAt(0.7);
    for (const i of early) expect(late.has(i)).toBe(true);
    expect(late.size).toBeGreaterThan(early.size);
  });
});

// ── Keying / Matte ────────────────────────────────────────────────

describe('Luma Key', () => {
  const ramp = (): Uint8ClampedArray => buffer(4, 1, (x) => {
    const v = x * 85; // 0, 85, 170, 255
    return [v, v, v, 255];
  });

  it('keys out the brighter side and leaves the darker', () => {
    const out = lumaKeyData(ramp(), 'brighter', 128, 0, 0);
    expect(px(out, 4, 0, 0)[3]).toBe(255);
    expect(px(out, 4, 1, 0)[3]).toBe(255);
    expect(px(out, 4, 3, 0)[3]).toBe(0);
  });

  it('keys out the darker side when asked, which is the opposite set', () => {
    const out = lumaKeyData(ramp(), 'darker', 128, 0, 0);
    expect(px(out, 4, 0, 0)[3]).toBe(0);
    expect(px(out, 4, 3, 0)[3]).toBe(255);
  });

  it('similar keys a BAND and dissimilar keeps it', () => {
    const similar = lumaKeyData(ramp(), 'similar', 170, 30, 0);
    expect(px(similar, 4, 2, 0)[3]).toBe(0);
    expect(px(similar, 4, 0, 0)[3]).toBe(255);

    const dissimilar = lumaKeyData(ramp(), 'dissimilar', 170, 30, 0);
    expect(px(dissimilar, 4, 2, 0)[3]).toBe(255);
    expect(px(dissimilar, 4, 0, 0)[3]).toBe(0);
  });

  it('MULTIPLIES alpha rather than assigning it', () => {
    // Assigning would resurrect pixels an existing matte had already removed —
    // a key that un-deletes content is worse than one that does nothing.
    const half = buffer(1, 1, () => [0, 0, 0, 100]);
    const out = lumaKeyData(half, 'brighter', 200, 0, 0);
    expect(px(out, 1, 0, 0)[3]).toBe(100);
  });

  it('softness produces a ramp, not a cut', () => {
    const out = lumaKeyData(ramp(), 'brighter', 100, 0, 120);
    const a = px(out, 4, 2, 0)[3];
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
  });
});

describe('Minimax', () => {
  /** A `size`×`size` field of alpha 0 with a solid square of alpha 255 in it. */
  const square = (size: number, from: number, to: number): Uint8ClampedArray =>
    buffer(size, size, (x, y) => [255, 255, 255, x >= from && x < to && y >= from && y < to ? 255 : 0]);

  it('maximum grows the matte and minimum shrinks it', () => {
    const n = 24;
    const grown = minimaxData(square(n, 8, 16), n, n, 'maximum', 2, 'alpha', 'both');
    // Two pixels outside the original edge is now covered.
    expect(px(grown, n, 6, 12)[3]).toBe(255);

    const shrunk = minimaxData(square(n, 8, 16), n, n, 'minimum', 2, 'alpha', 'both');
    // Two pixels inside the original edge is now clear.
    expect(px(shrunk, n, 9, 12)[3]).toBe(0);
    // The core survives.
    expect(px(shrunk, n, 12, 12)[3]).toBe(255);
  });

  it('max-then-min fills a hole WITHOUT moving the outer boundary', () => {
    /*
      The claim that justifies the compound operations existing at all. Running
      Maximum then Minimum by hand is only equivalent when both use the same
      radius — and the property being asserted is precisely that the second pass
      undoes the first pass's boundary shift while the filled hole stays filled.
    */
    const n = 32;
    const src = buffer(n, n, (x, y) => {
      const inSquare = x >= 8 && x < 24 && y >= 8 && y < 24;
      const inHole = x >= 14 && x < 18 && y >= 14 && y < 18;
      return [255, 255, 255, inSquare && !inHole ? 255 : 0];
    });
    const out = minimaxData(src, n, n, 'max-then-min', 3, 'alpha', 'both');

    // The hole is closed.
    expect(px(out, n, 16, 16)[3]).toBe(255);
    // The outer boundary has NOT moved: just inside is solid, just outside is clear.
    expect(px(out, n, 8, 16)[3]).toBe(255);
    expect(px(out, n, 7, 16)[3]).toBe(0);
    expect(px(out, n, 23, 16)[3]).toBe(255);
    expect(px(out, n, 24, 16)[3]).toBe(0);
  });

  it('min-then-max removes a speck without eroding the main shape', () => {
    const n = 32;
    const src = buffer(n, n, (x, y) => {
      const inSquare = x >= 8 && x < 24 && y >= 8 && y < 24;
      const speck = x >= 28 && x < 30 && y >= 4 && y < 6;
      return [255, 255, 255, inSquare || speck ? 255 : 0];
    });
    const out = minimaxData(src, n, n, 'min-then-max', 3, 'alpha', 'both');
    expect(px(out, n, 28, 4)[3]).toBe(0);
    expect(px(out, n, 8, 16)[3]).toBe(255);
    expect(px(out, n, 7, 16)[3]).toBe(0);
  });

  it('an alpha-only Minimax leaves colour untouched', () => {
    // Otherwise a spread matte drags smeared colour along its new edge.
    const n = 12;
    const src = buffer(n, n, (x, y) => [x * 20, y * 20, 7, x > 5 ? 255 : 0]);
    const before = [...src];
    const out = minimaxData(src, n, n, 'maximum', 2, 'alpha', 'both');
    for (let i = 0; i < n * n; i++) {
      expect({ i, rgb: [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]] })
        .toEqual({ i, rgb: [before[i * 4], before[i * 4 + 1], before[i * 4 + 2]] });
    }
  });

  it('a radius-0 Minimax is a no-op', () => {
    const n = 8;
    const src = buffer(n, n, (x, y) => [x, y, 0, x * 30]);
    const out = minimaxData(new Uint8ClampedArray(src), n, n, 'maximum', 0, 'alpha', 'both');
    expect([...out]).toEqual([...src]);
  });
});

// ── Blur & Sharpen ────────────────────────────────────────────────

describe('Channel Blur', () => {
  it('blurs ONE channel and leaves the other three byte-identical', () => {
    /*
      The independence claim, and the reason this cannot share the main blur's
      alpha-weighted kernel. If green, blue or alpha move at all, the per-channel
      passes are leaking into each other.
    */
    const w = 16;
    const h = 16;
    const src = buffer(w, h, (x, y) => [x < w / 2 ? 0 : 255, y * 15, 90, x * 15]);
    const before = [...src];
    const out = channelBlurData(src, w, h, { red: 3, green: 0, blue: 0, alpha: 0 }, 'both', true);

    let redMoved = false;
    for (let i = 0; i < w * h; i++) {
      if (out[i * 4] !== before[i * 4]) redMoved = true;
      expect({ i, g: out[i * 4 + 1] }).toEqual({ i, g: before[i * 4 + 1] });
      expect({ i, b: out[i * 4 + 2] }).toEqual({ i, b: before[i * 4 + 2] });
      expect({ i, a: out[i * 4 + 3] }).toEqual({ i, a: before[i * 4 + 3] });
    }
    expect(redMoved).toBe(true);
  });

  it('blurs alpha independently of colour — the matte-softening case', () => {
    const w = 16;
    const h = 16;
    const src = buffer(w, h, (x) => [200, 100, 50, x < w / 2 ? 0 : 255]);
    const before = [...src];
    const out = channelBlurData(src, w, h, { red: 0, green: 0, blue: 0, alpha: 4 }, 'both', true);

    for (let i = 0; i < w * h; i++) {
      expect({ i, r: out[i * 4] }).toEqual({ i, r: before[i * 4] });
    }
    // A soft edge now exists where there was a hard step.
    const edge = px(out, w, w / 2, 8)[3];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it('all-zero radii is a no-op', () => {
    const src = buffer(8, 8, (x, y) => [x, y, 1, 255]);
    const out = channelBlurData(new Uint8ClampedArray(src), 8, 8, { red: 0, green: 0, blue: 0, alpha: 0 }, 'both', true);
    expect([...out]).toEqual([...src]);
  });
});

describe('Unsharp Mask', () => {
  it('increases contrast across an edge without touching a flat field', () => {
    const w = 32;
    const h = 8;
    const step = (): Uint8ClampedArray => buffer(w, h, (x) => {
      const v = x < w / 2 ? 100 : 160;
      return [v, v, v, 255];
    });
    const before = step();
    const out = unsharpMaskData(step(), w, h, 200, 3, 0);

    // Immediately either side of the edge, the gap has widened.
    const gapBefore = px(before, w, w / 2, 4)[0] - px(before, w, w / 2 - 1, 4)[0];
    const gapAfter = px(out, w, w / 2, 4)[0] - px(out, w, w / 2 - 1, 4)[0];
    expect(gapAfter).toBeGreaterThan(gapBefore);

    // Far from the edge nothing has changed — sharpening a flat area would be
    // amplifying nothing, and is how a broken implementation shifts levels.
    expect(px(out, w, 1, 4)[0]).toBe(px(before, w, 1, 4)[0]);
  });

  it('threshold protects low-amplitude detail', () => {
    /*
      The control that separates a sharpen from a grain amplifier. A ±4 ripple
      must survive untouched under a threshold of 20, while the same image
      sharpens freely at threshold 0.
    */
    const w = 32;
    const h = 4;
    const noisy = (): Uint8ClampedArray => buffer(w, h, (x) => {
      const v = 128 + (x % 2 === 0 ? 4 : -4);
      return [v, v, v, 255];
    });
    const before = [...noisy()];

    const guarded = unsharpMaskData(noisy(), w, h, 300, 2, 20);
    expect([...guarded]).toEqual(before);

    const unguarded = unsharpMaskData(noisy(), w, h, 300, 2, 0);
    expect([...unguarded]).not.toEqual(before);
  });

  it('leaves alpha alone', () => {
    const w = 16;
    const h = 4;
    const src = buffer(w, h, (x) => [x * 15, x * 15, x * 15, x < w / 2 ? 0 : 255]);
    const before = [...src];
    const out = unsharpMaskData(src, w, h, 200, 3, 0);
    for (let i = 0; i < w * h; i++) {
      expect({ i, a: out[i * 4 + 3] }).toEqual({ i, a: before[i * 4 + 3] });
    }
  });

  it('amount 0 and radius 0 are both no-ops', () => {
    const src = buffer(8, 8, (x, y) => [x * 30, y * 30, 5, 255]);
    expect([...unsharpMaskData(new Uint8ClampedArray(src), 8, 8, 0, 3, 0)]).toEqual([...src]);
    expect([...unsharpMaskData(new Uint8ClampedArray(src), 8, 8, 200, 0, 0)]).toEqual([...src]);
  });
});
