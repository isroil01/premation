import {
  extractPatch,
  lumaFromRGBA,
  matchPatch,
  ncc,
  sampleBilinear,
  type LumaPlane,
} from './patchMatch';

/** Synthesize a plane from a scalar field — fully deterministic frames. */
function plane(width: number, height: number, f: (x: number, y: number) => number): LumaPlane {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = f(x, y);
    }
  }
  return { data, width, height };
}

/** A distinctive feature: gaussian blob over a low-amplitude texture, so the
 *  correlation surface has ONE sharp peak (texture kills false flat maxima). */
const scene = (bx: number, by: number) => (x: number, y: number): number => {
  const blob = Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * 2.5 ** 2));
  const texture = 0.05 * Math.sin(x * 1.3) * Math.cos(y * 0.7);
  return 0.3 + 0.6 * blob + texture;
};

describe('lumaFromRGBA', () => {
  it('weights channels by Rec.601 and normalizes to [0,1]', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const l = lumaFromRGBA(rgba, 2, 1);
    expect(l.data[0]).toBeCloseTo(0.299);
    expect(l.data[1]).toBeCloseTo(0.587);
  });
});

describe('sampleBilinear', () => {
  const p = plane(4, 4, (x, y) => x + 10 * y);

  it('interpolates fractional positions linearly', () => {
    expect(sampleBilinear(p, 1.5, 0)).toBeCloseTo(1.5);
    expect(sampleBilinear(p, 0, 1.5)).toBeCloseTo(15);
    expect(sampleBilinear(p, 1.25, 2.75)).toBeCloseTo(1.25 + 27.5);
  });

  it('clamps beyond the borders instead of reading garbage', () => {
    expect(sampleBilinear(p, -5, 0)).toBe(0);
    expect(sampleBilinear(p, 3.9, 3.9)).toBeCloseTo(33, 0);
  });
});

describe('extractPatch', () => {
  it('returns null when the centre is off the plane', () => {
    const p = plane(8, 8, () => 0.5);
    expect(extractPatch(p, -1, 4, 2)).toBeNull();
    expect(extractPatch(p, 4, 9, 2)).toBeNull();
    expect(extractPatch(p, 4, 4, 2)).not.toBeNull();
  });
});

describe('ncc', () => {
  it('is 1 for identical patches and -1 for inverted ones', () => {
    const a = new Float32Array([0, 0.5, 1, 0.25]);
    const inverted = a.map((v) => 1 - v);
    expect(ncc(a, a)).toBeCloseTo(1);
    expect(ncc(a, inverted)).toBeCloseTo(-1);
  });

  it('is brightness- and contrast-invariant — the reason it beats SSD on footage', () => {
    const a = new Float32Array([0.1, 0.4, 0.9, 0.3]);
    const brighter = a.map((v) => 0.5 * v + 0.3);
    expect(ncc(a, brighter)).toBeCloseTo(1);
  });

  it('reports 0 for a flat patch instead of NaN', () => {
    const flat = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const tex = new Float32Array([0.1, 0.9, 0.4, 0.6]);
    expect(ncc(flat, tex)).toBe(0);
    expect(Number.isNaN(ncc(flat, flat))).toBe(false);
  });
});

describe('matchPatch', () => {
  it('recovers an integer displacement exactly', () => {
    const a = plane(64, 64, scene(30, 30));
    const b = plane(64, 64, scene(33, 28));
    const ref = extractPatch(a, 30, 30, 6)!;
    const m = matchPatch(ref, 6, b, 30, 30, 8)!;
    expect(m.x).toBeCloseTo(33, 0.5);
    expect(m.y).toBeCloseTo(28, 0.5);
    expect(m.confidence).toBeGreaterThan(0.95);
  });

  it('recovers a SUB-PIXEL displacement to within a tenth of a pixel', () => {
    const a = plane(64, 64, scene(30, 30));
    const b = plane(64, 64, scene(30.4, 29.7));
    const ref = extractPatch(a, 30, 30, 6)!;
    const m = matchPatch(ref, 6, b, 30, 30, 5)!;
    expect(Math.abs(m.x - 30.4)).toBeLessThan(0.1);
    expect(Math.abs(m.y - 29.7)).toBeLessThan(0.1);
  });

  it('reports low confidence when the feature is gone, not a made-up position nearby', () => {
    const a = plane(64, 64, scene(30, 30));
    const gone = plane(64, 64, (x, y) => 0.3 + 0.05 * Math.sin(x * 1.3) * Math.cos(y * 0.7));
    const ref = extractPatch(a, 30, 30, 6)!;
    const m = matchPatch(ref, 6, gone, 30, 30, 8)!;
    expect(m.confidence).toBeLessThan(0.5);
  });

  it('returns null only when the predicted centre has left the plane', () => {
    const a = plane(64, 64, scene(30, 30));
    const ref = extractPatch(a, 30, 30, 6)!;
    expect(matchPatch(ref, 6, a, -50, -50, 4)).toBeNull();
    expect(matchPatch(ref, 6, a, 30, 30, 4)).not.toBeNull();
  });

  it('survives a brightness shift between frames', () => {
    const a = plane(64, 64, scene(30, 30));
    const dimmed = plane(64, 64, (x, y) => scene(32, 31)(x, y) * 0.6 + 0.1);
    const ref = extractPatch(a, 30, 30, 6)!;
    const m = matchPatch(ref, 6, dimmed, 30, 30, 6)!;
    expect(m.x).toBeCloseTo(32, 0);
    expect(m.y).toBeCloseTo(31, 0);
    expect(m.confidence).toBeGreaterThan(0.9);
  });
});
