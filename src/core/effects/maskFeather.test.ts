/**
 * Variable-width mask feather — the pure core on synthetic coverage, plus the
 * model contracts (opt-in detection, outline sampling, animation lerp).
 *
 * The canvas wrapper is exercised implicitly through paintMaskMatte's suite;
 * what must hold HERE is the algorithm: soft where the nearest vertex says
 * soft, hard where it says hard, and byte-identical coverage outside the band.
 */

import { computeVariableFeatherAlpha, featherSamples, hasVariableFeather, type FeatherSample } from './maskFeather';
import { interpolateMask, rectangleMask, type MaskPath } from './mask';

const W = 64;
const H = 64;

/** Hard vertical half-plane: covered where x < 32. */
function halfPlane(): Uint8Array {
  const c = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < 32; x++) c[y * W + x] = 255;
  return c;
}

/** Outline samples along the x=32 edge with feather varying top→bottom. */
function edgeSamples(fTop: number, fBottom: number): FeatherSample[] {
  const out: FeatherSample[] = [];
  for (let y = 0; y < H; y += 2) {
    out.push({ x: 32, y, f: fTop + (fBottom - fTop) * (y / (H - 1)) });
  }
  return out;
}

const px = (a: Uint8ClampedArray, x: number, y: number): number => a[y * W + x]!;

describe('computeVariableFeatherAlpha', () => {
  it('a hard vertex keeps a hard edge; a soft vertex gets a ramp — on the same path', () => {
    const a = computeVariableFeatherAlpha(halfPlane(), W, H, edgeSamples(0, 16), 16);
    // Near the top (feather ~0): binary within a pixel of the edge.
    expect(px(a, 28, 2)).toBe(255);
    expect(px(a, 36, 2)).toBe(0);
    // Near the bottom (feather 16 → ±8 px ramp): genuinely intermediate values
    // on both sides of the edge.
    const insideSoft = px(a, 29, 60);
    const outsideSoft = px(a, 35, 60);
    expect(insideSoft).toBeGreaterThan(128);
    expect(insideSoft).toBeLessThan(255);
    expect(outsideSoft).toBeGreaterThan(0);
    expect(outsideSoft).toBeLessThan(128);
  });

  it('the ramp is monotonic across the edge', () => {
    const a = computeVariableFeatherAlpha(halfPlane(), W, H, edgeSamples(12, 12), 12);
    let prev = 256;
    for (let x = 24; x < 42; x++) {
      const v = px(a, x, 32);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
    // And it actually spans the range.
    expect(px(a, 24, 32)).toBe(255);
    expect(px(a, 41, 32)).toBe(0);
  });

  it('pixels beyond the band are the input coverage verbatim', () => {
    const cov = halfPlane();
    const a = computeVariableFeatherAlpha(cov, W, H, edgeSamples(8, 8), 8);
    expect(px(a, 2, 32)).toBe(255);
    expect(px(a, 60, 32)).toBe(0);
  });

  it('is deterministic', () => {
    const a = computeVariableFeatherAlpha(halfPlane(), W, H, edgeSamples(3, 14), 14);
    const b = computeVariableFeatherAlpha(halfPlane(), W, H, edgeSamples(3, 14), 14);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('no samples / zero max feather → untouched coverage', () => {
    const cov = halfPlane();
    expect(Array.from(computeVariableFeatherAlpha(cov, W, H, [], 10))).toEqual(Array.from(cov));
    expect(Array.from(computeVariableFeatherAlpha(cov, W, H, edgeSamples(4, 4), 0))).toEqual(Array.from(cov));
  });
});

describe('the model contracts', () => {
  const withVertexFeather = (f?: number): MaskPath => {
    const p = rectangleMask(40, 40);
    if (f !== undefined) p.points[0] = { ...p.points[0]!, feather: f };
    return p;
  };

  it('hasVariableFeather is the opt-in: any vertex with its own value', () => {
    expect(hasVariableFeather(withVertexFeather())).toBe(false);
    expect(hasVariableFeather(withVertexFeather(0))).toBe(true);
    expect(hasVariableFeather(withVertexFeather(12))).toBe(true);
  });

  it('featherSamples interpolates vertex→vertex and falls back to the path value', () => {
    const p = withVertexFeather(20);
    p.feather = 4; // the uniform base every unmarked vertex contributes
    const samples = featherSamples(p, 8);
    expect(samples.length).toBe(4 * 8);
    // First sample sits AT vertex 0 → its own feather.
    expect(samples[0]!.f).toBeCloseTo(20);
    // Mid-segment between vertex 0 (20) and vertex 1 (base 4) → in between.
    const mid = samples[4]!.f;
    expect(mid).toBeGreaterThan(4);
    expect(mid).toBeLessThan(20);
    // A segment between two unmarked vertices runs at the base.
    expect(samples[2 * 8 + 4]!.f).toBeCloseTo(4);
  });

  it('mask animation lerps per-vertex feather like every other vertex quantity', () => {
    const a = withVertexFeather(0);
    const b = withVertexFeather(20);
    const mid = interpolateMask(
      [{ t: 0, mask: { paths: [a] } }, { t: 1, mask: { paths: [b] } }],
      0.5,
    );
    expect(mid!.paths[0]!.points[0]!.feather).toBeCloseTo(10);
    // Unmarked vertices stay unmarked — no phantom opt-in from the lerp.
    expect(mid!.paths[0]!.points[1]!.feather).toBeUndefined();
  });
});
