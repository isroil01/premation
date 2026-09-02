/**
 * The generators' invariants, not their pixel output.
 *
 * A mesh generator fails QUIETLY: a flipped quad or a normal that is 0.998
 * long shades almost right, and you find it weeks later as "that sphere looks
 * wrong from below". So each shape is pinned on the four things that are true
 * by construction and checkable exactly — buffer sizes, unit normals, the
 * defining distance of the surface, and one global winding statement.
 */

import {
  sphereMesh,
  cylinderMesh,
  coneMesh,
  torusMesh,
  boxMesh,
  capsuleMesh,
  signedVolume6,
  type PrimitiveGeometry,
} from './primitiveMesh';

const vertexCount = (g: PrimitiveGeometry): number => g.positions.length / 3;

/** Longest deviation of any normal from unit length. */
function worstNormalError(g: PrimitiveGeometry): number {
  let worst = 0;
  for (let i = 0; i < g.normals.length; i += 3) {
    const len = Math.hypot(g.normals[i]!, g.normals[i + 1]!, g.normals[i + 2]!);
    worst = Math.max(worst, Math.abs(len - 1));
  }
  return worst;
}

/** Every array agrees on how many vertices there are, and every index is real. */
function expectWellFormed(g: PrimitiveGeometry): void {
  const n = vertexCount(g);
  expect(g.positions.length).toBe(n * 3);
  expect(g.normals.length).toBe(n * 3);
  expect(g.uvs.length).toBe(n * 2);
  expect(g.indices.length % 3).toBe(0);
  for (let i = 0; i < g.indices.length; i++) {
    expect(g.indices[i]!).toBeLessThan(n);
  }
  expect(worstNormalError(g)).toBeLessThan(1e-6);
  // No degenerate triangle survives into the buffer: a zero-area triangle is
  // wasted rasterisation and, at a pole, the symptom of a missing skip.
  for (let i = 0; i + 2 < g.indices.length; i += 3) {
    const a = g.indices[i]!, b = g.indices[i + 1]!, c = g.indices[i + 2]!;
    expect(a === b || b === c || a === c).toBe(false);
  }
}

/** UVs stay inside the unit square and reach both ends of a wrapped seam. */
function expectSeamCorrectU(g: PrimitiveGeometry): void {
  let minU = Infinity, maxU = -Infinity;
  for (let i = 0; i < g.uvs.length; i += 2) {
    const u = g.uvs[i]!;
    const v = g.uvs[i + 1]!;
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
  }
  expect(minU).toBe(0);
  expect(maxU).toBe(1);
}

describe('sphereMesh', () => {
  const W = 24, H = 12, R = 120;
  const g = sphereMesh(R, W, H);

  it('grids (W+1)×(H+1) vertices and drops one triangle per pole column', () => {
    expect(vertexCount(g)).toBe((W + 1) * (H + 1));
    expect(g.indices.length).toBe((2 * W * H - 2 * W) * 3);
    expectWellFormed(g);
  });

  it('puts every vertex exactly `radius` from the origin', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      const d = Math.hypot(g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!);
      expect(Math.abs(d - R)).toBeLessThan(1e-3);
    }
  });

  it('normals are the outward radial direction', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      // n · p = |p| for an outward radial unit normal.
      const dot = g.normals[i]! * g.positions[i]!
        + g.normals[i + 1]! * g.positions[i + 1]!
        + g.normals[i + 2]! * g.positions[i + 2]!;
      expect(Math.abs(dot - R)).toBeLessThan(1e-3);
    }
  });

  it('winds CCW outward and encloses 4/3·π·r³', () => {
    const vol = signedVolume6(g) / 6;
    expect(vol).toBeGreaterThan(0);
    // Polygonised, so it under-fills the true sphere — within 3% at 24×12.
    const exact = (4 / 3) * Math.PI * R ** 3;
    expect(vol / exact).toBeGreaterThan(0.97);
    expect(vol / exact).toBeLessThanOrEqual(1);
  });

  it('duplicates the wrap column so u reaches 1', () => {
    expectSeamCorrectU(g);
    // The seam pair is two DISTINCT vertices at the same place.
    const cols = W + 1;
    const first = (H / 2) * cols;
    const last = first + W;
    expect(g.positions[first * 3]!).toBeCloseTo(g.positions[last * 3]!, 6);
    expect(g.uvs[first * 2]!).toBe(0);
    expect(g.uvs[last * 2]!).toBe(1);
  });

  it('clamps nonsense segment counts instead of emitting a broken buffer', () => {
    const tiny = sphereMesh(1, 0, 0);
    expect(vertexCount(tiny)).toBeGreaterThan(0);
    expectWellFormed(tiny);
  });
});

describe('cylinderMesh', () => {
  const R = 24;
  const g = cylinderMesh(60, 60, 200, R, true);

  it('emits a wall ring pair plus a fan per cap', () => {
    expect(vertexCount(g)).toBe(2 * (R + 1) + 2 * (R + 2));
    expect(g.indices.length).toBe(6 * R + 2 * 3 * R);
    expectWellFormed(g);
    expectSeamCorrectU(g);
  });

  it('holds the radius and the height, and winds outward', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      const rad = Math.hypot(g.positions[i]!, g.positions[i + 2]!);
      expect(rad).toBeLessThan(60 + 1e-3);
      expect(Math.abs(g.positions[i + 1]!)).toBeCloseTo(100, 6);
    }
    const vol = signedVolume6(g) / 6;
    expect(vol).toBeGreaterThan(0);
    // Inscribed polygon area × height — exact for a prism, so this is a tight
    // relative bound (float32 positions, hence not an equality).
    const exact = 0.5 * R * Math.sin((2 * Math.PI) / R) * 60 ** 2 * 200;
    expect(Math.abs(vol / exact - 1)).toBeLessThan(1e-6);
  });

  it('a wall normal has no y component when the radii match', () => {
    // The first 2*(R+1) vertices are the wall.
    for (let i = 0; i < 2 * (R + 1); i++) {
      expect(Math.abs(g.normals[i * 3 + 1]!)).toBeLessThan(1e-6);
    }
  });

  it('uncapped is open: same wall, no fans', () => {
    const open = cylinderMesh(60, 60, 200, R, false);
    expect(vertexCount(open)).toBe(2 * (R + 1));
    expect(open.indices.length).toBe(6 * R);
  });
});

describe('coneMesh', () => {
  const R = 32;
  const g = coneMesh(80, 160, R, true);

  it('collapses the top ring to an apex and keeps only the base cap', () => {
    expect(vertexCount(g)).toBe(2 * (R + 1) + (R + 2));
    expect(g.indices.length).toBe(3 * R + 3 * R);
    expectWellFormed(g);
  });

  it('tilts the wall normal toward the apex by the cone slope', () => {
    // slope: dr = 80, h = 160 ⇒ ny = −80/√(160²+80²)
    const expected = -80 / Math.hypot(160, 80);
    expect(g.normals[1]!).toBeCloseTo(expected, 6);
    const vol = signedVolume6(g) / 6;
    expect(vol).toBeGreaterThan(0);
    const exact = (0.5 * R * Math.sin((2 * Math.PI) / R) * 80 ** 2 * 160) / 3;
    expect(Math.abs(vol / exact - 1)).toBeLessThan(1e-6);
  });
});

describe('torusMesh', () => {
  const RS = 12, TS = 24, RING = 140, TUBE = 40;
  const g = torusMesh(RING, TUBE, RS, TS);

  it('grids (radial+1)×(tubular+1) vertices, two triangles per quad', () => {
    expect(vertexCount(g)).toBe((RS + 1) * (TS + 1));
    expect(g.indices.length).toBe(6 * RS * TS);
    expectWellFormed(g);
    expectSeamCorrectU(g);
  });

  it('keeps every vertex `tube` away from the ring circle', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      const x = g.positions[i]!, y = g.positions[i + 1]!, z = g.positions[i + 2]!;
      // Nearest point on the ring: same azimuth, radius RING, z = 0.
      const azim = Math.hypot(x, y) || 1;
      const dx = x - (x / azim) * RING;
      const dy = y - (y / azim) * RING;
      expect(Math.hypot(dx, dy, z)).toBeCloseTo(TUBE, 3);
    }
  });

  it('normals point away from the ring circle, and it winds outward', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      const x = g.positions[i]!, y = g.positions[i + 1]!, z = g.positions[i + 2]!;
      const azim = Math.hypot(x, y) || 1;
      const dx = (x - (x / azim) * RING) / TUBE;
      const dy = (y - (y / azim) * RING) / TUBE;
      const dz = z / TUBE;
      expect(g.normals[i]!).toBeCloseTo(dx, 5);
      expect(g.normals[i + 1]!).toBeCloseTo(dy, 5);
      expect(g.normals[i + 2]!).toBeCloseTo(dz, 5);
    }
    expect(signedVolume6(g)).toBeGreaterThan(0);
    // 2π²Rt², approached from below by the inscribed tessellation.
    const vol = signedVolume6(g) / 6;
    const exact = 2 * Math.PI ** 2 * RING * TUBE ** 2;
    expect(vol / exact).toBeGreaterThan(0.93);
    expect(vol / exact).toBeLessThan(1);
  });
});

describe('boxMesh', () => {
  const g = boxMesh(100, 200, 300);

  it('is flat shaded: 24 vertices, 36 indices, six constant normals', () => {
    expect(vertexCount(g)).toBe(24);
    expect(g.indices.length).toBe(36);
    expectWellFormed(g);
    for (let f = 0; f < 6; f++) {
      const n0 = [g.normals[f * 12]!, g.normals[f * 12 + 1]!, g.normals[f * 12 + 2]!];
      for (let c = 1; c < 4; c++) {
        expect(g.normals[(f * 4 + c) * 3]!).toBe(n0[0]);
        expect(g.normals[(f * 4 + c) * 3 + 1]!).toBe(n0[1]);
        expect(g.normals[(f * 4 + c) * 3 + 2]!).toBe(n0[2]);
      }
    }
    // All six axis directions, once each.
    const dirs = new Set<string>();
    for (let f = 0; f < 6; f++) dirs.add(`${g.normals[f * 12]},${g.normals[f * 12 + 1]},${g.normals[f * 12 + 2]}`);
    expect(dirs.size).toBe(6);
  });

  it('spans the requested extents about the origin and winds outward', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      expect(Math.abs(g.positions[i]!)).toBeCloseTo(50, 6);
      expect(Math.abs(g.positions[i + 1]!)).toBeCloseTo(100, 6);
      expect(Math.abs(g.positions[i + 2]!)).toBeCloseTo(150, 6);
    }
    expect(signedVolume6(g) / 6).toBeCloseTo(100 * 200 * 300, 3);
  });

  it('every face normal points away from the box centre', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      const dot = g.normals[i]! * g.positions[i]!
        + g.normals[i + 1]! * g.positions[i + 1]!
        + g.normals[i + 2]! * g.positions[i + 2]!;
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('capsuleMesh', () => {
  const R = 24, C = 6, RAD = 50, MID = 120;
  const g = capsuleMesh(RAD, MID, R, C);
  const rows = 2 * (C + 1);

  it('joins two hemispheres to the tube with no duplicated ring', () => {
    expect(vertexCount(g)).toBe((R + 1) * rows);
    expect(g.indices.length).toBe(6 * R * (rows - 2));
    expectWellFormed(g);
    expectSeamCorrectU(g);
  });

  it('every vertex is `radius` from the capsule spine', () => {
    for (let i = 0; i < g.positions.length; i += 3) {
      const x = g.positions[i]!, y = g.positions[i + 1]!, z = g.positions[i + 2]!;
      // Closest point on the segment y ∈ [−MID/2, +MID/2] on the y axis.
      const cy = Math.max(-MID / 2, Math.min(MID / 2, y));
      expect(Math.hypot(x, y - cy, z)).toBeCloseTo(RAD, 3);
    }
  });

  it('spans height + 2·radius and winds outward', () => {
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < g.positions.length; i += 3) {
      minY = Math.min(minY, g.positions[i]!);
      maxY = Math.max(maxY, g.positions[i]!);
    }
    expect(maxY - minY).toBeCloseTo(MID + 2 * RAD, 3);
    expect(signedVolume6(g)).toBeGreaterThan(0);
  });

  it('a zero mid-section is a sphere', () => {
    const s = capsuleMesh(RAD, 0, R, C);
    for (let i = 0; i < s.positions.length; i += 3) {
      expect(Math.hypot(s.positions[i]!, s.positions[i + 1]!, s.positions[i + 2]!)).toBeCloseTo(RAD, 3);
    }
    expect(signedVolume6(s)).toBeGreaterThan(0);
  });
});
