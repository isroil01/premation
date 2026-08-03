/**
 * The Stylize kernels, asserted numerically.
 *
 * Same reasoning as `blurs.test.ts`: the failures that matter here are specific
 * and checkable — a cell that averages the wrong pixels, an edge pass that eats
 * the layer's silhouette, a noise field that re-randomises instead of evolving.
 */

import { mosaicData, findEdgesData, roughenEdgesData } from './stylize';

function make(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
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

const px = (d: Uint8ClampedArray, w: number, x: number, y: number) => {
  const o = (y * w + x) * 4;
  return [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!] as const;
};

describe('mosaicData', () => {
  it('paints every pixel of a cell the same colour', () => {
    // The defining property. A cell that varies internally means the write-back
    // loop and the averaging loop disagree about cell bounds.
    const src = make(8, 8, (x, y) => [x * 30, y * 30, 0, 255]);
    const out = mosaicData(src, 8, 8, 2, 2, false);
    const topLeft = px(out, 8, 0, 0);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) expect(px(out, 8, x, y)).toEqual(topLeft);
    }
  });

  it('gives different cells different colours on a gradient', () => {
    const src = make(8, 8, (x) => [x * 30, 0, 0, 255]);
    const out = mosaicData(src, 8, 8, 2, 1, false);
    expect(px(out, 8, 0, 0)[0]).not.toEqual(px(out, 8, 7, 0)[0]);
  });

  it('is block COUNTS, not pixel sizes — the look survives a resolution change', () => {
    // This is why the params are counts. Same content at two resolutions with
    // the same block counts must land on the same cell colours; a px-size
    // parameter would give 4× the cells at 2× the resolution.
    const small = mosaicData(make(8, 8, (x) => [x < 4 ? 0 : 240, 0, 0, 255]), 8, 8, 2, 1, false);
    const large = mosaicData(make(16, 16, (x) => [x < 8 ? 0 : 240, 0, 0, 255]), 16, 16, 2, 1, false);
    expect(px(small, 8, 0, 0)[0]).toBe(px(large, 16, 0, 0)[0]);
    expect(px(small, 8, 7, 0)[0]).toBe(px(large, 16, 15, 0)[0]);
  });

  it('leaves a uniform field unchanged', () => {
    const src = make(8, 8, () => [90, 90, 90, 255]);
    const out = mosaicData(src, 8, 8, 4, 4, false);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it('sharp colours take a representative pixel, not the mean', () => {
    // Half black, half white in one cell. Averaged gives grey; Sharp Colors must
    // give one of the two originals instead.
    const src = make(4, 1, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const averaged = mosaicData(src, 4, 1, 1, 1, false);
    const sharp = mosaicData(src, 4, 1, 1, 1, true);
    expect(averaged[0]).toBeGreaterThan(60);
    expect(averaged[0]).toBeLessThan(200);
    expect([0, 255]).toContain(sharp[0]);
  });

  it('does not weight a transparent pixel\'s colour into the cell average', () => {
    const src = make(4, 1, (x) => (x === 0 ? [200, 0, 0, 255] : [0, 255, 0, 0]));
    const out = mosaicData(src, 4, 1, 1, 1, false);
    expect(out[1]).toBe(0); // no green bled in from the invisible pixels
  });
});

describe('findEdgesData', () => {
  it('finds nothing in a flat field', () => {
    const src = make(6, 6, () => [128, 128, 128, 255]);
    const out = findEdgesData(src, 6, 6, false);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) expect(px(out, 6, x, y)[0]).toBe(0);
    }
  });

  it('lights up on a luminance step', () => {
    const src = make(8, 8, (x) => (x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const out = findEdgesData(src, 8, 8, false);
    expect(px(out, 8, 3, 4)[0]).toBeGreaterThan(50);   // at the step
    expect(px(out, 8, 0, 4)[0]).toBe(0);               // far from it
  });

  it('inverts to dark-on-white, which is AE\'s default look', () => {
    const src = make(8, 8, (x) => (x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const plain = findEdgesData(src, 8, 8, false);
    const inverted = findEdgesData(src, 8, 8, true);
    expect(px(inverted, 8, 0, 4)[0]).toBe(255 - px(plain, 8, 0, 4)[0]);
  });

  it('carries alpha through untouched', () => {
    // Edge-detecting the alpha too would eat the layer's silhouette — a layer
    // that dissolved its own shape when the effect was added would be a bug.
    const src = make(6, 6, (x, y) => [x * 40, 0, 0, x === y ? 128 : 255]);
    const out = findEdgesData(src, 6, 6, true);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) expect(px(out, 6, x, y)[3]).toBe(x === y ? 128 : 255);
    }
  });

  it('writes the border rather than leaving a transparent frame', () => {
    // Skipping the 1px border instead of clamping leaves it unwritten, which
    // reads as a hairline outline around every layer.
    const src = make(6, 6, () => [100, 100, 100, 255]);
    const out = findEdgesData(src, 6, 6, true);
    expect(px(out, 6, 0, 0)[3]).toBe(255);
    expect(px(out, 6, 5, 5)[3]).toBe(255);
  });
});

describe('roughenEdgesData', () => {
  const disc = () => make(24, 24, (x, y) =>
    (x - 12) ** 2 + (y - 12) ** 2 < 64 ? [255, 255, 255, 255] : [0, 0, 0, 0],
  );

  it('is a no-op at border 0', () => {
    const src = disc();
    const out = roughenEdgesData(src, 24, 24, 0, 100, 2, 0, 1);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it('only ever removes alpha, never adds it', () => {
    // The invariant that keeps it an EDGE effect: it chews the silhouette in,
    // it does not grow the layer beyond its own bounds.
    const src = disc();
    const out = roughenEdgesData(src, 24, 24, 12, 100, 2, 0, 1);
    for (let i = 3; i < src.length; i += 4) {
      expect(out[i]!).toBeLessThanOrEqual(src[i]!);
    }
  });

  it('leaves fully transparent pixels alone', () => {
    const src = disc();
    const out = roughenEdgesData(src, 24, 24, 12, 100, 2, 0, 1);
    for (let i = 3; i < src.length; i += 4) {
      if (src[i] === 0) expect(out[i]).toBe(0);
    }
  });

  it('actually changes the edge', () => {
    const src = disc();
    const out = roughenEdgesData(src, 24, 24, 12, 100, 3, 0, 1);
    let changed = 0;
    for (let i = 3; i < src.length; i += 4) if (out[i] !== src[i]) changed++;
    expect(changed).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed and evolution', () => {
    // Scrub-stability. An effect that re-randomises per call flickers on every
    // redraw and cannot be exported consistently.
    const a = roughenEdgesData(disc(), 24, 24, 12, 100, 2, 30, 7);
    const b = roughenEdgesData(disc(), 24, 24, 12, 100, 2, 30, 7);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('changes with the seed', () => {
    const a = roughenEdgesData(disc(), 24, 24, 12, 100, 2, 0, 1);
    const b = roughenEdgesData(disc(), 24, 24, 12, 100, 2, 0, 2);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('evolves continuously rather than re-randomising', () => {
    // Keyframing evolution must churn the field, not replace it. A tiny step
    // should change the result a little; a large one, a lot.
    const base = roughenEdgesData(disc(), 24, 24, 12, 100, 2, 0, 1);
    const near = roughenEdgesData(disc(), 24, 24, 12, 100, 2, 1, 1);
    const far = roughenEdgesData(disc(), 24, 24, 12, 100, 2, 400, 1);

    const diff = (p: Uint8ClampedArray, q: Uint8ClampedArray): number => {
      let d = 0;
      for (let i = 3; i < p.length; i += 4) d += Math.abs(p[i]! - q[i]!);
      return d;
    };
    expect(diff(base, near)).toBeLessThan(diff(base, far));
  });
});
