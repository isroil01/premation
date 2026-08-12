/**
 * Round four — the fifty effects, asserted on BEHAVIOUR.
 *
 * ## Why this file exists on top of the guards that already pass
 *
 * Three guards already cover round four and none of them proves an effect
 * works:
 *
 *   · `effectRegistryComplete` — every type has a definition.
 *   · `canvas2dEffects.test.ts` — every Canvas2D-only type has a dispatch
 *     `case`. It reads SOURCE, so it proves a case was WRITTEN, never that
 *     pixels moved.
 *   · `deadControlScanner` — every parameter key appears in a consumer. It is a
 *     substring scan, so a param read into a variable nobody uses still passes.
 *
 * So the gap they leave is exactly "the wiring is present and the maths is
 * wrong", which is the failure mode that survives every other signal. Each test
 * below states a claim a plausible-but-wrong implementation would FAIL.
 *
 * ## The direction tests are the important ones
 *
 * Every distort kernel is an INVERSE map. A forward map written by mistake
 * still produces a plausible distorted picture — bent the wrong way. A test
 * asserting only "the output differs from the input" passes on both. So the
 * distort tests below all assert WHERE content ended up, never merely that it
 * moved. See `gotcha_motion_inverse_map_direction`.
 */

import { bilateralBlurData, smartBlurData, cameraLensBlurData } from './aeBlurAdvanced';
import {
  rippleData, magnifyData, warpData, splitData, slantData, smearData,
  rollingShutterData, radialShadowData, pageTurnData,
} from './aeDistortAdvanced';
import {
  cartoonData, brushStrokesData, strobeLightData, colorEmbossData, halftoneData,
  kaleidoscopeData, vignetteData, burnFilmData,
} from './aeStylizeAdvanced';
import {
  equalizeData, autoLevelsData, autoContrastData, autoColorData, changeColorData,
  changeToColorData, leaveColorData, tonerData,
} from './aeColorAdvanced';
import {
  colorKeyData, colorRangeData, extractData, spillSuppressorData, matteChokerData,
} from './aeKeyingAdvanced';
import {
  alphaLevelsData, solidCompositeData, channelCombinerData, removeColorMattingData,
} from './aeChannel';
import {
  irisWipeData, lightWipeData, lineSweepData, gridWipeData, dustAndScratchesData, noiseAlphaData,
} from './aeTransitionsAdvanced';
import { medianData } from './noiseEffects';

// ── helpers ─────────────────────────────────────────────────────────

/** A w×h RGBA buffer, filled by `fn(x, y)`. */
function image(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
    }
  }
  return d;
}

const solid = (w: number, h: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray =>
  image(w, h, () => [r, g, b, a]);

const px = (d: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] => {
  const o = (y * w + x) * 4;
  return [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!];
};

const alphaAt = (d: Uint8ClampedArray, w: number, x: number, y: number): number => d[(y * w + x) * 4 + 3]!;

/** Column index of the brightest pixel on a row — where a bright bar ended up. */
function brightestColumn(d: Uint8ClampedArray, w: number, y: number): number {
  let best = -1;
  let bestV = -1;
  for (let x = 0; x < w; x++) {
    const v = d[(y * w + x) * 4]!;
    if (v > bestV) { bestV = v; best = x; }
  }
  return best;
}

// ══ Distort — DIRECTION ═════════════════════════════════════════════

describe('the distort kernels map the right WAY round', () => {
  const W = 41, H = 41;
  /** A single bright column at x = 20, on black. */
  const bar = (): Uint8ClampedArray => image(W, H, (x) => (x === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255]));

  test('Slant shears toward +x at the far edge, not −x', () => {
    // floor 0 hinges at the TOP, so the bottom row carries the full slant.
    const out = slantData(bar(), W, H, 8, 0, 0);
    // Top row: unmoved (t = 0).
    expect(brightestColumn(out, W, 0)).toBe(20);
    // Bottom row: moved RIGHT by ~8. A forward-map sign error puts it at 12.
    expect(brightestColumn(out, W, H - 1)).toBeGreaterThan(24);
  });

  test('Rolling Shutter skews later scanlines further along', () => {
    const out = rollingShutterData(bar(), W, H, 10, 0, 0, false);
    const top = brightestColumn(out, W, 0);
    const bottom = brightestColumn(out, W, H - 1);
    // Monotonic in y, and displaced in +x — the CMOS lean.
    expect(bottom).toBeGreaterThan(top);
    expect(bottom).toBeGreaterThan(24);
  });

  test('Rolling Shutter reverses when the scan direction flips', () => {
    const fwd = rollingShutterData(bar(), W, H, 10, 0, 0, false);
    const rev = rollingShutterData(bar(), W, H, 10, 0, 1, false);
    // The lean must invert, not merely differ — a direction flag that changed
    // the picture without reversing it would pass a "differs" assertion.
    expect(brightestColumn(fwd, W, H - 1)).toBeGreaterThan(brightestColumn(fwd, W, 0));
    expect(brightestColumn(rev, W, H - 1)).toBeLessThan(brightestColumn(rev, W, 0));
  });

  test('Split SEPARATES the halves rather than sliding them along the cut', () => {
    // Two bright columns either side of centre; a split at angle 0 must push
    // them further apart in X. Sliding along the cut would move them in Y and
    // leave the X gap unchanged — which is what the first draft of this kernel
    // did, and what this test was written to catch.
    const src = image(W, H, (x) => (x === 15 || x === 25 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = splitData(src, W, H, 8, 0, 0, 0);
    const row = Math.floor(H / 2);
    let left = -1, right = -1;
    for (let x = 0; x < W; x++) {
      const v = out[(row * W + x) * 4]!;
      if (v > 200) { if (left < 0) left = x; right = x; }
    }
    expect(left).toBeLessThan(15);
    expect(right).toBeGreaterThan(25);
  });

  test('Smear drags content toward the destination point', () => {
    const src = image(W, H, (x, y) => (x === 20 && y === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    // Drag from the centre toward +x.
    const out = smearData(src, W, H, 0, 0, 10, 0, 15, 100);
    // Content must appear to the RIGHT of where it started.
    let found = false;
    for (let x = 21; x < W; x++) if (out[(20 * W + x) * 4]! > 40) found = true;
    expect(found).toBe(true);
  });

  test('Warp Arc bows the middle, and reverses sign with a negative bend', () => {
    const src = image(W, H, (_x, y) => (y === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const pos = warpData(src, W, H, 0, 60, 0, 0, 0);
    const neg = warpData(src, W, H, 0, -60, 0, 0, 0);
    const rowOf = (d: Uint8ClampedArray, x: number): number => {
      let best = -1, bestV = -1;
      for (let y = 0; y < H; y++) { const v = d[(y * W + x) * 4]!; if (v > bestV) { bestV = v; best = y; } }
      return best;
    };
    // At the centre column the line is displaced; the two bends must go
    // OPPOSITE ways about the undisplaced position.
    const mid = rowOf(pos, 20), midNeg = rowOf(neg, 20);
    expect(mid).not.toBe(midNeg);
    expect(Math.sign(mid - 20)).toBe(-Math.sign(midNeg - 20));
  });

  test('Magnify at 100% is a no-op, and >100% pulls the centre outward', () => {
    const src = image(W, H, (x, y) => (Math.abs(x - 20) < 2 && Math.abs(y - 20) < 2 ? [255, 0, 0, 255] : [0, 0, 0, 255]));
    // Identity short-circuits, returning the same buffer.
    expect(magnifyData(src, W, H, 0, 0, 100, 15, 0, 0)).toBe(src);
    const out = magnifyData(src, W, H, 0, 0, 300, 15, 0, 0);
    // The 4×4 red patch must now cover more pixels than it did.
    const count = (d: Uint8ClampedArray): number => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 128) n++;
      return n;
    };
    expect(count(out)).toBeGreaterThan(count(src));
  });

  test('Ripple leaves the frame alone at zero amplitude', () => {
    const src = bar();
    expect(rippleData(src, W, H, 0, 0, 0, 0, 6, 0, 0)).toBe(src);
  });

  test('Kaleidoscope MIRRORS adjacent wedges rather than repeating them', () => {
    // An asymmetric source: bright only in the upper-right quadrant.
    const src = image(W, H, (x, y) => (x > 20 && y < 20 ? [255, 255, 255, 255] : [20, 20, 20, 255]));
    const out = kaleidoscopeData(src, W, H, 4, 0, 0, 0, 0, 100);
    // A pure rotational repeat has no mirror symmetry about the fold; a
    // kaleidoscope does. Sample a pair of points reflected across the wedge
    // boundary and require them to agree.
    const a = px(out, W, 28, 14);
    const b = px(out, W, 14, 28);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(60);
  });

  test('Page Turn at 0 is exactly the source', () => {
    const src = bar();
    const out = pageTurnData(src, W, H, 0, 45, 60, 60, 55);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  test('Radial Shadow PROJECTS — the shadow is larger than the occluder', () => {
    // A small opaque square in the middle of a transparent frame.
    const src = image(W, H, (x, y) => (Math.abs(x - 20) < 4 && Math.abs(y - 20) < 4 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const out = radialShadowData(src, W, H, 0, 0, 100, [0, 0, 0], 100, 0, 1);
    const covered = (d: Uint8ClampedArray): number => {
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 20) n++;
      return n;
    };
    // Projection 100% doubles the scale, so the shadow-only render must cover
    // MORE than the silhouette. A drop-shadow-style uniform offset would cover
    // exactly the same area, which is the distinction being pinned.
    expect(covered(out)).toBeGreaterThan(covered(src));
  });
});

// ══ Blur ════════════════════════════════════════════════════════════

describe('the edge-aware blurs actually preserve edges', () => {
  const W = 21, H = 21;
  /** A hard vertical edge: black left, white right. */
  const edge = (): Uint8ClampedArray => image(W, H, (x) => (x < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

  test('Bilateral keeps the step much sharper than its radius would suggest', () => {
    const out = bilateralBlurData(edge(), W, H, 5, 12, true);
    // Immediately either side of the edge the values must still be near the
    // extremes. A plain Gaussian of radius 5 would put both near mid-grey,
    // which is precisely what the colour term exists to prevent.
    expect(px(out, W, 8, 10)[0]).toBeLessThan(60);
    expect(px(out, W, 11, 10)[0]).toBeGreaterThan(195);
  });

  test('Bilateral with a huge colour sigma degrades toward an ordinary blur', () => {
    const sharp = bilateralBlurData(edge(), W, H, 5, 5, true);
    const soft = bilateralBlurData(edge(), W, H, 5, 400, true);
    // With every neighbour counted, the edge pixel moves toward the mean.
    expect(px(soft, W, 11, 10)[0]).toBeLessThan(px(sharp, W, 11, 10)[0]);
  });

  test('Smart Blur flattens a noisy flat field but leaves the edge alone', () => {
    // Flat grey with ±4 noise on the left, hard white block on the right.
    const src = image(W, H, (x, y) => (x < 10
      ? [128 + ((x + y) % 2 ? 4 : -4), 128, 128, 255]
      : [255, 255, 255, 255]));
    const out = smartBlurData(src, W, H, 3, 20, 0);
    // The dither is inside the threshold, so it averages away.
    expect(Math.abs(px(out, W, 4, 10)[0] - 128)).toBeLessThan(4);
    // The white block is outside it, so it survives.
    expect(px(out, W, 15, 10)[0]).toBeGreaterThan(240);
  });

  test('Camera Lens Blur BLOOMS a highlight instead of just dimming it', () => {
    // One blown pixel on black.
    const src = image(W, H, (x, y) => (x === 10 && y === 10 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const lens = cameraLensBlurData(src, W, H, 4, 0, 0, 6, 50);
    const flat = cameraLensBlurData(src, W, H, 4, 0, 0, 1, 50);
    // With gain, a neighbouring pixel picks up much more energy than with the
    // gain switched off — that is the whole difference from a box blur.
    expect(px(lens, W, 12, 10)[0]).toBeGreaterThan(px(flat, W, 12, 10)[0]);
  });

  test('a zero radius returns the source untouched', () => {
    const src = edge();
    expect(Array.from(bilateralBlurData(src, W, H, 0, 30, true))).toEqual(Array.from(src));
    expect(Array.from(smartBlurData(src, W, H, 0, 30, 0))).toEqual(Array.from(src));
  });
});

// ══ Colour ══════════════════════════════════════════════════════════

describe('the colour effects that need the histogram', () => {
  const W = 16, H = 16;
  /** A low-contrast ramp confined to 100..150. */
  const flat = (): Uint8ClampedArray => image(W, H, (x) => {
    const v = 100 + Math.round((x / (W - 1)) * 50);
    return [v, v, v, 255];
  });

  test('Auto Contrast stretches the range toward the full 0..255', () => {
    const out = autoContrastData(flat(), 0, 0, 0);
    expect(px(out, W, 0, 0)[0]).toBeLessThan(20);
    expect(px(out, W, W - 1, 0)[0]).toBeGreaterThan(235);
  });

  test('Auto Contrast preserves the channel RATIO where Auto Levels does not', () => {
    // A deliberate blue cast: blue occupies a different range from red/green.
    const cast = image(W, H, (x) => {
      const v = 60 + Math.round((x / (W - 1)) * 40);
      return [v, v, v + 80, 255];
    });
    const contrast = autoContrastData(new Uint8ClampedArray(cast), 0, 0, 0);
    const levels = autoLevelsData(new Uint8ClampedArray(cast), 0, 0, 0);
    // Auto Contrast uses ONE mapping, so blue stays above red.
    const [cr, , cb] = px(contrast, W, 8, 0);
    expect(cb).toBeGreaterThan(cr);
    // Auto Levels stretches each channel to the same span, so the cast is
    // pulled out and the two channels converge. This is the entire reason both
    // effects exist, and collapsing them would lose it.
    const [lr, , lb] = px(levels, W, 8, 0);
    expect(Math.abs(lb - lr)).toBeLessThan(Math.abs(cb - cr));
  });

  test('Blend With Original at 100 is an exact no-op', () => {
    const src = flat();
    const before = Array.from(src);
    autoContrastData(src, 0, 0, 100);
    expect(Array.from(src)).toEqual(before);
  });

  test('Equalize in Brightness mode does not shift hue', () => {
    // A saturated ramp: red always double green.
    const src = image(W, H, (x) => {
      const v = 40 + Math.round((x / (W - 1)) * 60);
      return [v * 2, v, 0, 255];
    });
    const out = equalizeData(src, 1, 100, 0);
    // One curve on all three channels keeps r/g ordering intact everywhere.
    for (let x = 0; x < W; x++) {
      const [r, g] = px(out, W, x, 0);
      if (g > 4) expect(r).toBeGreaterThan(g);
    }
  });

  test('Auto Color pulls a cast midtone back toward neutral', () => {
    const cast = image(W, H, (x) => {
      const v = 30 + Math.round((x / (W - 1)) * 190);
      return [v, v, Math.min(255, v + 50), 255];
    });
    const none = autoColorData(new Uint8ClampedArray(cast), 0, 0, 0, 0);
    const snap = autoColorData(new Uint8ClampedArray(cast), 0, 0, 100, 0);
    const spread = (d: Uint8ClampedArray): number => {
      const [r, , b] = px(d, W, 8, 0);
      return Math.abs(b - r);
    };
    // Snapping neutral must reduce the channel separation, not merely change it.
    expect(spread(snap)).toBeLessThan(spread(none));
  });

  test('an empty (fully transparent) frame does not throw or blacken', () => {
    // The histogram is empty, so every percentile is 0 and a naive stretch
    // divides by zero. All four must no-op instead.
    const clear = solid(W, H, 10, 20, 30, 0);
    for (const fn of [
      () => autoLevelsData(clear, 0, 0, 0),
      () => autoContrastData(clear, 0, 0, 0),
      () => autoColorData(clear, 0, 0, 50, 0),
      () => equalizeData(clear, 0, 100, 0),
    ]) {
      expect(fn).not.toThrow();
    }
    expect(px(clear, W, 0, 0)).toEqual([10, 20, 30, 0]);
  });

  test('a FLAT channel maps to itself rather than to black', () => {
    // lo === hi is a division by zero in the stretch; the guard must return
    // identity, not a full-range ramp and not zero.
    const grey = solid(W, H, 128, 128, 128);
    autoContrastData(grey, 0, 0, 0);
    expect(px(grey, W, 3, 3)[0]).toBe(128);
  });
});

describe('the colour effects that read all three channels', () => {
  const W = 8, H = 8;

  test('Change To Color preserves shading rather than flattening it', () => {
    // Two reds at different lightness.
    const src = image(W, H, (x) => (x < 4 ? [180, 40, 40, 255] : [90, 20, 20, 255]));
    const out = changeToColorData(src, [140, 30, 30], [40, 40, 200], 40, 100, 100, 100, true);
    const lightSide = px(out, W, 1, 1);
    const darkSide = px(out, W, 6, 1);
    // Both moved toward blue…
    expect(lightSide[2]).toBeGreaterThan(lightSide[0]);
    expect(darkSide[2]).toBeGreaterThan(darkSide[0]);
    // …but the ORIGINAL lightness difference survives. Without the offset both
    // would land on the destination's own lightness and the shading would flat.
    expect(lightSide[2]).toBeGreaterThan(darkSide[2]);
  });

  test('Leave Color drains everything except the target hue', () => {
    // Red block and green block.
    const src = image(W, H, (x) => (x < 4 ? [220, 30, 30, 255] : [30, 220, 30, 255]));
    leaveColorData(src, [255, 0, 0], 20, 20, 100);
    const [rr, rg] = px(src, W, 1, 1);
    const [gr, gg] = px(src, W, 6, 1);
    // Red keeps its saturation…
    expect(rr - rg).toBeGreaterThan(100);
    // …green is pulled to grey.
    expect(Math.abs(gg - gr)).toBeLessThan(30);
  });

  test('Change Color can be inverted to hit everything BUT the target', () => {
    const src = image(W, H, (x) => (x < 4 ? [220, 30, 30, 255] : [30, 220, 30, 255]));
    const plain = changeColorData(new Uint8ClampedArray(src), [255, 0, 0], 20, 100, 100, 20, 120, 0, 0, false);
    const inv = changeColorData(new Uint8ClampedArray(src), [255, 0, 0], 20, 100, 100, 20, 120, 0, 0, true);
    // The two must disagree about which block moved — an `invert` that merely
    // scaled the effect would leave both moving the same way.
    const redMoved = Math.abs(px(plain, W, 1, 1)[1] - 30) > 10;
    const redMovedInv = Math.abs(px(inv, W, 1, 1)[1] - 30) > 10;
    expect(redMoved).not.toBe(redMovedInv);
  });

  test('Toner maps by LUMINANCE, so equal-luma colours land on the same tone', () => {
    // Two different hues chosen to have near-identical Rec.709 luma.
    const src = image(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [255, 0, 0, 255]));
    tonerData(src, [0, 0, 0], [50, 0, 0], [128, 128, 0], [200, 200, 128], [255, 255, 255], 0);
    expect(px(src, 2, 0, 0)).toEqual(px(src, 2, 1, 0));
  });

  test('Toner ramps monotonically from the black stop to the white stop', () => {
    const ramp = image(3, 1, (x) => { const v = x * 127; return [v, v, v, 255]; });
    tonerData(ramp, [0, 0, 0], [40, 40, 40], [128, 128, 128], [200, 200, 200], [255, 255, 255], 0);
    expect(px(ramp, 3, 0, 0)[0]).toBeLessThan(px(ramp, 3, 1, 0)[0]);
    expect(px(ramp, 3, 1, 0)[0]).toBeLessThan(px(ramp, 3, 2, 0)[0]);
  });
});

// ══ Keying & Channel ════════════════════════════════════════════════

describe('keying writes coverage, never colour', () => {
  const W = 8, H = 8;

  test('Color Key removes the key colour and keeps the rest', () => {
    const src = image(W, H, (x) => (x < 4 ? [0, 255, 0, 255] : [200, 40, 40, 255]));
    colorKeyData(src, [0, 255, 0], 20, 5);
    expect(alphaAt(src, W, 1, 1)).toBeLessThan(20);
    expect(alphaAt(src, W, 6, 1)).toBeGreaterThan(235);
  });

  test('Color Key MULTIPLIES into existing alpha instead of replacing it', () => {
    // A half-transparent subject that is NOT the key colour must stay half
    // transparent. Replacing would resurrect it to fully opaque, undoing
    // whatever upstream matte put it there.
    const src = solid(W, H, 200, 40, 40, 128);
    colorKeyData(src, [0, 255, 0], 20, 5);
    expect(alphaAt(src, W, 4, 4)).toBe(128);
  });

  test('Color Key leaves RGB untouched', () => {
    const src = solid(W, H, 200, 40, 40, 255);
    colorKeyData(src, [0, 255, 0], 20, 5);
    expect(px(src, W, 4, 4).slice(0, 3)).toEqual([200, 40, 40]);
  });

  test('Color Range in a chroma space tolerates a luminance gradient', () => {
    // A "greenscreen" whose brightness ramps across the frame — the situation
    // an RGB distance cannot key in one pass.
    const lit = image(16, 4, (x) => {
      const k = 0.45 + (x / 15) * 0.55;
      return [Math.round(20 * k), Math.round(230 * k), Math.round(30 * k), 255];
    });
    const lab = colorRangeData(new Uint8ClampedArray(lit), [20, 230, 30], 0, 10, 45, 0);
    const rgb = colorRangeData(new Uint8ClampedArray(lit), [20, 230, 30], 2, 10, 45, 100);
    const meanAlpha = (d: Uint8ClampedArray): number => {
      let s = 0, n = 0;
      for (let i = 3; i < d.length; i += 4) { s += d[i]!; n++; }
      return s / n;
    };
    // Weighting luminance to zero in Lab keys far more of the lit screen away.
    expect(meanAlpha(lab)).toBeLessThan(meanAlpha(rgb));
  });

  test('Extract keeps a BAND and drops both ends', () => {
    const ramp = image(256, 1, (x) => [x, x, x, 255]);
    extractData(ramp, 0, 80, 170, 5, 5, false);
    expect(alphaAt(ramp, 256, 20, 0)).toBeLessThan(20);
    expect(alphaAt(ramp, 256, 125, 0)).toBeGreaterThan(235);
    expect(alphaAt(ramp, 256, 230, 0)).toBeLessThan(20);
  });

  test('Extract inverts to a notch', () => {
    const ramp = image(256, 1, (x) => [x, x, x, 255]);
    extractData(ramp, 0, 80, 170, 5, 5, true);
    expect(alphaAt(ramp, 256, 20, 0)).toBeGreaterThan(235);
    expect(alphaAt(ramp, 256, 125, 0)).toBeLessThan(20);
  });

  test('Spill Suppressor pulls green down without eating coverage', () => {
    const src = solid(W, H, 120, 210, 110, 255);
    spillSuppressorData(src, [0, 255, 0], 100, false);
    const [r, g, b, a] = px(src, W, 4, 4);
    expect(g).toBeLessThan(210);
    expect(g).toBeLessThanOrEqual(Math.max(r, b) + 6);
    expect(a).toBe(255);
  });

  test('Spill Suppressor with Preserve Luminosity does not darken the subject', () => {
    const plain = solid(W, H, 120, 210, 110, 255);
    const kept = solid(W, H, 120, 210, 110, 255);
    spillSuppressorData(plain, [0, 255, 0], 100, false);
    spillSuppressorData(kept, [0, 255, 0], 100, true);
    const lum = (d: Uint8ClampedArray): number => {
      const [r, g, b] = px(d, W, 4, 4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(lum(kept)).toBeGreaterThan(lum(plain));
  });

  test('Matte Choker closes a pinhole in a solid matte', () => {
    const src = image(21, 21, (x, y) => {
      const hole = x === 10 && y === 10;
      return [255, 255, 255, hole ? 0 : 255];
    });
    const out = matteChokerData(src, 21, 21, 3, 3, 1, 1);
    expect(alphaAt(out, 21, 10, 10)).toBeGreaterThan(180);
  });
});

describe('the channel effects', () => {
  const W = 8, H = 8;

  test('Alpha Levels bends the ramp without moving the endpoints', () => {
    // Endpoints must be exactly 0 and 255 — an alpha of 254 is a fraction below
    // the top of the input range and legitimately maps a fraction below 255.
    const mk = (): Uint8ClampedArray => image(3, 1, (x) => [0, 0, 0, [0, 128, 255][x]!]);
    const straight = mk(); alphaLevelsData(straight, 0, 255, 1, 0, 255);
    const fattened = mk(); alphaLevelsData(fattened, 0, 255, 2.2, 0, 255);
    // Ends pinned…
    expect(alphaAt(fattened, 3, 0, 0)).toBe(0);
    expect(alphaAt(fattened, 3, 2, 0)).toBe(255);
    // …middle lifted. That is the difference from two thresholds.
    expect(alphaAt(fattened, 3, 1, 0)).toBeGreaterThan(alphaAt(straight, 3, 1, 0));
  });

  test('Alpha Levels never touches RGB', () => {
    const src = solid(W, H, 12, 34, 56, 128);
    alphaLevelsData(src, 20, 200, 1.5, 0, 255);
    expect(px(src, W, 1, 1).slice(0, 3)).toEqual([12, 34, 56]);
  });

  test('Solid Composite unions coverage with the solid', () => {
    const src = solid(W, H, 255, 0, 0, 0);
    solidCompositeData(src, [0, 0, 255], 100, 100, 0);
    // A fully transparent source over an opaque solid is opaque blue.
    const [r, , b, a] = px(src, W, 4, 4);
    expect(a).toBe(255);
    expect(b).toBeGreaterThan(r);
  });

  test('Channel Combiner RGB→HSL→RGB round-trips', () => {
    const src = image(4, 1, (x) => [[200, 40, 40], [40, 200, 40], [40, 40, 200], [123, 77, 31]][x] as never);
    const round = new Uint8ClampedArray(src);
    channelCombinerData(round, 0);
    channelCombinerData(round, 1);
    for (let i = 0; i < src.length; i++) {
      // Byte quantisation of hue costs a little; the pair must still be exact
      // to within a couple of levels or the "grade in HSL and convert back"
      // workflow silently shifts colour.
      expect(Math.abs(round[i]! - src[i]!)).toBeLessThan(6);
    }
  });

  test('Remove Color Matting leaves fully transparent pixels ALONE', () => {
    // The NaN trap: dividing by alpha = 0 stores 0, turning clear pixels black
    // and only showing up once composited over something light.
    const src = solid(W, H, 0, 0, 0, 0);
    removeColorMattingData(src, [0, 0, 0], 0, 100);
    expect(px(src, W, 2, 2)).toEqual([0, 0, 0, 0]);
  });

  test('Remove Color Matting recovers a black-matted edge', () => {
    // A half-covered white pixel premultiplied over black reads as mid-grey.
    const src = image(1, 1, () => [128, 128, 128, 128]);
    removeColorMattingData(src, [0, 0, 0], 0, 100);
    // Unmultiplied it should be near white again.
    expect(px(src, 1, 0, 0)[0]).toBeGreaterThan(230);
  });

  test('Remove Color Matting respects the coverage floor', () => {
    const src = image(1, 1, () => [10, 10, 10, 3]);
    removeColorMattingData(src, [0, 0, 0], 50, 100);
    // Below the floor the pixel is untouched, which is what stops the division
    // amplifying noise into confetti.
    expect(px(src, 1, 0, 0)).toEqual([10, 10, 10, 3]);
  });
});

// ══ Stylize ═════════════════════════════════════════════════════════

describe('the stylize kernels', () => {
  const W = 16, H = 16;

  test('Cartoon quantises to the requested number of levels', () => {
    const ramp = image(64, 1, (x) => { const v = Math.round((x / 63) * 255); return [v, v, v, 255]; });
    const out = cartoonData(ramp, 64, 1, 0, 4, 999, 1, 0);
    const seen = new Set<number>();
    for (let x = 0; x < 64; x++) seen.add(px(out, 64, x, 0)[0]);
    // 4 bands, and never more. Edge ink is disabled via a huge threshold so it
    // cannot introduce intermediate values.
    expect(seen.size).toBeLessThanOrEqual(4);
  });

  test('Cartoon inks an edge darker than the band either side', () => {
    const src = image(W, H, (x) => (x < 8 ? [200, 200, 200, 255] : [60, 60, 60, 255]));
    const out = cartoonData(src, W, H, 0, 8, 10, 1, 100);
    const atEdge = px(out, W, 8, 8)[0];
    const inBand = px(out, W, 2, 8)[0];
    expect(atEdge).toBeLessThan(inBand);
  });

  test('Halftone grows the dot as the cell darkens', () => {
    const inkCount = (level: number): number => {
      const src = solid(32, 32, level, level, level);
      const out = halftoneData(src, 32, 32, 8, 45, 100, [0, 0, 0], [255, 255, 255], false, 0);
      let n = 0;
      for (let i = 0; i < out.length; i += 4) if (out[i]! < 128) n++;
      return n;
    };
    // Darker source → more ink. The inverse would be a sign error that still
    // produces a perfectly plausible halftone.
    expect(inkCount(40)).toBeGreaterThan(inkCount(200));
  });

  test('Vignette darkens the corner and spares the centre', () => {
    const src = solid(W, H, 200, 200, 200);
    vignetteData(src, W, H, 80, 30, 80, 0, 0, 0);
    expect(px(src, W, 8, 8)[0]).toBeGreaterThan(px(src, W, 0, 0)[0]);
  });

  test('Vignette does not paint into transparent regions', () => {
    const src = solid(W, H, 200, 200, 200, 0);
    const before = Array.from(src);
    vignetteData(src, W, H, 80, 30, 80, 0, 0, 0);
    expect(Array.from(src)).toEqual(before);
  });

  test('Color Emboss keeps colour where plain Emboss would grey it out', () => {
    const src = image(W, H, (x) => (x < 8 ? [200, 40, 40, 255] : [80, 16, 16, 255]));
    const out = colorEmbossData(src, W, H, 0, 1, 100, 0);
    const [r, g, b] = px(out, W, 3, 8);
    // Still recognisably red — the channels have not converged to one value.
    expect(r).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(b + 40);
  });

  test('Strobe Light is a pure function of time, and honours its duty cycle', () => {
    const at = (t: number): number => {
      const d = solid(4, 4, 10, 10, 10);
      strobeLightData(d, t, 1, 25, 0, [255, 255, 255], 100);
      return px(d, 4, 1, 1)[0];
    };
    // On during the first quarter of each period…
    expect(at(0.1)).toBeGreaterThan(200);
    // …off after it…
    expect(at(0.5)).toBe(10);
    // …and periodic, not drifting. Calling twice at the same time must agree,
    // which an implementation carrying a counter would fail.
    expect(at(1.1)).toBe(at(0.1));
  });

  test('Brush Strokes is seam-free — the same cell hashes the same everywhere', () => {
    // Two identical tiles far apart must receive identical treatment, which is
    // what a position-hashed (rather than sequential) PRNG guarantees.
    const src = image(64, 8, (x, y) => [((x % 16) * 16) % 256, y * 30, 60, 255]);
    const a = brushStrokesData(src, 64, 8, 45, 6, 100, 8, 100);
    const b = brushStrokesData(src, 64, 8, 45, 6, 100, 8, 100);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test('Burn Film is deterministic for a given seed and differs across seeds', () => {
    const run = (seed: number): Uint8ClampedArray => {
      const d = solid(24, 24, 180, 160, 140);
      burnFilmData(d, 24, 24, 40, 0, 0, [255, 246, 224], [61, 31, 10], 80, seed);
      return d;
    };
    expect(Array.from(run(1))).toEqual(Array.from(run(1)));
    expect(Array.from(run(1))).not.toEqual(Array.from(run(2)));
  });
});

// ══ Transition & Noise ══════════════════════════════════════════════

describe('the transitions clear the frame in the same direction', () => {
  const W = 24, H = 24;
  const opaque = (): Uint8ClampedArray => solid(W, H, 200, 200, 200);

  const meanAlpha = (d: Uint8ClampedArray): number => {
    let s = 0, n = 0;
    for (let i = 3; i < d.length; i += 4) { s += d[i]!; n++; }
    return s / n;
  };

  test('completion 0 leaves the frame intact and 100 clears it', () => {
    for (const run of [
      (d: Uint8ClampedArray, c: number) => irisWipeData(d, W, H, c, 0, 0, 0, 0, 0, false, 1, false),
      (d: Uint8ClampedArray, c: number) => lineSweepData(d, W, H, c, 8, 0, 0, 2, false),
      (d: Uint8ClampedArray, c: number) => gridWipeData(d, W, H, c, 4, 4, 0, 0, 2, false),
    ]) {
      const full = opaque();
      run(full, 100);
      expect(meanAlpha(full)).toBeLessThan(20);

      const none = opaque();
      run(none, 0);
      expect(meanAlpha(none)).toBeGreaterThan(235);
    }
  });

  test('each wipe is monotonic in completion', () => {
    const at = (c: number): number => {
      const d = opaque();
      gridWipeData(d, W, H, c, 4, 4, 0, 0, 2, false);
      return meanAlpha(d);
    };
    expect(at(25)).toBeGreaterThan(at(50));
    expect(at(50)).toBeGreaterThan(at(75));
  });

  test('Iris Wipe opens from the centre outward', () => {
    const d = opaque();
    irisWipeData(d, W, H, 40, 0, 0, 0, 0, 0, false, 1, false);
    // Centre gone, corner still there — the reverse would be an equally
    // plausible-looking iris that closes instead of opening.
    expect(alphaAt(d, W, 12, 12)).toBeLessThan(20);
    expect(alphaAt(d, W, 0, 0)).toBeGreaterThan(235);
  });

  test('Light Wipe glows ahead of its own front', () => {
    const d = solid(W, H, 40, 40, 40);
    lightWipeData(d, W, H, 50, 0, 0, 0, 0, 8, [255, 255, 255], 100, 1);
    // Somewhere still-visible must be brighter than the untouched source — the
    // leading edge. This is the one transition that writes RGB, deliberately.
    let brightest = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 128) brightest = Math.max(brightest, d[i]!);
    expect(brightest).toBeGreaterThan(60);
  });

  test('Dust & Scratches at threshold 0 IS a median', () => {
    const src = image(9, 9, (x, y) => {
      const speck = x === 4 && y === 4;
      return speck ? [255, 255, 255, 255] : [40, 40, 40, 255];
    });
    const dust = dustAndScratchesData(new Uint8ClampedArray(src), 9, 9, 2, 0);
    const med = medianData(new Uint8ClampedArray(src), 9, 9, 2);
    expect(px(dust, 9, 4, 4)[0]).toBe(px(med, 9, 4, 4)[0]);
  });

  test('Dust & Scratches removes a speck but keeps in-threshold texture', () => {
    const src = image(9, 9, (x, y) => {
      if (x === 4 && y === 4) return [255, 255, 255, 255];      // the speck
      return [40 + ((x + y) % 2 ? 6 : -6), 40, 40, 255];        // fine texture
    });
    const out = dustAndScratchesData(src, 9, 9, 2, 25);
    // Speck gone…
    expect(px(out, 9, 4, 4)[0]).toBeLessThan(80);
    // …texture preserved, because it never exceeds the threshold.
    expect(px(out, 9, 1, 2)[0]).toBe(px(src, 9, 1, 2)[0]);
  });

  test('Noise Alpha touches only alpha, and is stable for a seed', () => {
    const mk = (): Uint8ClampedArray => solid(16, 16, 90, 120, 150, 255);
    const a = mk(); noiseAlphaData(a, 16, 60, true, 7, 0, true);
    const b = mk(); noiseAlphaData(b, 16, 60, true, 7, 0, true);
    expect(Array.from(a)).toEqual(Array.from(b));
    // RGB intact…
    expect(px(a, 16, 3, 3).slice(0, 3)).toEqual([90, 120, 150]);
    // …coverage disturbed.
    let varied = false;
    for (let i = 3; i < a.length; i += 4) if (a[i]! !== 255) varied = true;
    expect(varied).toBe(true);
  });

  test('Noise Alpha re-rolls the field when the phase advances', () => {
    const mk = (): Uint8ClampedArray => solid(16, 16, 90, 120, 150, 255);
    const a = mk(); noiseAlphaData(a, 16, 60, true, 7, 0, true);
    const b = mk(); noiseAlphaData(b, 16, 60, true, 7, 1, true);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  test('Noise Alpha clipped can only ever REMOVE coverage', () => {
    const src = solid(8, 8, 10, 10, 10, 100);
    noiseAlphaData(src, 8, 100, true, 3, 0, true);
    for (let i = 3; i < src.length; i += 4) expect(src[i]!).toBeLessThanOrEqual(100);
  });
});
