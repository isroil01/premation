/**
 * Spatial tangents on point-valued data tracks (Phase 2, step 2).
 *
 * Temporal easing controls HOW FAST a value travels between keyframes; spatial
 * tangents control the SHAPE of the path it travels along. Puppet pins had
 * neither, then easing, and now both — so a pin can arc instead of sliding down
 * a straight line, which is the Adobe-documented fix for robotic limb motion.
 */

import {
  AnimationEngine,
  dataPathTangents,
  setDataSpatialTangent,
  clearDataSpatialTangents,
  hasDataSpatialTangents,
  smoothDataSpatialTangents,
  type DataTrack,
} from '@motion/animation';

const PIN = 'puppet.mover.position';

/** A pin travelling (0,0) → (100,0) → (200,0): a straight horizontal run. */
function track(): DataTrack {
  return {
    nodeId: 'm',
    prop: PIN,
    kind: 'points',
    keyframes: [
      { t: 0, value: [{ x: 0, y: 0 }] },
      { t: 1, value: [{ x: 100, y: 0 }] },
      { t: 2, value: [{ x: 200, y: 0 }] },
    ],
  } as DataTrack;
}

function engineWith(t: DataTrack): AnimationEngine {
  const anim = new AnimationEngine();
  anim.setDataTrack('m', PIN, t);
  return anim;
}

const pinAt = (anim: AnimationEngine, t: number) =>
  (anim.sampleData('m', PIN, t) as Array<{ x: number; y: number }>)[0]!;

describe('straight by default (no behaviour change)', () => {
  it('a track with no tangents interpolates linearly, exactly as before', () => {
    const anim = engineWith(track());
    expect(pinAt(anim, 0.5).x).toBeCloseTo(50, 6);
    expect(pinAt(anim, 0.5).y).toBeCloseTo(0, 6);
  });

  it('hasDataSpatialTangents is false for an untouched track', () => {
    expect(hasDataSpatialTangents(track())).toBe(false);
  });
});

describe('a tangent bends the path', () => {
  it('pulling the outgoing handle upward arcs the pin off the straight line', () => {
    const t0 = track();
    // Handle is ABSOLUTE: (33, -60) from a keyframe at (0,0) → offset (33,-60).
    const keyframes = setDataSpatialTangent(t0.keyframes, 0, 0, 'out', { x: 33, y: -60 }, false);
    const anim = engineWith({ ...t0, keyframes });

    const mid = pinAt(anim, 0.5);
    expect(mid.y).toBeLessThan(-10);          // genuinely off the axis
    expect(hasDataSpatialTangents({ ...t0, keyframes })).toBe(true);
  });

  it('endpoints stay pinned exactly — a tangent never moves a keyframe', () => {
    const t0 = track();
    const keyframes = setDataSpatialTangent(t0.keyframes, 0, 0, 'out', { x: 33, y: -60 }, false);
    const anim = engineWith({ ...t0, keyframes });
    expect(pinAt(anim, 0)).toEqual({ x: 0, y: 0 });
    expect(pinAt(anim, 1)).toEqual({ x: 100, y: 0 });
    expect(pinAt(anim, 2)).toEqual({ x: 200, y: 0 });
  });

  it('mirroring produces a smooth point (opposite handle reflected)', () => {
    const t0 = track();
    const keyframes = setDataSpatialTangent(t0.keyframes, 1, 0, 'out', { x: 140, y: -30 }, true);
    const kf = keyframes.find((k) => k.t === 1)!;
    expect(kf.so![0]).toEqual({ x: 40, y: -30 });
    expect(kf.si![0]).toEqual({ x: -40, y: 30 });
  });

  it('without mirroring the opposite handle is left alone (broken point)', () => {
    const t0 = track();
    const keyframes = setDataSpatialTangent(t0.keyframes, 1, 0, 'out', { x: 140, y: -30 }, false);
    const kf = keyframes.find((k) => k.t === 1)!;
    expect(kf.so![0]).toEqual({ x: 40, y: -30 });
    expect(kf.si![0]).toBeNull();
  });

  it('returns the SAME array when no keyframe sits at that time', () => {
    const kfs = track().keyframes;
    expect(setDataSpatialTangent(kfs, 0.5, 0, 'out', { x: 1, y: 1 }, false)).toBe(kfs);
  });

  it('does not mutate the input keyframes', () => {
    const kfs = track().keyframes;
    const before = JSON.stringify(kfs);
    setDataSpatialTangent(kfs, 0, 0, 'out', { x: 5, y: 5 }, true);
    expect(JSON.stringify(kfs)).toBe(before);
  });
});

describe('spatial and temporal are independent', () => {
  it('easing changes WHEN the pin is somewhere; tangents change WHERE it goes', () => {
    const t0 = track();
    const curved = setDataSpatialTangent(t0.keyframes, 0, 0, 'out', { x: 33, y: -60 }, false);

    const plain = engineWith({ ...t0, keyframes: curved });
    const eased = engineWith({
      ...t0,
      keyframes: curved.map((k) => (k.t === 0 ? { ...k, easing: 'easeIn' as const } : k)),
    });

    // Same curve, different progress along it at the midpoint…
    expect(pinAt(eased, 0.5).x).toBeLessThan(pinAt(plain, 0.5).x);
    // …and both are off the straight line, so the shape survived the easing.
    expect(pinAt(eased, 0.5).y).toBeLessThan(0);
    expect(pinAt(plain, 0.5).y).toBeLessThan(0);
  });
});

describe('overlay handle positions', () => {
  it('defaults to the linear third point so a handle is always grabbable', () => {
    const h = dataPathTangents(track());
    // First keyframe: no incoming segment, outgoing handle 1/3 toward the next.
    expect(h[0]!.in).toBeNull();
    expect(h[0]!.out).toEqual({ x: 100 / 3, y: 0 });
    // Last keyframe: no outgoing segment.
    expect(h[2]!.out).toBeNull();
    expect(h[2]!.in).toEqual({ x: 200 - 100 / 3, y: 0 });
  });

  it('reports an explicit tangent as an ABSOLUTE handle position', () => {
    const t0 = track();
    const keyframes = setDataSpatialTangent(t0.keyframes, 1, 0, 'out', { x: 140, y: -30 }, false);
    const h = dataPathTangents({ ...t0, keyframes });
    expect(h[1]!.out).toEqual({ x: 140, y: -30 });
  });

  it('round-trips: set a handle, read it back unchanged', () => {
    const t0 = track();
    const target = { x: 55, y: -42 };
    const keyframes = setDataSpatialTangent(t0.keyframes, 0, 0, 'out', target, false);
    expect(dataPathTangents({ ...t0, keyframes })[0]!.out).toEqual(target);
  });
});

describe('smooth / straighten', () => {
  it('smoothing an L-shaped path gives interior keyframes real tangents', () => {
    const bent: DataTrack = {
      ...track(),
      keyframes: [
        { t: 0, value: [{ x: 0, y: 0 }] },
        { t: 1, value: [{ x: 100, y: 0 }] },
        { t: 2, value: [{ x: 100, y: 100 }] },
      ],
    } as DataTrack;
    const keyframes = smoothDataSpatialTangents(bent);
    expect(keyframes[1]!.so![0]).toEqual({ x: 100 / 6, y: 100 / 6 });
    expect(keyframes[1]!.si![0]).toEqual({ x: -100 / 6, y: -100 / 6 });
    // Endpoints keep the linear default.
    expect(keyframes[0]!.so).toBeUndefined();
  });

  it('straightening removes every tangent and restores the linear result', () => {
    const t0 = track();
    const curved = setDataSpatialTangent(t0.keyframes, 0, 0, 'out', { x: 33, y: -60 }, true);
    const straight = clearDataSpatialTangents(curved);
    expect(hasDataSpatialTangents({ ...t0, keyframes: straight })).toBe(false);
    expect(pinAt(engineWith({ ...t0, keyframes: straight }), 0.5).y).toBeCloseTo(0, 6);
  });

  it('smoothing needs at least 3 keyframes', () => {
    const two: DataTrack = {
      ...track(),
      keyframes: [
        { t: 0, value: [{ x: 0, y: 0 }] },
        { t: 1, value: [{ x: 10, y: 0 }] },
      ],
    } as DataTrack;
    expect(smoothDataSpatialTangents(two)).toBe(two.keyframes);
  });
});
