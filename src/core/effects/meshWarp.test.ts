/**
 * Mesh Warp — a lattice of offsets, bilinearly interpolated and subtracted.
 *
 * ## The two failures worth testing for
 *
 * **A transposed lattice.** Sixteen vertices read out of a flat parameter list
 * is an index calculation, and getting row/column the wrong way round produces
 * a perfectly plausible mesh warp in which the wrong vertex moved. Nothing about
 * the picture says so. So the tests move ONE vertex at a time and check that the
 * image moved in that vertex's own neighbourhood and nowhere else.
 *
 * **A warp that leaks.** The whole point of an interior lattice — the thing
 * Bezier Warp cannot do — is putting a dent in the middle while the frame edges
 * stay pinned. If the interpolation reaches past its cell's neighbours, that
 * promise is broken and the effect becomes a worse Bezier Warp.
 *
 * As with the other distorts, these work on the MAPPING rather than on pixels: a
 * bilinear resample of a synthetic pattern blurs exactly the evidence, and the
 * mapping is the thing with the properties.
 */

import { meshWarpData, MESH_WARP_N } from './distort';

const W = 64;
const H = 64;

/** A rest lattice — every vertex unmoved. */
const rest = (): Array<{ x: number; y: number }> =>
  Array.from({ length: MESH_WARP_N * MESH_WARP_N }, () => ({ x: 0, y: 0 }));

/**
 * Where each destination pixel reads from, recovered by warping an image that
 * encodes its own coordinates.
 *
 * The same trick the Optics Compensation tests use, and for the same reason:
 * it reads the mapping back through the REAL code path rather than
 * reimplementing it beside the thing under test.
 */
function mappingOf(offsets: ReadonlyArray<{ x: number; y: number }>) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = Math.round((x / (W - 1)) * 255);
      data[i + 1] = Math.round((y / (H - 1)) * 255);
      data[i + 3] = 255;
    }
  }
  const out = meshWarpData(data, W, H, offsets);
  return (dx: number, dy: number) => {
    const i = (dy * W + dx) * 4;
    return {
      x: (out[i]! / 255) * (W - 1),
      y: (out[i + 1]! / 255) * (H - 1),
      // Off-frame reads blend toward transparent black, so the decoded
      // coordinate stops being a coordinate. See the Optics tests, where
      // ignoring this produced a confident wrong conclusion.
      valid: out[i + 3] === 255,
    };
  };
}

/** Pixel position of lattice vertex (col, row). */
const vertexAt = (col: number, row: number): { x: number; y: number } => ({
  x: Math.round((col * (W - 1)) / (MESH_WARP_N - 1)),
  y: Math.round((row * (H - 1)) / (MESH_WARP_N - 1)),
});

describe('a rest mesh is exactly the identity', () => {
  it('returns the SAME buffer when no vertex has moved', () => {
    // Not merely an equal one: a resample of a rest mesh still costs a bilinear
    // tap of softening, for a control nobody has touched.
    const data = new Uint8ClampedArray(W * H * 4).fill(128);
    expect(meshWarpData(data, W, H, rest())).toBe(data);
  });

  it('returns the input rather than throwing when the lattice is short', () => {
    // A truncated parameter list is a malformed document, and the honest render
    // of one is the layer unchanged — not an exception inside a per-frame path.
    const data = new Uint8ClampedArray(W * H * 4).fill(128);
    expect(meshWarpData(data, W, H, [{ x: 5, y: 5 }])).toBe(data);
  });
});

describe('a moved vertex moves its own neighbourhood', () => {
  /** Index of the vertex at (col, row) in the flat lattice. */
  const idx = (col: number, row: number): number => row * MESH_WARP_N + col;

  it('displaces the image AT the vertex by the vertex offset', () => {
    const offsets = rest();
    offsets[idx(1, 1)] = { x: 8, y: 0 };
    const m = mappingOf(offsets);
    const v = vertexAt(1, 1);
    const p = m(v.x, v.y);
    expect(p.valid).toBe(true);
    // The map subtracts the offset, so the destination reads from 8px left —
    // which is what makes the image appear to move right.
    expect(p.x).toBeCloseTo(v.x - 8, 0);
    expect(p.y).toBeCloseTo(v.y, 0);
  });

  it('leaves the OPPOSITE corner untouched — the interpolation does not leak', () => {
    // The promise an interior lattice makes, and the one Bezier Warp cannot.
    const offsets = rest();
    offsets[idx(1, 1)] = { x: 8, y: 0 };
    const m = mappingOf(offsets);
    const far = vertexAt(MESH_WARP_N - 1, MESH_WARP_N - 1);
    const p = m(far.x - 1, far.y - 1);
    expect(p.valid).toBe(true);
    expect(p.x).toBeCloseTo(far.x - 1, 0);
    expect(p.y).toBeCloseTo(far.y - 1, 0);
  });

  it('distinguishes a ROW from a COLUMN — the transposition check', () => {
    /*
      Sixteen vertices read from a flat list is an index calculation, and
      swapping row and column yields a plausible warp with the wrong vertex
      moved. Moving (1,2) and (2,1) must displace DIFFERENT places; under a
      transposition each would displace the other's.
    */
    const a = rest();
    a[idx(1, 2)] = { x: 10, y: 0 };
    const b = rest();
    b[idx(2, 1)] = { x: 10, y: 0 };
    const ma = mappingOf(a);
    const mb = mappingOf(b);

    const at12 = vertexAt(1, 2);
    const at21 = vertexAt(2, 1);
    // Each mesh moves its own vertex…
    expect(ma(at12.x, at12.y).x).toBeCloseTo(at12.x - 10, 0);
    expect(mb(at21.x, at21.y).x).toBeCloseTo(at21.x - 10, 0);
    // …and leaves the other one alone.
    expect(ma(at21.x, at21.y).x).toBeCloseTo(at21.x, 0);
    expect(mb(at12.x, at12.y).x).toBeCloseTo(at12.x, 0);
  });

  it('falls off smoothly between a moved vertex and its still neighbour', () => {
    // Bilinear, so the displacement must decrease monotonically across the cell.
    // A constant displacement would mean the whole cell moved as a block, which
    // is a translation rather than a warp.
    const offsets = rest();
    offsets[idx(1, 1)] = { x: 12, y: 0 };
    const m = mappingOf(offsets);
    const from = vertexAt(1, 1);
    const to = vertexAt(2, 1);

    let previous = Infinity;
    let checked = 0;
    for (let x = from.x; x <= to.x; x += 3) {
      const p = m(x, from.y);
      if (!p.valid) continue;
      const displaced = x - p.x;
      expect(displaced).toBeLessThanOrEqual(previous + 0.6);
      previous = displaced;
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
    // …and it really has fallen to nothing by the still vertex.
    expect(previous).toBeLessThan(1);
  });

  it('moves in Y as well as X, so the two components are not swapped', () => {
    const offsets = rest();
    offsets[idx(2, 2)] = { x: 0, y: 9 };
    const m = mappingOf(offsets);
    const v = vertexAt(2, 2);
    const p = m(v.x, v.y);
    expect(p.valid).toBe(true);
    expect(p.x).toBeCloseTo(v.x, 0);
    expect(p.y).toBeCloseTo(v.y - 9, 0);
  });
});

describe('the lattice spans the whole layer', () => {
  it('puts its outer vertices ON the edges, so a corner vertex reaches the corner', () => {
    /*
      If the lattice were inset, the frame's own corner would fall outside it and
      be governed by extrapolation — which is how a mesh warp ends up unable to
      touch the edge at all, the one thing it must be able to do.

      Probed a little way in rather than at (0,0). Pulling the corner inward
      makes the very corner read from OFF-FRAME, where the decoded coordinate is
      a blend with transparent black and not a coordinate — the same trap that
      produced a confident wrong answer in the Optics tests. `valid` is the tell.
    */
    const offsets = rest();
    offsets[0] = { x: 6, y: 6 };
    const m = mappingOf(offsets);

    const near = m(8, 8);
    expect(near.valid).toBe(true);
    const displacedNear = 8 - near.x;
    // Still a substantial fraction of the 6px offset a third of the way into
    // the first cell — so the corner vertex genuinely governs the corner.
    expect(displacedNear).toBeGreaterThan(1.5);

    // …and by the middle of the layer, nothing. A lattice whose corner vertex
    // moved the centre would not be a local deformation at all.
    const mid = m(Math.round(W / 2), Math.round(H / 2));
    expect(mid.valid).toBe(true);
    expect(Math.abs(W / 2 - mid.x)).toBeLessThan(1);
  });
});
