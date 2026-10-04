/**
 * Phase 3 — AE parity: per-pin scale (3B), Mesh Rotation Refinement (3C),
 * silhouette triangulation (3D), overlap depth (3E), Puppet Sketch (3A).
 *
 * Every new property must reduce BIT-IDENTICALLY to the existing path when
 * absent or neutral; that is the house rule and each block below asserts it.
 */

import {
  clampPinRotations,
  type DeformPin,
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

const pins = (over: Partial<DeformPin> = {}): DeformPin[] => [
  { id: 'a', x: -40, y: 0 },
  { id: 'b', x: 40, y: 0, ...over },
];

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
