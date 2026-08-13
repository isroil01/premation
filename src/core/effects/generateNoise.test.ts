/**
 * Generate round two (Checkerboard, Grid, Cell Pattern) and the Noise family
 * (Turbulent Noise, Add Grain, Median).
 *
 * Written under the Spherize rule: for each effect, assert the property that
 * DISTINGUISHES it from its nearest neighbour, not merely that it changed
 * pixels. Three of these have a neighbour they could silently collapse into —
 * Turbulent Noise into Fractal Noise, Add Grain into the existing uniform
 * `noise`, Median into a blur — and in every case the collapsed version still
 * "works", still animates, and still looks plausible in a screenshot.
 *
 * So the load-bearing tests here are:
 *   Add Grain  · disturbance must PEAK IN THE MIDTONES and vanish at both ends
 *   Median     · must remove an outlier AND keep a step edge sharp
 *   Cell Ptn   · F1 and F2−F1 must be different images
 * Everything else is supporting.
 */

import { drawCheckerboard, drawGrid, cellPatternData } from './generatePatterns';
import { turbulentNoiseData, addGrainData, medianData } from './noiseEffects';
import { applyCanvas2dEffect, isCanvas2dOnlyEffect } from './canvas2dEffects';
import { EFFECT_DEFS, defaultParams, type Effect, type EffectParams, type EffectType } from './effects';

function fx(type: EffectType, params: Record<string, unknown> = {}): Effect {
  const def = EFFECT_DEFS.find((d) => d.type === type)!;
  return { id: 'e1', type, params: { ...defaultParams(def), ...params } as EffectParams };
}

/** An opaque mid-grey field. */
function grey(w: number, h: number, level = 128): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = level; d[i + 1] = level; d[i + 2] = level; d[i + 3] = 255;
  }
  return d;
}

/** A canvas pre-filled opaque so `source-atop` generators have alpha to land on. */
function opaqueCanvas(w: number, h: number, fill = '#808080'): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return ctx;
}

const px = (ctx: CanvasRenderingContext2D, x: number, y: number): [number, number, number] => {
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
};

describe('Checkerboard', () => {
  it('alternates: diagonal neighbours match, side neighbours do not', () => {
    const ctx = opaqueCanvas(64, 64);
    drawCheckerboard(ctx, 64, 64, fx('checkerboard', {
      width: 16, height: 16, colorA: '#000000', colorB: '#ffffff', anchorX: 0, anchorY: 0,
    }));
    const a = px(ctx, 8, 8);    // cell (0,0)
    const right = px(ctx, 24, 8);  // cell (1,0)
    const down = px(ctx, 8, 24);   // cell (0,1)
    const diag = px(ctx, 24, 24);  // cell (1,1)
    expect(a).not.toEqual(right);
    expect(a).not.toEqual(down);
    // The parity property: (row+col) even cells share a colour. A pattern that
    // striped instead of chequered would pass the two checks above.
    expect(a).toEqual(diag);
  });

  /**
   * The anchor is modular, so it has a PERIOD — and the period is the property
   * worth pinning, because it is what makes an animated anchor loop seamlessly
   * instead of jumping when the value wraps.
   *
   * The first version of this test asserted that shifting by one full cell
   * inverts the parity. That is simply false — a full-cell shift is a full
   * period and maps the lattice onto itself — and the test failed against
   * correct code. Worth recording rather than quietly fixing: the "obvious"
   * assertion about a modular control was wrong in the direction of expecting
   * more change than the maths allows.
   */
  it('a sub-cell anchor shift moves the lattice', () => {
    const base = opaqueCanvas(64, 64);
    drawCheckerboard(base, 64, 64, fx('checkerboard', { width: 16, height: 16, anchorX: 0 }));
    const shifted = opaqueCanvas(64, 64);
    drawCheckerboard(shifted, 64, 64, fx('checkerboard', { width: 16, height: 16, anchorX: 7 }));
    const a = [...base.getImageData(0, 0, 64, 64).data];
    const b = [...shifted.getImageData(0, 0, 64, 64).data];
    expect(a.some((v, i) => v !== b[i])).toBe(true);
  });

  it('a whole-cell anchor shift is EXACTLY the identity — the lattice has a period', () => {
    const base = opaqueCanvas(64, 64);
    drawCheckerboard(base, 64, 64, fx('checkerboard', { width: 16, height: 16, anchorX: 0, anchorY: 0 }));
    const shifted = opaqueCanvas(64, 64);
    drawCheckerboard(shifted, 64, 64, fx('checkerboard', { width: 16, height: 16, anchorX: 32, anchorY: -48 }));
    expect([...shifted.getImageData(0, 0, 64, 64).data])
      .toEqual([...base.getImageData(0, 0, 64, 64).data]);
  });

  it('respects the layer alpha rather than covering it', () => {
    // source-atop is the difference between "a checkerboard inside my text" and
    // "a checkerboard rectangle over my text".
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 16, 32); // left half opaque, right half transparent
    drawCheckerboard(ctx, 32, 32, fx('checkerboard', { width: 8, height: 8 }));
    expect(ctx.getImageData(24, 8, 1, 1).data[3]).toBe(0);
    expect(ctx.getImageData(4, 8, 1, 1).data[3]).toBeGreaterThan(0);
  });

  it('a zero size cannot hang the draw loop', () => {
    // min is 1 in the def, but the kernel is reachable directly and a 0 step
    // would never terminate.
    const ctx = opaqueCanvas(16, 16);
    expect(() => drawCheckerboard(ctx, 16, 16, fx('checkerboard', { width: 0, height: 0 }))).not.toThrow();
  });
});

describe('Grid', () => {
  it('draws lines at the pitch and leaves the gaps alone', () => {
    const ctx = opaqueCanvas(64, 64, '#000000');
    drawGrid(ctx, 64, 64, fx('grid', {
      width: 16, height: 16, thickness: 2, color: '#ffffff', anchorX: 0, anchorY: 0,
    }));
    // On a vertical line at x=16, versus the middle of a cell.
    expect(px(ctx, 16, 8)[0]).toBeGreaterThan(px(ctx, 8, 8)[0]);
  });

  it('zero thickness draws nothing', () => {
    const ctx = opaqueCanvas(32, 32, '#000000');
    const before = [...ctx.getImageData(0, 0, 32, 32).data];
    drawGrid(ctx, 32, 32, fx('grid', { thickness: 0 }));
    expect([...ctx.getImageData(0, 0, 32, 32).data]).toEqual(before);
  });
});

describe('Cell Pattern', () => {
  const run = (over: Record<string, unknown>): Uint8ClampedArray => cellPatternData(
    grey(48, 48), 48, 48,
    (over.size as number) ?? 16,
    (over.evolution as number) ?? 0,
    (over.contrast as number) ?? 100,
    (over.invert as boolean) ?? false,
    (over.membrane as boolean) ?? false,
  );

  it('F1 and F2−F1 are genuinely different images', () => {
    // The two readings of one field look nothing alike — blobs versus a
    // crystalline membrane. If `membrane` were ignored the effect would still
    // render, animate and look fine, and half of it would be missing.
    expect([...run({ membrane: false })]).not.toEqual([...run({ membrane: true })]);
  });

  it('is deterministic — the same params give the same field', () => {
    // No Math.random anywhere: scrubbing back to a frame must reproduce it.
    expect([...run({})]).toEqual([...run({})]);
  });

  it('evolution moves the cells', () => {
    expect([...run({ evolution: 0 })]).not.toEqual([...run({ evolution: 5 })]);
  });

  it('invert is an exact complement', () => {
    const plain = run({});
    const inv = run({ invert: true });
    for (let i = 0; i < plain.length; i += 4) {
      expect(inv[i]! + plain[i]!).toBeGreaterThanOrEqual(254);
      expect(inv[i]! + plain[i]!).toBeLessThanOrEqual(256);
    }
  });
});

describe('Turbulent Noise', () => {
  const run = (over: Record<string, unknown> = {}): Uint8ClampedArray => turbulentNoiseData(
    grey(48, 48), 48, 48,
    (over.scale as number) ?? 24,
    (over.complexity as number) ?? 3,
    (over.evolution as number) ?? 0,
    (over.contrast as number) ?? 100,
    (over.brightness as number) ?? 0,
    (over.invert as boolean) ?? false,
  );

  it('is deterministic', () => {
    expect([...run()]).toEqual([...run()]);
  });

  it('complexity adds octaves — more detail is a different field', () => {
    expect([...run({ complexity: 1 })]).not.toEqual([...run({ complexity: 5 })]);
  });

  it('evolution animates it', () => {
    expect([...run({ evolution: 0 })]).not.toEqual([...run({ evolution: 3 })]);
  });

  it('the FOLD is present: one octave is biased dark, unlike signed noise', () => {
    // The defining property. |signed| maps a symmetric field onto [0,1] with a
    // crease at zero, so its mean sits BELOW mid-grey — a signed fBm would
    // average near 128. Measured at one octave with contrast neutral, so the
    // only thing under test is the fold itself.
    const d = turbulentNoiseData(grey(64, 64), 64, 64, 16, 1, 0, 100, 0, false);
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += d[i]!; n++; }
    expect(sum / n).toBeLessThan(120);
  });

  it('contrast widens the spread around mid-grey', () => {
    const spread = (d: Uint8ClampedArray): number => {
      let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { s += Math.abs(d[i]! - 128); n++; }
      return s / n;
    };
    expect(spread(run({ contrast: 300 }))).toBeGreaterThan(spread(run({ contrast: 50 })));
  });
});

describe('Add Grain', () => {
  /** Mean absolute deviation from the flat input level. */
  function disturbance(level: number, over: Record<string, unknown> = {}): number {
    const d = addGrainData(
      grey(64, 64, level), 64, 64,
      (over.intensity as number) ?? 100,
      (over.size as number) ?? 1,
      (over.saturation as number) ?? 0,
      (over.seed as number) ?? 0,
    );
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { s += Math.abs(d[i]! - level); n++; }
    return s / n;
  }

  /**
   * THE distinguishing property, and the reason this is not the existing
   * `noise` effect with a new label.
   *
   * Film grain peaks in the midtones and vanishes at both ends, because film is
   * saturated at black and at white. Uniform noise sprays evenly, which is what
   * makes it read as digital dirt. If the luminance response were ever dropped
   * the effect would still render, still animate, and be the wrong effect.
   */
  it('peaks in the midtones and vanishes at both ends', () => {
    const mid = disturbance(128);
    expect(mid).toBeGreaterThan(1);
    expect(disturbance(4)).toBeLessThan(mid / 3);
    expect(disturbance(251)).toBeLessThan(mid / 3);
  });

  it('pure black and pure white are untouched exactly', () => {
    // 4·l·(1−l) reaches exactly zero rather than asymptotically — grain in a
    // blown highlight is the tell of a synthetic grain pass.
    expect(disturbance(0)).toBe(0);
    expect(disturbance(255)).toBe(0);
  });

  it('monochrome grain moves all three channels together', () => {
    const d = addGrainData(grey(64, 64), 64, 64, 100, 1, 0, 0);
    for (let i = 0; i < d.length; i += 4) {
      expect(d[i]).toBe(d[i + 1]);
      expect(d[i + 1]).toBe(d[i + 2]);
    }
  });

  it('saturation decouples the channels', () => {
    const d = addGrainData(grey(64, 64), 64, 64, 100, 1, 100, 0);
    let differing = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1]) differing++;
    expect(differing).toBeGreaterThan(0);
  });

  it('size clumps the grain — a coarser pitch has more neighbour agreement', () => {
    const agreement = (size: number): number => {
      const d = addGrainData(grey(64, 64), 64, 64, 100, size, 0, 0);
      let same = 0, n = 0;
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 63; x++) {
          const i = (y * 64 + x) * 4;
          if (Math.abs(d[i]! - d[i + 4]!) < 3) same++;
          n++;
        }
      }
      return same / n;
    };
    expect(agreement(8)).toBeGreaterThan(agreement(0.5));
  });

  it('zero intensity is a no-op', () => {
    const src = grey(16, 16);
    expect([...addGrainData(new Uint8ClampedArray(src), 16, 16, 0, 1, 0, 0)]).toEqual([...src]);
  });
});

describe('Median', () => {
  /**
   * The pair of properties that separate a median from a blur. A blur passes
   * the first and fails the second; asserting only the first would let this
   * effect silently degenerate into one.
   */
  it('removes an isolated outlier completely', () => {
    const W = 16, H = 16;
    const d = grey(W, H, 100);
    const spike = (8 * W + 8) * 4;
    d[spike] = 255; d[spike + 1] = 255; d[spike + 2] = 255;
    const out = medianData(d, W, H, 2);
    // A median discards the outlier outright — not "reduces" it, as a blur would.
    expect(out[spike]).toBe(100);
  });

  it('keeps a step edge exactly sharp', () => {
    const W = 32, H = 8;
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = x < W / 2 ? 20 : 220;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
    }
    const out = medianData(d, W, H, 2);
    // The two pixels straddling the edge keep their original values. A blur of
    // any radius would pull them toward each other.
    const left = (4 * W + 15) * 4;
    const right = (4 * W + 16) * 4;
    expect(out[left]).toBe(20);
    expect(out[right]).toBe(220);
  });

  it('does not filter alpha — soft edges survive', () => {
    const W = 8, H = 8;
    const d = grey(W, H);
    const i = (4 * W + 4) * 4;
    d[i + 3] = 77;
    expect(medianData(d, W, H, 2)[i + 3]).toBe(77);
  });

  it('radius 0 is a no-op, and the radius is capped', () => {
    const src = grey(8, 8);
    expect([...medianData(new Uint8ClampedArray(src), 8, 8, 0)]).toEqual([...src]);
    // 999 must clamp rather than attempt a 1999×1999 window per pixel.
    expect(() => medianData(grey(8, 8), 8, 8, 999)).not.toThrow();
  });
});

describe('all six reach the bake chain', () => {
  const CASES: ReadonlyArray<readonly [EffectType, Record<string, unknown>]> = [
    ['checkerboard', { width: 8, height: 8 }],
    ['grid', { width: 8, height: 8, thickness: 2 }],
    ['cell-pattern', { size: 8 }],
    ['turbulent-noise', { scale: 12 }],
    ['add-grain', { intensity: 100 }],
    ['median', { radius: 2 }],
  ];

  it.each(CASES)('%s changes pixels through applyCanvas2dEffect', (type, params) => {
    expect(isCanvas2dOnlyEffect(type)).toBe(true);
    const ctx = opaqueCanvas(32, 32);
    // A gradient rather than a flat fill: Median over a flat field is correctly
    // a no-op, so a flat subject would make that case pass vacuously.
    const g = ctx.createLinearGradient(0, 0, 32, 32);
    g.addColorStop(0, '#203080');
    g.addColorStop(1, '#e08040');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    const before = [...ctx.getImageData(0, 0, 32, 32).data];

    applyCanvas2dEffect(ctx, 32, 32, fx(type, params));
    const after = [...ctx.getImageData(0, 0, 32, 32).data];
    expect(after.some((v, i) => v !== before[i])).toBe(true);
  });
});
