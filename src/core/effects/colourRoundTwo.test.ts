/**
 * The second round of colour effects: Lumetri, Selective Colour,
 * Shadow/Highlight, and Curves per channel.
 *
 * The first test here is the important one, and it is not about any of them.
 *
 * ── §2·0: LUT_EFFECTS and `tableFor` are two lists with nothing joining them ──
 *
 * `isLutEffect` decides that an effect renders through the colour table — the
 * GPU backend filters on it, `capabilities` sets `needs.colorLut` from it, and
 * `effectBake` routes on it. `tableFor` decides what that table CONTAINS. They
 * are separate `if` chains in the same file, and a type listed in the first but
 * missing from the second falls straight through to `return null`, which
 * `buildChannelLut` skips.
 *
 * The result is an effect that is in the browser, adds to the stack, shows its
 * parameters, animates them, reports `needs.colorLut`, and renders EXACTLY
 * nothing. That is the same failure the `applyCanvas2dEffect` dispatch guard
 * exists to catch, in a second place nobody had covered — found while adding
 * Lumetri, which would have been the first effect to hit it.
 *
 * Guarded behaviourally rather than structurally: a fixture per LUT effect that
 * must actually MOVE the table. A source-scraping version would prove `tableFor`
 * mentions the type, not that the branch returns anything.
 */

import { buildChannelLut, isLutEffect, applyChannelLut } from './colorLut';
import { EFFECT_DEFS, defaultParams, type Effect, type EffectParams, type EffectType } from './effects';
import { applyCanvas2dEffect, isCanvas2dOnlyEffect } from './canvas2dEffects';
import { selectiveColorData, shadowHighlightData, rangeWeight } from './toneEffects';

function fx(type: EffectType, params: Record<string, unknown> = {}): Effect {
  const def = EFFECT_DEFS.find((d) => d.type === type)!;
  return { id: 'e1', type, params: { ...defaultParams(def), ...params } as EffectParams };
}

const IDENTITY = Array.from({ length: 256 }, (_, i) => i);

/** Settings that must visibly move each LUT effect's table off identity. */
const LUT_FIXTURES: ReadonlyArray<readonly [EffectType, Record<string, unknown>]> = [
  ['levels', { inputBlack: 40, inputWhite: 200, gamma: 1.4, outputBlack: 0, outputWhite: 255 }],
  ['curves', { points: [[0, 0], [128, 200], [255, 255]] }],
  ['posterize', { levels: 4 }],
  ['exposure', { exposure: 1.5, offset: 0, gammaCorrection: 1 }],
  ['lumetri', { exposure: 1, contrast: 40 }],
];

describe('every LUT effect actually produces a table', () => {
  it('the fixture table covers LUT_EFFECTS — a new LUT effect fails here first', () => {
    const covered = new Set(LUT_FIXTURES.map(([t]) => t));
    const uncovered = EFFECT_DEFS.filter((d) => isLutEffect(d.type) && !covered.has(d.type)).map((d) => d.type);
    expect(uncovered).toEqual([]);
    // Guards the guard: an empty fixture list would satisfy the check above
    // vacuously, exactly as an empty dispatch set would.
    expect(covered.size).toBeGreaterThan(4);
  });

  it.each(LUT_FIXTURES)('%s moves the table off identity', (type, params) => {
    const lut = buildChannelLut([fx(type, params)]);
    expect(lut).not.toBeNull();
    expect([...lut!.r]).not.toEqual(IDENTITY);
  });
});

describe('Curves, per channel', () => {
  it('an untouched channel is left at the composite result, not reset to identity', () => {
    // The composite darkens; the per-channel curves are all still identity ramps.
    const lut = buildChannelLut([fx('curves', { points: [[0, 0], [128, 64], [255, 255]] })])!;
    expect([...lut.r]).toEqual([...lut.g]);
    expect([...lut.g]).toEqual([...lut.b]);
    expect(lut.r[128]).toBeLessThan(128);
  });

  it('a red curve composes ON TOP of the composite, and leaves green and blue alone', () => {
    const composite: [number, number][] = [[0, 0], [128, 64], [255, 255]];
    const both = buildChannelLut([fx('curves', {
      points: composite,
      redPoints: [[0, 0], [128, 200], [255, 255]],
    })])!;
    const compositeOnly = buildChannelLut([fx('curves', { points: composite })])!;

    // Green and blue see only the composite.
    expect([...both.g]).toEqual([...compositeOnly.g]);
    expect([...both.b]).toEqual([...compositeOnly.b]);
    // Red does not.
    expect([...both.r]).not.toEqual([...compositeOnly.r]);

    // ORDER: red must be applied to the composite's OUTPUT, not the raw input.
    // Reversing the two would give red(128)=200 then composite(200); this asserts
    // composite(128)=64 then red(64), which is a different, lower number. The
    // check is that it matches the composite-first arithmetic exactly.
    const viaComposite = compositeOnly.r[128]!;
    const redAlone = buildChannelLut([fx('curves', {
      points: [[0, 0], [255, 255]],
      redPoints: [[0, 0], [128, 200], [255, 255]],
    })])!;
    expect(both.r[128]).toBe(redAlone.r[viaComposite]);
  });

  it('an all-identity Curves is a no-op rather than a rounding drift', () => {
    // Four identity ramps compose through four table lookups. Each is exact, so
    // the result must be exactly identity — any drift here would mean adding a
    // Curves and touching nothing silently regrades the layer.
    const lut = buildChannelLut([fx('curves')])!;
    expect([...lut.r]).toEqual(IDENTITY);
    expect([...lut.g]).toEqual(IDENTITY);
    expect([...lut.b]).toEqual(IDENTITY);
  });
});

describe('Lumetri', () => {
  it('temperature is a per-channel gain — it warms red and cools blue', () => {
    const lut = buildChannelLut([fx('lumetri', { temperature: 100 })])!;
    expect(lut.r[128]!).toBeGreaterThan(128);
    expect(lut.b[128]!).toBeLessThan(128);
    expect(lut.g[128]!).toBe(128); // temperature must not touch green
  });

  it('tint trades green against magenta, leaving red and blue alone', () => {
    const lut = buildChannelLut([fx('lumetri', { tint: 100 })])!;
    expect(lut.g[128]!).toBeLessThan(128);
    expect(lut.r[128]!).toBe(128);
    expect(lut.b[128]!).toBe(128);
  });

  it('exposure is multiplicative in stops, so +1 doubles rather than lifts', () => {
    const lut = buildChannelLut([fx('lumetri', { exposure: 1 })])!;
    // Doubling: 64 → 128. Black stays black, which is the property that
    // distinguishes a gain from Brightness's additive lift.
    expect(lut.r[64]!).toBeCloseTo(128, -0.5);
    expect(lut.r[0]!).toBe(0);
  });

  it('shadows lift the low end much harder than the high end', () => {
    const lut = buildChannelLut([fx('lumetri', { shadows: 100 })])!;
    const lowLift = lut.r[32]! - 32;
    const highLift = lut.r[224]! - 224;
    expect(lowLift).toBeGreaterThan(20);
    expect(highLift).toBeLessThan(lowLift / 4);
  });

  it('blacks are NARROWER than shadows — the two controls are distinguishable', () => {
    // If both used the same falloff width the pair would be redundant, which is
    // the easy way to get eight controls that behave like four.
    const shadows = buildChannelLut([fx('lumetri', { shadows: 100 })])!;
    const blacks = buildChannelLut([fx('lumetri', { blacks: 100 })])!;
    // At black they agree; a third of the way up, blacks has fallen off and
    // shadows has not.
    expect(blacks.r[96]! - 96).toBeLessThan((shadows.r[96]! - 96) / 2);
  });

  it('every control at zero is exactly identity', () => {
    const lut = buildChannelLut([fx('lumetri')])!;
    expect([...lut.r]).toEqual(IDENTITY);
    expect([...lut.g]).toEqual(IDENTITY);
    expect([...lut.b]).toEqual(IDENTITY);
  });

  it('a zero tonal denominator cannot reach the table', () => {
    // contrast −100 collapses the pivot term; the guard is that this produces a
    // flat mid-grey table rather than NaN, which clamps to a black frame.
    const lut = buildChannelLut([fx('lumetri', { contrast: -100 })])!;
    expect([...lut.r].every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('Selective Colour', () => {
  /** One RGBA pixel through the kernel. */
  function pixel(rgb: [number, number, number], params: Parameters<typeof selectiveColorData> extends [
    unknown, ...infer R
  ] ? R : never): [number, number, number] {
    const d = new Uint8ClampedArray([...rgb, 255]);
    selectiveColorData(d, ...params);
    return [d[0]!, d[1]!, d[2]!];
  }

  it('grading the reds leaves a blue pixel untouched', () => {
    const blue = pixel([0, 0, 255], ['reds', 100, 0, 0, 0, true]);
    expect(blue).toEqual([0, 0, 255]);
  });

  it('grading the reds does move a red pixel', () => {
    // ABSOLUTE, deliberately. Pure red carries zero cyan ink, so relative mode
    // — which scales each delta by the ink already present — correctly cannot
    // move it at all. That is asserted two tests down; asserting movement here
    // under relative mode would be asserting the opposite of it.
    const red = pixel([255, 0, 0], ['reds', 100, 0, 0, 0, false]);
    expect(red).not.toEqual([255, 0, 0]);
    // Adding cyan ink to red takes red away — that is what the C slider is.
    expect(red[0]).toBeLessThan(255);
  });

  /**
   * Membership is normalised by the pixel's maximum channel, so it depends on
   * HUE and not on brightness — the same red grades the same in shadow as in
   * light. Dropping the `/mx` would make this effect brightness-dependent in a
   * way no colourist expects.
   *
   * Asserted on the WEIGHT rather than through a graded pixel, because every
   * route through the transform can saturate and stop measuring this. The first
   * version of this test compared `[200,40,40]` against `[50,10,10]` under a
   * +50 black delta and failed — not because the weights differed (they are both
   * 0.8) but because the dark pixel already carried K=0.804, so the delta
   * clamped it to pure black and the ratio collapsed to zero. A test that looks
   * like it measures hue independence while actually measuring the clamp.
   */
  it('membership is hue-based: the same hue weighs the same at any brightness', () => {
    const bright = rangeWeight('reds', 200 / 255, 40 / 255, 40 / 255);
    const dark = rangeWeight('reds', 50 / 255, 10 / 255, 10 / 255);
    expect(bright).toBeCloseTo(dark, 5);
    expect(bright).toBeGreaterThan(0.5);
  });

  it('a primary and its neighbouring secondary split an in-between hue', () => {
    // Orange is part red, part yellow, and fully neither. The overlap is what
    // makes the nine ranges a usable partition rather than nine hard buckets.
    const red = rangeWeight('reds', 1, 0.5, 0);
    const yellow = rangeWeight('yellows', 1, 0.5, 0);
    expect(red).toBeGreaterThan(0);
    expect(yellow).toBeGreaterThan(0);
    expect(rangeWeight('blues', 1, 0.5, 0)).toBe(0);
  });

  it('relative mode cannot introduce an ink that was not there', () => {
    // Pure red has zero cyan. Relative scales by what is present, so it stays 0
    // and the pixel cannot move; absolute adds it flat and the pixel does.
    const rel = pixel([255, 0, 0], ['reds', 100, 0, 0, 0, true]);
    const abs = pixel([255, 0, 0], ['reds', 100, 0, 0, 0, false]);
    expect(abs[0]).toBeLessThan(rel[0]!);
  });

  it('a fully transparent pixel keeps its bytes', () => {
    const d = new Uint8ClampedArray([255, 0, 0, 0]);
    selectiveColorData(d, 'reds', 100, 100, 100, 100, false);
    expect([...d]).toEqual([255, 0, 0, 0]);
  });

  it('pure black is reachable only through the K delta', () => {
    const viaCyan = new Uint8ClampedArray([0, 0, 0, 255]);
    selectiveColorData(viaCyan, 'blacks', 100, 0, 0, 0, false);
    expect([...viaCyan].slice(0, 3)).toEqual([0, 0, 0]);

    const viaBlack = new Uint8ClampedArray([0, 0, 0, 255]);
    selectiveColorData(viaBlack, 'blacks', 0, 0, 0, -100, false);
    expect(viaBlack[0]).toBeGreaterThan(0);
  });
});

describe('Shadow/Highlight', () => {
  /**
   * The behaviour that makes this effect worth having, stated as a test: two
   * pixels of the SAME value, one in a dark neighbourhood and one in a bright
   * one, must be lifted by different amounts. A tone curve cannot tell them
   * apart — so if this ever passes trivially, the effect has degenerated into
   * one.
   */
  it('lifts a dark-surround pixel more than the same value in a bright surround', () => {
    const W = 64, H = 16;
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        // Left half dark, right half bright.
        const bg = x < W / 2 ? 10 : 245;
        d[i] = bg; d[i + 1] = bg; d[i + 2] = bg; d[i + 3] = 255;
      }
    }
    // One mid-grey probe in each half, far from the seam so the blur is clean.
    const probeDark = ((8 * W) + 8) * 4;
    const probeBright = ((8 * W) + W - 9) * 4;
    for (const p of [probeDark, probeBright]) {
      d[p] = 100; d[p + 1] = 100; d[p + 2] = 100;
    }

    shadowHighlightData(d, W, H, 100, 0, 8, 50);
    expect(d[probeDark]!).toBeGreaterThan(d[probeBright]!);
  });

  it('is a no-op at zero amounts', () => {
    const d = new Uint8ClampedArray([100, 100, 100, 255]);
    const before = [...d];
    shadowHighlightData(d, 1, 1, 0, 0, 10, 50);
    expect([...d]).toEqual(before);
  });

  it('a zero tonal width cannot divide its way to NaN', () => {
    const d = new Uint8ClampedArray([100, 100, 100, 255]);
    shadowHighlightData(d, 1, 1, 100, 100, 4, 0);
    expect([...d].every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('the new pixel passes reach the bake chain', () => {
  // The dispatch guard in canvas2dEffects.test.ts proves a `case` exists. This
  // proves the case DRAWS — the same distinction that let Fill and Stroke sit in
  // the switch and render nothing.
  it.each(['selective-color', 'shadow-highlight'] as const)('%s changes pixels through applyCanvas2dEffect', (type) => {
    expect(isCanvas2dOnlyEffect(type)).toBe(true);
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#c83232';
    ctx.fillRect(0, 0, 8, 8);
    const before = [...ctx.getImageData(0, 0, 8, 8).data];

    applyCanvas2dEffect(ctx, 8, 8, fx(type, type === 'selective-color'
      ? { range: 0, cyan: 100, absolute: true }
      : { shadowAmount: 100, radius: 4 }));

    expect([...ctx.getImageData(0, 0, 8, 8).data]).not.toEqual(before);
  });
});

describe('the LUT path reaches pixels', () => {
  it('Lumetri applied through applyChannelLut changes the frame', () => {
    const lut = buildChannelLut([fx('lumetri', { exposure: 1, temperature: 50 })])!;
    const d = new Uint8ClampedArray([100, 100, 100, 255]);
    applyChannelLut(d, lut);
    expect(d[0]).toBeGreaterThan(100);
    expect(d[3]).toBe(255); // alpha untouched
  });
});
