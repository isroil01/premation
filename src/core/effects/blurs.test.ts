/**
 * The blur kernels, asserted numerically.
 *
 * These live apart from `newEffects.test.ts` (which checks registration) because
 * a blur that is registered, reachable and wrong is the failure that matters —
 * and "wrong" here means specific, checkable things: energy that does not sum,
 * a dark fringe from averaging straight colour, an axis that moved when only the
 * other one was asked for.
 */

import { blurRgba, radialBlurData, blurDimensions } from './blurs';

/** A w×h RGBA buffer, `fill(x, y)` returning [r,g,b,a]. */
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

describe('blurDimensions', () => {
  it('maps the stored number onto AE\'s menu', () => {
    // A number rather than a string so the control can be keyframed like every
    // other param. 0 is the default and must stay 'both'.
    expect(blurDimensions(0)).toBe('both');
    expect(blurDimensions(1)).toBe('horizontal');
    expect(blurDimensions(2)).toBe('vertical');
  });

  it('treats anything unrecognised as both', () => {
    expect(blurDimensions(99)).toBe('both');
    expect(blurDimensions(-1)).toBe('both');
  });
});

describe('blurRgba', () => {
  it('leaves a uniform field exactly as it found it', () => {
    // The strongest simple invariant: blurring a constant image must be a no-op.
    // Off-by-one weights, a bad divisor or a mishandled edge all break this.
    const d = make(8, 8, () => [120, 60, 30, 255]);
    blurRgba(d, 8, 8, 3, { repeatEdge: true });
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) expect(px(d, 8, x, y)).toEqual([120, 60, 30, 255]);
    }
  });

  it('is a no-op at radius 0', () => {
    const d = make(4, 4, (x) => [x * 60, 0, 0, 255]);
    const before = d.slice();
    blurRgba(d, 4, 4, 0);
    expect(Array.from(d)).toEqual(Array.from(before));
  });

  it('spreads a single lit pixel outward', () => {
    const d = make(9, 9, (x, y) => (x === 4 && y === 4 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    blurRgba(d, 9, 9, 2, { repeatEdge: true });
    // The centre gives up alpha and its neighbours gain some.
    expect(px(d, 9, 4, 4)[3]).toBeLessThan(255);
    expect(px(d, 9, 3, 4)[3]).toBeGreaterThan(0);
    expect(px(d, 9, 4, 3)[3]).toBeGreaterThan(0);
  });

  describe('blur dimensions', () => {
    it('horizontal moves energy along x only', () => {
      const d = make(9, 9, (x, y) => (x === 4 && y === 4 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
      blurRgba(d, 9, 9, 2, { dimensions: 'horizontal', repeatEdge: true });
      expect(px(d, 9, 3, 4)[3]).toBeGreaterThan(0);  // along x — lit
      expect(px(d, 9, 4, 3)[3]).toBe(0);             // along y — untouched
    });

    it('vertical moves energy along y only', () => {
      const d = make(9, 9, (x, y) => (x === 4 && y === 4 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
      blurRgba(d, 9, 9, 2, { dimensions: 'vertical', repeatEdge: true });
      expect(px(d, 9, 4, 3)[3]).toBeGreaterThan(0);
      expect(px(d, 9, 3, 4)[3]).toBe(0);
    });
  });

  describe('premultiplied averaging', () => {
    it('does not drag a transparent neighbour\'s colour into an opaque pixel', () => {
      // THE classic blur bug. The transparent pixels here carry pure green in
      // their unused channels; a straight (non-premultiplied) average would pull
      // the blurred red toward it. Weighting by alpha means invisible colour
      // stays invisible.
      const d = make(9, 1, (x) =>
        x === 4 ? [255, 0, 0, 255] : [0, 255, 0, 0],
      );
      blurRgba(d, 9, 1, 2, { dimensions: 'horizontal', repeatEdge: true });
      for (let x = 0; x < 9; x++) {
        const [, g] = px(d, 9, x, 0);
        expect(g).toBe(0);
      }
    });

    it('fades an edge toward transparent, not toward black', () => {
      const d = make(9, 1, (x) => (x < 5 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
      blurRgba(d, 9, 1, 2, { dimensions: 'horizontal', repeatEdge: true });
      // Across the falloff, wherever anything remains it stays white — only the
      // alpha drops. A straight average would darken these toward grey.
      for (let x = 0; x < 9; x++) {
        const [r, , , a] = px(d, 9, x, 0);
        if (a > 8) expect(r).toBeGreaterThan(200);
      }
    });
  });

  describe('repeat edge pixels', () => {
    it('keeps a full-frame opaque layer opaque at the border when ON', () => {
      // AE's checkbox, and the reason it exists: without it a full-frame blur
      // develops a fading border, which is correct sampling and never wanted.
      const d = make(8, 8, () => [200, 200, 200, 255]);
      blurRgba(d, 8, 8, 3, { repeatEdge: true });
      expect(px(d, 8, 0, 0)[3]).toBe(255);
      expect(px(d, 8, 7, 7)[3]).toBe(255);
    });

    it('lets the border fall off when OFF', () => {
      const d = make(8, 8, () => [200, 200, 200, 255]);
      blurRgba(d, 8, 8, 3, { repeatEdge: false });
      expect(px(d, 8, 0, 0)[3]).toBeLessThan(255);
    });
  });

  it('blurs more with a larger radius', () => {
    const spread = (radius: number): number => {
      const d = make(21, 1, (x) => (x === 10 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
      blurRgba(d, 21, 1, radius, { dimensions: 'horizontal', repeatEdge: false });
      let lit = 0;
      for (let x = 0; x < 21; x++) if (px(d, 21, x, 0)[3] > 0) lit++;
      return lit;
    };
    expect(spread(4)).toBeGreaterThan(spread(1));
  });

  it('keeps the visual weight comparable as iterations rise', () => {
    // The radius is divided by √iterations precisely so this control changes the
    // QUALITY of the falloff, not how much blur you get. Without that division,
    // moving Iterations 1→4 would look like quadrupling the radius, and the
    // control would be unusable.
    const centreAlpha = (iterations: number): number => {
      const d = make(41, 1, (x) => (x === 20 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
      blurRgba(d, 41, 1, 6, { dimensions: 'horizontal', iterations, repeatEdge: false });
      return px(d, 41, 20, 0)[3];
    };
    const one = centreAlpha(1);
    const four = centreAlpha(4);
    const ratio = Math.max(one, four) / Math.max(1, Math.min(one, four));
    expect(ratio).toBeLessThan(3);
  });
});

describe('radialBlurData', () => {
  const solid = () => make(21, 21, () => [255, 255, 255, 255]);

  it('returns the input untouched at amount 0', () => {
    const src = make(9, 9, (x) => [x * 20, 0, 0, 255]);
    const out = radialBlurData(src, 9, 9, 0, 4, 4, 'spin', 16);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it('leaves the centre of a spin almost fixed', () => {
    // Every sample at the centre of rotation maps back to the centre, so it is
    // the one pixel a spin cannot move. A drifting centre means the arc is being
    // walked about the wrong point.
    const out = radialBlurData(solid(), 21, 21, 45, 10, 10, 'spin', 16);
    expect(px(out, 21, 10, 10)[3]).toBe(255);
  });

  it('smears a lit ring around the centre when spinning', () => {
    const src = make(21, 21, (x, y) => (x === 16 && y === 10 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const out = radialBlurData(src, 21, 21, 60, 10, 10, 'spin', 24);
    // The source pixel sits on a radius-6 circle; after a 60° sweep, pixels
    // elsewhere on that arc must have picked up some alpha.
    let litOffOrigin = 0;
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        if (x === 16 && y === 10) continue;
        if (px(out, 21, x, y)[3] > 0) litOffOrigin++;
      }
    }
    expect(litOffOrigin).toBeGreaterThan(0);
  });

  it('zoom streams a lit pixel radially outward', () => {
    // The direction is worth stating, because it is the opposite of the naive
    // reading. Each DESTINATION samples inward (`d / scale`, scale ≥ 1), so a
    // destination at distance d collects sources between d and d/(1+amount/100)
    // — i.e. a lit source is smeared to destinations FURTHER OUT than itself.
    //
    // Lit pixel at (16,10) is 6px from the centre; at amount 50 it reaches
    // destinations out to 6 × 1.5 = 9px, so (18,10) at 8px must pick it up.
    // Testing an immediate neighbour of the centre instead proves nothing: at
    // dx=1 the whole sample range is sub-pixel and rounds back onto itself.
    const src = make(21, 21, (x, y) => (x === 16 && y === 10 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const out = radialBlurData(src, 21, 21, 50, 10, 10, 'zoom', 24);
    expect(px(out, 21, 18, 10)[3]).toBeGreaterThan(0);
    // And NOT inward — a destination closer to the centre than the source never
    // samples out to it.
    expect(px(out, 21, 13, 10)[3]).toBe(0);
  });

  it('does not fringe a transparent region with colour', () => {
    const src = make(21, 21, (x, y) =>
      (x - 10) ** 2 + (y - 10) ** 2 < 9 ? [255, 0, 0, 255] : [0, 255, 0, 0],
    );
    const out = radialBlurData(src, 21, 21, 90, 10, 10, 'spin', 16);
    for (let y = 0; y < 21; y++) {
      for (let x = 0; x < 21; x++) {
        const [, g, , a] = px(out, 21, x, y);
        if (a > 8) expect(g).toBeLessThan(60);
      }
    }
  });
});
