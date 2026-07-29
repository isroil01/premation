/**
 * Phase 3 — AE parity: per-pin scale (3B), Mesh Rotation Refinement (3C),
 * silhouette triangulation (3D), overlap depth (3E), Puppet Sketch (3A).
 *
 * Every new property must reduce BIT-IDENTICALLY to the existing path when
 * absent or neutral; that is the house rule and each block below asserts it.
 */

import {
  buildRestMesh,
  deform,
  deformLbs,
  clampPinRotations,
  overlapDepthField,
  type DeformPin,
  type PuppetRig,
  type PuppetSilhouette,
} from './puppet';
import {
  simplifySketch,
  thinByTime,
  sketchToKeyframes,
  dedupeByTime,
  SketchRecorder,
  type SketchSample,
} from './puppetSketch';
import { applyIk } from './rigDeform';
import { computeWorldTransforms, boneRoot, boneTip } from './skeleton';

const rig = (extra: Partial<PuppetRig> = {}): PuppetRig => ({
  meshDensity: 10,
  meshExpansion: 0,
  pins: [
    { id: 'a', name: 'a', x: -40, y: 0 },
    { id: 'b', name: 'b', x: 40, y: 0 },
  ],
  ...extra,
});

const pins = (over: Partial<DeformPin> = {}): DeformPin[] => [
  { id: 'a', x: -40, y: 0 },
  { id: 'b', x: 40, y: 0, ...over },
];

const identical = (a: Float32Array, b: Float32Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};

// ── 3B — per-pin scale ──────────────────────────────────────────────

describe('3B — per-pin scale', () => {
  const mesh = () => buildRestMesh(160, 120, 0, rig());

  it('scale 1 (and absent) is bit-identical to the unscaled path', () => {
    const m = mesh();
    const base = deformLbs(pins(), m);
    expect(identical(deformLbs(pins({ scale: 1 }), m), base)).toBe(true);
    expect(identical(deformLbs(pins({ scale: undefined }), m), base)).toBe(true);
  });

  it('scale > 1 pushes geometry away from the pin', () => {
    const m = mesh();
    const base = deformLbs(pins(), m);
    const big = deformLbs(pins({ scale: 1.8 }), m);
    let moved = 0;
    for (let i = 0; i < base.length; i += 4) {
      if (Math.abs(base[i]! - big[i]!) > 0.5) moved++;
    }
    expect(moved).toBeGreaterThan(5);
  });

  it('scale is centred ON the pin — the vertex at the pin does not move', () => {
    // The pin must sit exactly on a grid vertex for this to be checkable: at
    // density 10 over 160px the columns are -80,-64,…,48,…, so x=48 is exact.
    // (A pin BETWEEN vertices is not a fixed point of its own scaling, which is
    // correct — the nearest vertex is genuinely pushed outward.)
    const onVertex: PuppetRig = {
      meshDensity: 10,
      meshExpansion: 0,
      pins: [
        { id: 'a', name: 'a', x: -48, y: 0 },
        { id: 'b', name: 'b', x: 48, y: 0 },
      ],
    };
    const m = buildRestMesh(160, 120, 0, onVertex);
    const scaled = deformLbs(
      [{ id: 'a', x: -48, y: 0 }, { id: 'b', x: 48, y: 0, scale: 2 }],
      m,
    );
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < m.vertices.length / 4; i++) {
      const d = Math.hypot(m.vertices[i * 4]! - 48, m.vertices[i * 4 + 1]!);
      if (d < bestD) { bestD = d; best = i; }
    }
    expect(bestD).toBeLessThan(1e-6); // the pin really is on a vertex
    expect(Math.abs(scaled[best * 4]! - 48)).toBeLessThan(0.5);
    expect(Math.abs(scaled[best * 4 + 1]!)).toBeLessThan(0.5);
  });

  it('scale composes with rotation and stays finite through ARAP', () => {
    const m = mesh();
    const out = deform(pins({ scale: 1.4, rotation: 30 }), m, 'arap');
    expect(out.length).toBe(m.vertices.length);
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it('is deterministic', () => {
    const m = mesh();
    expect(identical(deform(pins({ scale: 1.6 }), m, 'arap'), deform(pins({ scale: 1.6 }), m, 'arap'))).toBe(true);
  });
});

// ── 3C — Mesh Rotation Refinement ───────────────────────────────────

describe('3C — Mesh Rotation Refinement', () => {
  it('no limit returns the SAME pin array (allocation-free, bit-identical)', () => {
    const p = pins({ rotation: 120 });
    expect(clampPinRotations(p, undefined)).toBe(p);
  });

  it('a limit above every rotation is also a no-op', () => {
    const p = pins({ rotation: 20 });
    expect(clampPinRotations(p, 45)).toBe(p);
  });

  it('clamps magnitude while preserving sign', () => {
    expect(clampPinRotations(pins({ rotation: 120 }), 45)[1]!.rotation).toBe(45);
    expect(clampPinRotations(pins({ rotation: -120 }), 45)[1]!.rotation).toBe(-45);
  });

  it('clamping changes the solved mesh', () => {
    const m = buildRestMesh(160, 120, 0, rig());
    const free = deform(pins({ rotation: 150 }), m, 'arap');
    const capped = deform(pins({ rotation: 150 }), m, 'arap', 20);
    expect(identical(free, capped)).toBe(false);
  });

  it('an unlimited solve is bit-identical to passing undefined', () => {
    const m = buildRestMesh(160, 120, 0, rig());
    expect(identical(deform(pins({ rotation: 60 }), m, 'arap'), deform(pins({ rotation: 60 }), m, 'arap', undefined))).toBe(true);
  });
});

// ── 3D — silhouette triangulation ───────────────────────────────────

describe('3D — silhouette-conforming mesh', () => {
  /** A thin diagonal bar — the case a uniform grid handles worst. */
  const bar: PuppetSilhouette = {
    points: [
      { x: -60, y: -10 }, { x: 40, y: -50 }, { x: 60, y: -30 }, { x: -40, y: 10 },
    ],
  };

  it('grid remains the default (mode absent → unchanged behaviour)', () => {
    const a = buildRestMesh(160, 120, 0, rig(), bar);
    const b = buildRestMesh(160, 120, 0, rig({ meshMode: 'grid' }), bar);
    expect(a.vertices.length).toBe(b.vertices.length);
  });

  it('silhouette mode triangulates the outline instead of a grid', () => {
    const grid = buildRestMesh(160, 120, 0, rig(), bar);
    const sil = buildRestMesh(160, 120, 0, rig({ meshMode: 'silhouette' }), bar);
    expect(sil.vertices.length).toBeGreaterThan(0);
    expect(sil.triangles.length).toBeGreaterThan(0);
    // Fewer vertices for the same artwork — none are spent on empty space.
    expect(sil.vertices.length).toBeLessThan(grid.vertices.length);
  });

  it('every silhouette vertex lies on the artwork, not the bbox', () => {
    const sil = buildRestMesh(160, 120, 0, rig({ meshMode: 'silhouette' }), bar);
    // The grid spans the full padded bbox (±80, ±60); the outline does not.
    for (let i = 0; i < sil.vertices.length; i += 4) {
      expect(Math.abs(sil.vertices[i]!)).toBeLessThanOrEqual(60.001);
      expect(Math.abs(sil.vertices[i + 1]!)).toBeLessThanOrEqual(50.001);
    }
  });

  it('still produces normalized pin weights', () => {
    const sil = buildRestMesh(160, 120, 0, rig({ meshMode: 'silhouette' }), bar);
    const n = sil.vertices.length / 4;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const p of rig().pins) sum += sil.weights[p.id]![i]!;
      expect(sum).toBeCloseTo(1, 4);
    }
  });

  it('falls back to the grid when the outline is unusable', () => {
    const degenerate: PuppetSilhouette = { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] };
    const sil = buildRestMesh(160, 120, 0, rig({ meshMode: 'silhouette' }), degenerate);
    expect(sil.vertices.length).toBe(buildRestMesh(160, 120, 0, rig(), degenerate).vertices.length);
  });

  it('deforms without NaN', () => {
    const sil = buildRestMesh(160, 120, 0, rig({ meshMode: 'silhouette' }), bar);
    const out = deform(pins({ rotation: 25 }), sil, 'arap');
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true);
  });
});

// ── 3E — overlap depth ──────────────────────────────────────────────

describe('3E — overlap depth field', () => {
  const mesh = () => buildRestMesh(160, 120, 0, rig());

  it('no overlap pin → null (the mesh composites flat, as before)', () => {
    expect(overlapDepthField(pins(), mesh())).toBeNull();
    expect(overlapDepthField(pins({ overlap: 0 }), mesh())).toBeNull();
  });

  it('produces one signed depth per vertex', () => {
    const m = mesh();
    const d = overlapDepthField(pins({ overlap: 50 }), m)!;
    expect(d).not.toBeNull();
    expect(d.length).toBe(m.vertices.length / 4);
  });

  it('depth is highest near the overlap pin it came from', () => {
    const m = mesh();
    const d = overlapDepthField(pins({ overlap: 100 }), m)!;
    const near = (x: number) => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < m.vertices.length / 4; i++) {
        const dd = Math.hypot(m.vertices[i * 4]! - x, m.vertices[i * 4 + 1]!);
        if (dd < bestD) { bestD = dd; best = i; }
      }
      return d[best]!;
    };
    expect(near(40)).toBeGreaterThan(near(-40));
  });

  it('opposing overlaps put one region in front of the other', () => {
    const m = mesh();
    const d = overlapDepthField(
      [{ id: 'a', x: -40, y: 0, overlap: -80 }, { id: 'b', x: 40, y: 0, overlap: 80 }],
      m,
    )!;
    let min = Infinity, max = -Infinity;
    for (const v of d) { min = Math.min(min, v); max = Math.max(max, v); }
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(0);
  });

  it('extent broadens the influence', () => {
    const m = mesh();
    const tight = overlapDepthField(pins({ overlap: 100, overlapExtent: 0.3 }), m)!;
    const broad = overlapDepthField(pins({ overlap: 100, overlapExtent: 3 }), m)!;
    const sum = (f: Float32Array) => f.reduce((s, v) => s + v, 0);
    expect(sum(broad)).toBeGreaterThan(sum(tight));
  });

  it('is deterministic', () => {
    const m = mesh();
    const a = overlapDepthField(pins({ overlap: 60 }), m)!;
    const b = overlapDepthField(pins({ overlap: 60 }), m)!;
    expect(identical(a, b)).toBe(true);
  });
});

// ── 3A — Puppet Sketch ──────────────────────────────────────────────

describe('3A — Puppet Sketch reduction', () => {
  /** A dense straight run: 100 samples that should collapse to 2. */
  const straight: SketchSample[] = Array.from({ length: 100 }, (_, i) => ({
    x: i, y: 0, t: i / 100,
  }));

  it('collapses a straight run to its endpoints', () => {
    expect(simplifySketch(straight, 1).length).toBe(2);
  });

  it('keeps the corner of an L-shaped path', () => {
    const L: SketchSample[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0, t: i / 40 })),
      ...Array.from({ length: 20 }, (_, i) => ({ x: 19, y: i, t: (20 + i) / 40 })),
    ];
    const out = simplifySketch(L, 1);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.some((s) => s.x === 19 && s.y === 0)).toBe(true);
  });

  it('a tighter tolerance keeps more points', () => {
    const arc: SketchSample[] = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 59) * Math.PI;
      return { x: Math.cos(a) * 50, y: Math.sin(a) * 50, t: i / 60 };
    });
    expect(simplifySketch(arc, 0.5).length).toBeGreaterThan(simplifySketch(arc, 8).length);
  });

  it('always preserves the first and last sample exactly', () => {
    const out = simplifySketch(straight, 50);
    expect(out[0]).toEqual(straight[0]);
    expect(out[out.length - 1]).toEqual(straight[straight.length - 1]);
  });

  it('handles degenerate inputs', () => {
    expect(simplifySketch([], 1)).toEqual([]);
    expect(simplifySketch([{ x: 0, y: 0, t: 0 }], 1).length).toBe(1);
  });

  it('is deterministic', () => {
    expect(simplifySketch(straight, 2)).toEqual(simplifySketch(straight, 2));
  });

  it('thinByTime drops bunched samples but keeps the span', () => {
    const bunched: SketchSample[] = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0, t: i * 0.001 }));
    const out = thinByTime(bunched, 0.01);
    expect(out.length).toBeLessThan(bunched.length);
    expect(out[0]).toEqual(bunched[0]);
    expect(out[out.length - 1]).toEqual(bunched[49]);
  });

  it('sketchToKeyframes eases the survivors so the reduction reads smooth', () => {
    const arc: SketchSample[] = Array.from({ length: 40 }, (_, i) => {
      const a = (i / 39) * Math.PI;
      return { x: Math.cos(a) * 50, y: Math.sin(a) * 50, t: i / 40 };
    });
    const kfs = sketchToKeyframes(arc, { tolerance: 2 });
    expect(kfs.length).toBeGreaterThan(2);
    expect(kfs.length).toBeLessThan(arc.length);
    expect(kfs[0]!.easing).toBe('easeOut');
    expect(kfs[kfs.length - 1]!.easing).toBe('easeIn');
    expect(kfs[1]!.easing).toBe('easeInOut');
    // Values are the [{x,y}] shape a points data track stores.
    expect(kfs[0]!.value).toHaveLength(1);
  });

  it('ease:false leaves the keyframes linear', () => {
    const kfs = sketchToKeyframes(straight, { ease: false });
    expect(kfs.every((k) => k.easing === undefined)).toBe(true);
  });

  it('SketchRecorder accumulates, reduces, and resets', () => {
    const r = new SketchRecorder();
    for (const s of straight) r.add(s.x, s.y, s.t);
    expect(r.count).toBe(100);
    const kfs = r.finish({ tolerance: 1 });
    expect(kfs.length).toBe(2);
    expect(r.count).toBe(0);
    expect(r.finish()).toEqual([]);
  });

  it('a PAUSED recording collapses to one keyframe, not a stack (live finding)', () => {
    // Ctrl-dragging without the comp playing gives every sample the same
    // timestamp. Before dedupeByTime this produced N keyframes at t=0.
    const paused: SketchSample[] = Array.from({ length: 20 }, (_, i) => ({ x: i * 3, y: i, t: 0 }));
    const kfs = sketchToKeyframes(paused, { tolerance: 1 });
    expect(kfs).toHaveLength(1);
    expect(kfs[0]!.t).toBe(0);
    // …and it keeps the LAST position, which is where the pointer ended up.
    expect(kfs[0]!.value).toEqual([{ x: 57, y: 19 }]);
  });

  it('dedupeByTime keeps the last sample of each timestamp run', () => {
    const out = dedupeByTime([
      { x: 0, y: 0, t: 0 }, { x: 5, y: 0, t: 0 },
      { x: 9, y: 0, t: 1 }, { x: 9, y: 4, t: 1 }, { x: 2, y: 2, t: 2 },
    ]);
    expect(out).toEqual([
      { x: 5, y: 0, t: 0 }, { x: 9, y: 4, t: 1 }, { x: 2, y: 2, t: 2 },
    ]);
  });

  it('a partially-paused recording keeps the moving part', () => {
    const mixed: SketchSample[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0, t: 0 })),
      { x: 40, y: -30, t: 0.5 },
      { x: 80, y: 0, t: 1 },
    ];
    const kfs = sketchToKeyframes(mixed, { tolerance: 1 });
    expect(kfs.map((k) => k.t)).toEqual([0, 0.5, 1]);
  });

  it('out-of-order samples are sorted by time', () => {
    const r = new SketchRecorder();
    r.add(10, 0, 1);
    r.add(0, 0, 0);
    r.add(5, 0, 0.5);
    const kfs = r.finish({ tolerance: 100 });
    expect(kfs.map((k) => k.t)).toEqual([0, 1]);
  });
});

// ── 4.4 — IK pole vectors ───────────────────────────────────────────

describe('4.4 — IK pole vectors', () => {
  const chain = [
    { id: 'upper', parentId: null, length: 100, x: -150, y: 0, rotation: 0 },
    { id: 'fore', parentId: 'upper', length: 100, x: 100, y: 0, rotation: 0 },
  ] as const;

  const elbowFor = (pole?: { x: number; y: number }) => {
    const posed = applyIk([...chain], [
      { boneId: 'fore', x: -60, y: 70, chainLength: 2, ...(pole ? { pole } : {}) },
    ]);
    const w = computeWorldTransforms({ bones: posed });
    const e = boneRoot(w.get('fore')!);
    const tip = boneTip(w.get('fore')!, 100);
    return { elbow: e, tip };
  };

  it('opposite poles bend the joint to opposite sides', () => {
    const up = elbowFor({ x: -150, y: -300 });
    const down = elbowFor({ x: -150, y: 300 });
    expect(Math.hypot(up.elbow.x - down.elbow.x, up.elbow.y - down.elbow.y)).toBeGreaterThan(20);
  });

  it('both bend sides still reach the target exactly', () => {
    for (const pole of [{ x: -150, y: -300 }, { x: -150, y: 300 }]) {
      const { tip } = elbowFor(pole);
      expect(Math.hypot(tip.x - -60, tip.y - 70)).toBeLessThan(2);
    }
  });

  it('no pole preserves the current bend side (unchanged default)', () => {
    const none = elbowFor(undefined);
    const down = elbowFor({ x: -150, y: 300 });
    expect(none.elbow.x).toBeCloseTo(down.elbow.x, 3);
    expect(none.elbow.y).toBeCloseTo(down.elbow.y, 3);
  });

  it('a pole cannot help an UNREACHABLE target — the chain is fully extended', () => {
    // Guards the scenario that made a live check look like a bug: at 273px from
    // a 200px chain there is only one solution, so the pole legitimately does
    // nothing. Reachability must be checked before blaming the pole.
    const far = (pole: { x: number; y: number }) => {
      const posed = applyIk([...chain], [{ boneId: 'fore', x: 120, y: 40, chainLength: 2, pole }]);
      return boneRoot(computeWorldTransforms({ bones: posed }).get('fore')!);
    };
    const a = far({ x: -150, y: -300 });
    const b = far({ x: -150, y: 300 });
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1);
  });
});
