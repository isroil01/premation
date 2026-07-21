/**
 * ARAP (As-Rigid-As-Possible) puppet-solver tests.
 *
 * Covers: determinism (bit-identical across repeats and fresh inputs); the
 * defining rigidity property (a two-pin bent bar keeps triangle area under ARAP
 * while LBS candy-wrapper-collapses it); graceful fallback on degenerate meshes;
 * and single-pin = rigid translate (ARAP defers to the exact LBS path).
 */

import {
  buildRestMesh,
  deform,
  deformLbs,
  type DeformedMesh,
  type DeformPin,
  type PuppetRig,
} from './puppet';
import { deformArap } from './arap';

/**
 * Mean |deformed edge length − rest edge length| over the unique mesh edges whose
 * REST midpoint x falls in [lo, hi]. Edge-length change is a rotation-invariant
 * proxy for non-rigid strain (a rigid map preserves lengths), so a lower value =
 * a more rigid region. Used to show ARAP stiffness stiffens (starches) a region.
 */
function regionEdgeDistortion(
  rest: Float32Array,
  def: Float32Array,
  tris: Uint16Array,
  lo: number,
  hi: number,
): { mean: number; count: number } {
  const seen = new Set<number>();
  let sum = 0;
  let count = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const idx = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    for (let e = 0; e < 3; e++) {
      let a = idx[e]!;
      let b = idx[(e + 1) % 3]!;
      if (a > b) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      const key = a * 100000 + b;
      if (seen.has(key)) continue;
      seen.add(key);
      const mx = (rest[a * 4]! + rest[b * 4]!) / 2;
      if (mx < lo || mx > hi) continue;
      const rl = Math.hypot(rest[a * 4]! - rest[b * 4]!, rest[a * 4 + 1]! - rest[b * 4 + 1]!);
      const dl = Math.hypot(def[a * 4]! - def[b * 4]!, def[a * 4 + 1]! - def[b * 4 + 1]!);
      sum += Math.abs(dl - rl);
      count++;
    }
  }
  return { mean: sum / count, count };
}

/** Smallest absolute triangle area in a deformed [x,y,u,v] vertex buffer. */
function minTriangleArea(verts: Float32Array, tris: Uint16Array): number {
  let min = Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i]!, b = tris[i + 1]!, c = tris[i + 2]!;
    const ax = verts[a * 4]!, ay = verts[a * 4 + 1]!;
    const bx = verts[b * 4]!, by = verts[b * 4 + 1]!;
    const cx = verts[c * 4]!, cy = verts[c * 4 + 1]!;
    const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    if (area < min) min = area;
  }
  return min;
}

/** A horizontal bar with two pins at its ends. */
function barRig(): PuppetRig {
  return {
    meshExpansion: 0,
    meshDensity: 10,
    pins: [
      { id: 'L', name: 'L', x: -80, y: 0 },
      { id: 'R', name: 'R', x: 80, y: 0 },
    ],
  };
}

describe('ARAP determinism', () => {
  const rig = barRig();
  const mesh = buildRestMesh(200, 60, 0, rig);
  const pins: DeformPin[] = [
    { id: 'L', x: -80, y: 0, rotation: 70 },
    { id: 'R', x: 80, y: 0, rotation: -70 },
  ];

  it('repeated calls are bit-identical', () => {
    const a = deform(pins, mesh, 'arap');
    const b = deform(pins, mesh, 'arap');
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(Object.is(a[i], b[i])).toBe(true);
    }
  });

  it('two fresh mesh/pin pairs produce bit-identical output', () => {
    const rig1 = barRig();
    const mesh1 = buildRestMesh(200, 60, 0, rig1);
    const pins1: DeformPin[] = [
      { id: 'L', x: -80, y: 0, rotation: 70 },
      { id: 'R', x: 80, y: 0, rotation: -70 },
    ];
    const rig2 = barRig();
    const mesh2 = buildRestMesh(200, 60, 0, rig2);
    const pins2: DeformPin[] = [
      { id: 'L', x: -80, y: 0, rotation: 70 },
      { id: 'R', x: 80, y: 0, rotation: -70 },
    ];
    const a = deform(pins1, mesh1, 'arap');
    const b = deform(pins2, mesh2, 'arap');
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(Object.is(a[i], b[i])).toBe(true);
    }
  });
});

describe('ARAP preserves rigidity where LBS collapses', () => {
  it('two-pin bent bar: ARAP keeps triangle area, LBS candy-wraps to ~zero', () => {
    const rig = barRig();
    const mesh = buildRestMesh(200, 60, 0, rig);
    const rest = mesh.vertices;
    const restMin = minTriangleArea(rest, mesh.triangles);
    expect(restMin).toBeGreaterThan(0);

    // Opposing 80° handle rotations: near the bar centre LBS averages two nearly
    // cancelling rotations → shear/shrink to near-zero area (candy-wrapper);
    // ARAP bends the bar while each triangle stays roughly rigid.
    const pins: DeformPin[] = [
      { id: 'L', x: -80, y: 0, rotation: 80 },
      { id: 'R', x: 80, y: 0, rotation: -80 },
    ];

    const lbs = deform(pins, mesh, 'lbs');
    const arap = deform(pins, mesh, 'arap');

    const lbsMin = minTriangleArea(lbs, mesh.triangles);
    const arapMin = minTriangleArea(arap, mesh.triangles);

    // LBS collapses at least one triangle to a small fraction of its rest area.
    expect(lbsMin).toBeLessThan(0.2 * restMin);
    // ARAP keeps every triangle at a healthy fraction of rest area.
    expect(arapMin).toBeGreaterThan(0.4 * restMin);
    // And ARAP's worst triangle is far larger than LBS's worst.
    expect(arapMin).toBeGreaterThan(lbsMin * 5);
  });
});

describe('ARAP stiffness (first-class energy term)', () => {
  const rig = barRig();
  const mesh = buildRestMesh(200, 60, 0, rig);
  const rest = mesh.vertices;

  // Same bent-bar motion (opposing end rotations) for every case so the ONLY
  // variable is the per-pin stiffness fed to the ARAP energy.
  const basePins: DeformPin[] = [
    { id: 'L', x: -80, y: 0, rotation: 80 },
    { id: 'R', x: 80, y: 0, rotation: -80 },
  ];

  it('zero / absent stiffness reduces EXACTLY to the base path (bit-identical)', () => {
    // A pin carrying stiffness: 0 must fold to the no-stiffness fast path — the
    // regression guard that the common case stays byte-for-byte unchanged.
    const lbs = deformLbs(basePins, mesh);
    const absent = deformArap(basePins, mesh, lbs);
    const zero = deformArap(
      [
        { id: 'L', x: -80, y: 0, rotation: 80, stiffness: 0 },
        { id: 'R', x: 80, y: 0, rotation: -80, stiffness: 0 },
      ],
      mesh,
      lbs,
    );
    expect(absent.length).toBe(zero.length);
    for (let i = 0; i < absent.length; i++) {
      expect(Object.is(absent[i], zero[i])).toBe(true);
    }
  });

  it('a stiffness GRADIENT stiffens (starches) the stiffened region', () => {
    // Warm start is the SAME LBS field for both solves, so the only difference is
    // the ARAP energy — isolating the stiffness→edge-weight coupling.
    const lbs = deformLbs(basePins, mesh);
    const soft = deformArap(basePins, mesh, lbs);
    const stiff = deformArap(
      [
        { id: 'L', x: -80, y: 0, rotation: 80, stiffness: 3 },
        { id: 'R', x: 80, y: 0, rotation: -80 },
      ],
      mesh,
      lbs,
    );

    // Left half is stiffened (pin L), right half is not.
    const softL = regionEdgeDistortion(rest, soft, mesh.triangles, -100, -30);
    const stiffL = regionEdgeDistortion(rest, stiff, mesh.triangles, -100, -30);
    const softR = regionEdgeDistortion(rest, soft, mesh.triangles, 30, 100);
    const stiffR = regionEdgeDistortion(rest, stiff, mesh.triangles, 30, 100);
    expect(stiffL.count).toBeGreaterThan(10);
    expect(softR.count).toBeGreaterThan(10);

    // Stiffened LEFT region deforms measurably LESS (retains more rigidity)…
    expect(stiffL.mean).toBeLessThan(softL.mean * 0.95);
    // …while the un-stiffened RIGHT region absorbs more of the bend (compensates).
    expect(stiffR.mean).toBeGreaterThan(softR.mean * 1.02);
    // The gradient shows up as a clear left-vs-right asymmetry vs the soft solve.
    expect(stiffL.mean / softL.mean).toBeLessThan(stiffR.mean / softR.mean);
  });

  it('a UNIFORM stiffness field leaves the solve unchanged (only gradients bite)', () => {
    // Equal stiffness on both pins → s_i ≈ const → every edge weight scales by the
    // same factor → identical argmin. This is a mathematical property, so the
    // result must match the no-stiffness solve to tight numeric tolerance.
    const lbs = deformLbs(basePins, mesh);
    const soft = deformArap(basePins, mesh, lbs);
    const uniform = deformArap(
      [
        { id: 'L', x: -80, y: 0, rotation: 80, stiffness: 2 },
        { id: 'R', x: 80, y: 0, rotation: -80, stiffness: 2 },
      ],
      mesh,
      lbs,
    );
    for (let i = 0; i < soft.length; i++) {
      expect(uniform[i]!).toBeCloseTo(soft[i]!, 4);
    }
  });

  it('stiffness solves are deterministic (repeat + distinct animated values)', () => {
    const mkPins = (s: number): DeformPin[] => [
      { id: 'L', x: -80, y: 0, rotation: 80, stiffness: s },
      { id: 'R', x: 80, y: 0, rotation: -80 },
    ];
    const lbs = deformLbs(basePins, mesh);
    // Repeated call, same stiffness → bit-identical.
    const a = deformArap(mkPins(2.5), mesh, lbs);
    const b = deformArap(mkPins(2.5), mesh, lbs);
    for (let i = 0; i < a.length; i++) expect(Object.is(a[i], b[i])).toBe(true);

    // Animated stiffness: each distinct signature is itself deterministic, and a
    // different value yields a different field (so it is genuinely first-class).
    const frames = [1, 2.5, 4, 2.5, 1];
    const first = frames.map((s) => deformArap(mkPins(s), mesh, lbs));
    const again = frames.map((s) => deformArap(mkPins(s), mesh, lbs));
    for (let f = 0; f < frames.length; f++) {
      for (let i = 0; i < first[f]!.length; i++) {
        expect(Object.is(first[f]![i], again[f]![i])).toBe(true);
      }
    }
    // Distinct stiffness → distinct output (not silently ignored).
    let anyDiff = false;
    for (let i = 0; i < first[0]!.length && !anyDiff; i++) {
      if (!Object.is(first[0]![i], first[2]![i])) anyDiff = true;
    }
    expect(anyDiff).toBe(true);
  });
});

describe('ARAP robustness / fallback', () => {
  it('fewer than two pins falls back to the exact LBS field (rigid translate)', () => {
    const rig: PuppetRig = {
      meshExpansion: 0,
      meshDensity: 6,
      pins: [{ id: 'p', name: 'p', x: 0, y: 0 }],
    };
    const mesh = buildRestMesh(100, 100, 0, rig);
    const pins: DeformPin[] = [{ id: 'p', x: 30, y: -10 }];
    const arap = deform(pins, mesh, 'arap');
    const lbs = deformLbs(pins, mesh);
    // ARAP returns the LBS buffer verbatim → bit-identical.
    for (let i = 0; i < arap.length; i++) {
      expect(Object.is(arap[i], lbs[i])).toBe(true);
    }
    // And that field is a pure rigid translate by the single pin's displacement.
    const n = mesh.vertices.length / 4;
    for (let i = 0; i < n; i++) {
      expect(arap[i * 4 + 0]!).toBeCloseTo(mesh.vertices[i * 4 + 0]! + 30, 3);
      expect(arap[i * 4 + 1]!).toBeCloseTo(mesh.vertices[i * 4 + 1]! - 10, 3);
    }
  });

  it('degenerate (collinear / zero-area) mesh never yields NaN', () => {
    // Hand-built mesh: four collinear vertices → all triangles are degenerate.
    // Pins on the end vertices; ARAP must still return a finite buffer.
    const degenerate: DeformedMesh = {
      vertices: new Float32Array([
        -30, 0, 0, 0,
        -10, 0, 0.33, 0,
        10, 0, 0.66, 0,
        30, 0, 1, 0,
      ]),
      triangles: new Uint16Array([0, 1, 2, 1, 2, 3]),
      pinRestPositions: { A: { x: -30, y: 0 }, B: { x: 30, y: 0 } },
      weights: {
        A: new Float32Array([1, 0.66, 0.33, 0]),
        B: new Float32Array([0, 0.33, 0.66, 1]),
      },
    };
    const pins: DeformPin[] = [
      { id: 'A', x: -40, y: 20, rotation: 45 },
      { id: 'B', x: 40, y: -20, rotation: -45 },
    ];
    const out = deform(pins, degenerate, 'arap');
    expect(out.length).toBe(degenerate.vertices.length);
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true);
    }
    // The pinned end vertices land exactly on their handle targets.
    expect(out[0]!).toBeCloseTo(-40, 3);
    expect(out[1]!).toBeCloseTo(20, 3);
    expect(out[12]!).toBeCloseTo(40, 3);
    expect(out[13]!).toBeCloseTo(-20, 3);
  });

  it('deformArap called directly with <2 pins returns the fallback buffer', () => {
    const rig: PuppetRig = {
      meshExpansion: 0,
      meshDensity: 4,
      pins: [{ id: 'p', name: 'p', x: 0, y: 0 }],
    };
    const mesh = buildRestMesh(80, 80, 0, rig);
    const lbs = deformLbs([{ id: 'p', x: 5, y: 5 }], mesh);
    const arap = deformArap([{ id: 'p', x: 5, y: 5 }], mesh, lbs);
    expect(arap).toBe(lbs); // same reference (verbatim fallback)
  });
});
