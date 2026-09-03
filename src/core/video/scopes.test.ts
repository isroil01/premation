/**
 * Scope accumulators.
 *
 * Only the pure half is exercised here. The painters need a real 2D context
 * (`createImageData`, `putImageData`), which jsdom does not implement, so
 * asserting on them in this environment would test the mock and not the code.
 * What IS testable is the part that has to be right — where energy lands, and
 * that nothing is silently dropped on the way.
 */

import {
  SCOPE_BINS,
  SCOPE_SAMPLE_WIDTH,
  VECTORSCOPE_TARGETS_75,
  chroma709,
  histogram,
  luma709,
  parade,
  parseCssColor,
  sampleStep,
  sampledColumns,
  vectorscope,
  vectorscopeXY,
  waveform,
} from './scopes';

/** A solid RGBA frame. */
function solid(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
  return px;
}

/** Non-zero cells of a waveform channel plane, as `[column, value, count]`. */
function liveCells(
  data: Uint32Array,
  cols: number,
  channel: number,
): Array<{ col: number; value: number; count: number }> {
  const out: Array<{ col: number; value: number; count: number }> = [];
  const base = channel * SCOPE_BINS * cols;
  for (let v = 0; v < SCOPE_BINS; v++) {
    for (let c = 0; c < cols; c++) {
      const n = data[base + v * cols + c] ?? 0;
      if (n > 0) out.push({ col: c, value: v, count: n });
    }
  }
  return out;
}

describe('waveform', () => {
  it('puts a flat 50% grey frame on a single line at 50%', () => {
    const w = 64;
    const h = 32;
    // 128/255 is the code value a "50% grey" fill lands on; luma709 of a
    // neutral triple is that same value, so the trace must be one row.
    const a = waveform(solid(w, h, 128, 128, 128), w, h);

    expect(a.mode).toBe('luma');
    expect(a.channels).toBe(1);
    expect(a.width).toBe(w);
    expect(a.height).toBe(SCOPE_BINS);
    expect(a.total).toBe(w * h);

    const cells = liveCells(a.data, a.width, 0);
    // One cell per column, all on the same row, each holding the full column.
    expect(cells).toHaveLength(w);
    expect(new Set(cells.map((c) => c.value))).toEqual(new Set([128]));
    expect(new Set(cells.map((c) => c.count))).toEqual(new Set([h]));
    expect(cells.map((c) => c.col).sort((x, y) => x - y)).toEqual([...Array(w).keys()]);
    // 128/255 is 50.2% of full scale — the line sits at 50, not near it.
    expect(Math.round((128 / 255) * 100)).toBe(50);
  });

  it('overlays three channel planes in rgb mode', () => {
    const w = 8;
    const h = 4;
    const a = waveform(solid(w, h, 200, 100, 50), w, h, { mode: 'rgb' });
    expect(a.channels).toBe(3);
    expect(a.total).toBe(w * h);
    expect(new Set(liveCells(a.data, a.width, 0).map((c) => c.value))).toEqual(new Set([200]));
    expect(new Set(liveCells(a.data, a.width, 1).map((c) => c.value))).toEqual(new Set([100]));
    expect(new Set(liveCells(a.data, a.width, 2).map((c) => c.value))).toEqual(new Set([50]));
    // `peak` is the largest single cell — one column's worth of rows.
    expect(a.peak).toBe(h);
  });

  it('never accumulates more than SCOPE_SAMPLE_WIDTH columns', () => {
    const w = 1920;
    const h = 8;
    const a = waveform(solid(w, h, 10, 10, 10), w, h);
    expect(sampleStep(w)).toBe(6);
    expect(a.width).toBeLessThanOrEqual(SCOPE_SAMPLE_WIDTH);
    expect(a.width).toBe(sampledColumns(w));
    // The vertical stride matches, so the sample stays isotropic: 8 rows at
    // stride 6 visits rows 0 and 6 only.
    expect(a.total).toBe(a.width * 2);
  });

  it('skips fully transparent pixels only when asked', () => {
    const w = 8;
    const h = 4;
    const px = solid(w, h, 255, 255, 255, 255);
    for (let i = 0; i < w * 4; i += 4) px[i + 3] = 0; // clear the first row's alpha
    expect(waveform(px, w, h).total).toBe(w * h);
    expect(waveform(px, w, h, { ignoreTransparent: true }).total).toBe(w * (h - 1));
  });

  it('reports an empty accumulator for a zero-sized frame', () => {
    const a = waveform(new Uint8ClampedArray(0), 0, 0);
    expect(a.total).toBe(0);
    expect(a.width).toBe(0);
    expect(a.peak).toBe(0);
  });
});

describe('parade', () => {
  it('is the rgb waveform measurement under a different kind', () => {
    const w = 16;
    const h = 8;
    const px = solid(w, h, 30, 90, 240);
    const p = parade(px, w, h);
    const o = waveform(px, w, h, { mode: 'rgb' });
    expect(p.kind).toBe('parade');
    expect(o.kind).toBe('waveform');
    expect(p.channels).toBe(3);
    expect(Array.from(p.data)).toEqual(Array.from(o.data));
  });
});

describe('vectorscope', () => {
  it('exports six 75% targets derived from the Rec.709 matrix', () => {
    expect(VECTORSCOPE_TARGETS_75.map((t) => t.label)).toEqual(['R', 'Mg', 'B', 'Cy', 'G', 'Yl']);

    // Complementary pairs sit exactly opposite each other — the geometric
    // sanity check that the matrix, not a typo, produced these.
    const by = new Map(VECTORSCOPE_TARGETS_75.map((t) => [t.label, t]));
    for (const [a, b] of [['R', 'Cy'], ['Mg', 'G'], ['B', 'Yl']] as const) {
      const ta = by.get(a);
      const tb = by.get(b);
      expect(ta).toBeDefined();
      expect(tb).toBeDefined();
      if (!ta || !tb) return;
      expect(ta.cb).toBeCloseTo(-tb.cb, 12);
      expect(ta.cr).toBeCloseTo(-tb.cr, 12);
      expect(Math.abs(ta.angleDeg - tb.angleDeg)).toBeCloseTo(180, 9);
    }

    // Blue and yellow are the pair that saturates the Cb axis at 75%.
    expect(by.get('B')?.cb).toBeCloseTo(0.375, 12);
    expect(by.get('R')?.cr).toBeCloseTo(0.375, 12);
    // Every angle is normalised into 0..360.
    for (const t of VECTORSCOPE_TARGETS_75) {
      expect(t.angleDeg).toBeGreaterThanOrEqual(0);
      expect(t.angleDeg).toBeLessThan(360);
    }
  });

  it('puts a pure red frame on the R target ray', () => {
    const w = 24;
    const h = 12;
    const a = vectorscope(solid(w, h, 255, 0, 0), w, h);
    expect(a.total).toBe(w * h);

    // All the energy is in exactly one cell, and that cell is where the
    // forward mapping of pure red says it should be.
    const live = Array.from(a.data).filter((n) => n > 0);
    expect(live).toEqual([w * h]);
    expect(a.peak).toBe(w * h);

    const { cb, cr } = chroma709(1, 0, 0);
    const p = vectorscopeXY(cb, cr, a.size);
    const ex = Math.round(p.x);
    const ey = Math.round(p.y);
    expect(a.data[ey * a.size + ex]).toBe(w * h);

    // …and that cell lies on the 75% R target's ray: same hue angle, further
    // out, because 100% red is more saturated than a 75% bar.
    const radius = (a.size - 1) / 2;
    const angle = (Math.atan2(radius - ey, ex - radius) * 180) / Math.PI;
    const target = VECTORSCOPE_TARGETS_75[0];
    expect(target?.label).toBe('R');
    expect(angle).toBeCloseTo(target?.angleDeg ?? 0, 0);
    expect(Math.hypot(cb, cr)).toBeGreaterThan(target?.radius ?? 0);
  });

  it('lands a neutral frame on the centre cell', () => {
    const w = 8;
    const h = 8;
    const a = vectorscope(solid(w, h, 90, 90, 90), w, h);
    const c = Math.round((a.size - 1) / 2);
    expect(a.data[c * a.size + c]).toBe(w * h);
  });
});

describe('histogram', () => {
  it('sums to the pixel count in every channel', () => {
    const w = 40;
    const h = 20;
    const px = solid(w, h, 0, 0, 0);
    // A spread of values, so this is not just the flat-frame case again.
    for (let i = 0; i < w * h; i++) {
      px[i * 4] = i % 256;
      px[i * 4 + 1] = (i * 3) % 256;
      px[i * 4 + 2] = (i * 7) % 256;
      px[i * 4 + 3] = 255;
    }
    const a = histogram(px, w, h);
    const sum = (arr: Uint32Array): number => arr.reduce((n, v) => n + v, 0);

    expect(a.total).toBe(w * h);
    expect(sum(a.r)).toBe(a.total);
    expect(sum(a.g)).toBe(a.total);
    expect(sum(a.b)).toBe(a.total);
    expect(sum(a.luma)).toBe(a.total);
    expect(a.bins).toBe(SCOPE_BINS);
  });

  it('sums to the DOWNSAMPLED count on a large frame', () => {
    // The contract is "sums to the pixels accumulated", and downsampling is
    // part of accumulation — a test that only ever saw small frames would let
    // a stride bug through silently.
    const w = 1000;
    const h = 40;
    const a = histogram(solid(w, h, 12, 34, 56), w, h);
    const step = sampleStep(w);
    expect(step).toBeGreaterThan(1);
    expect(a.total).toBe(sampledColumns(w) * Math.ceil(h / step));
    expect(a.r.reduce((n, v) => n + v, 0)).toBe(a.total);
    expect(a.r[12]).toBe(a.total);
    expect(a.g[34]).toBe(a.total);
    expect(a.b[56]).toBe(a.total);
    expect(a.luma[Math.round(luma709(12, 34, 56))]).toBe(a.total);
  });
});

describe('parseCssColor', () => {
  it('reads the forms a CSS custom property can hold', () => {
    expect(parseCssColor('#fff')).toEqual([255, 255, 255]);
    expect(parseCssColor('#4d8dff')).toEqual([77, 141, 255]);
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseCssColor('rgba(255, 255, 255, 0.4)')).toEqual([255, 255, 255]);
    expect(parseCssColor('  #34C98E ')).toEqual([52, 201, 142]);
    // Unresolvable tokens must not throw — a missing variable resolves to ''.
    expect(parseCssColor('')).toEqual([0, 0, 0]);
    expect(parseCssColor('var(--nope)')).toEqual([0, 0, 0]);
  });
});
