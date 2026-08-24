import {
  velocityAngleDeg,
  samplePath,
  hasPositionAnimation,
  positionSpan,
  keyframeTimes,
  motionPathKeyframes,
  motionPathFrameSamples,
  motionPathTangents,
  setPathTangent,
  smoothMotionPath,
  straightenMotionPath,
  hasPathTangents,
  positionSamplerFor,
  autoOrientAngleDeg,
} from './motionPath';
import { AnimationEngine as AnimationEngineReal } from '@motion/animation';
import type { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';

describe('velocityAngleDeg', () => {
  it('is 0 for rightward, 90 for downward, null when still', () => {
    expect(velocityAngleDeg(10, 0)).toBeCloseTo(0);
    expect(velocityAngleDeg(0, 10)).toBeCloseTo(90);
    expect(velocityAngleDeg(-10, 0)).toBeCloseTo(180);
    expect(velocityAngleDeg(0, 0)).toBeNull();
  });
});

describe('samplePath', () => {
  it('produces n+1 evenly spaced samples', () => {
    const pts = samplePath(0, 2, 4, (t) => ({ x: t * 10, y: 0 }));
    expect(pts).toHaveLength(5);
    expect(pts.map((p) => p.t)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(pts[2]!.x).toBeCloseTo(10);
  });

  it('collapses a degenerate range to one sample', () => {
    expect(samplePath(1, 1, 8, () => ({ x: 5, y: 6 }))).toEqual([{ t: 1, x: 5, y: 6 }]);
  });
});

// ── Engine-backed helpers with a minimal mock ────────────────────────

function mockNode(): SceneNode {
  return {
    id: 'n1',
    name: 'N',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'n1_t', type: 'Transform', props: { x: 0, y: 0 } }],
  } as unknown as SceneNode;
}

/** Engine mock: x ramps 0→100 over [0,1], y stays 0. */
function mockEngine(): AnimationEngine {
  const xKeys = [
    { t: 0, value: 0 },
    { t: 1, value: 100 },
  ];
  return {
    isAnimated: (_id: string, prop: string) => prop === 'x',
    sample: (_id: string, prop: string, t: number) => (prop === 'x' ? Math.max(0, Math.min(100, t * 100)) : undefined),
    getTrackKeyframes: (_id: string, prop: string) => (prop === 'x' ? xKeys : null),
  } as unknown as AnimationEngine;
}

describe('engine-backed helpers', () => {
  const node = mockNode();
  const engine = mockEngine();

  it('detects position animation from the x track', () => {
    expect(hasPositionAnimation('n1', engine)).toBe(true);
  });

  it('reports the keyframe span and times', () => {
    expect(positionSpan('n1', engine)).toEqual({ min: 0, max: 1 });
    expect(keyframeTimes('n1', engine)).toEqual([0, 1]);
  });

  it('places keyframe dots at sampled positions', () => {
    const kfs = motionPathKeyframes(node, engine);
    expect(kfs.map((k) => [k.t, k.x, k.y])).toEqual([
      [0, 0, 0],
      [1, 100, 0],
    ]);
  });

  it('generates per-frame tick dots according to composition FPS', () => {
    // 0 to 1 second at 4 fps -> 5 frames: t=0, 0.25, 0.5, 0.75, 1
    const frameDots = motionPathFrameSamples(node, 4, engine);
    expect(frameDots).toHaveLength(5);
    expect(frameDots.map((f) => f.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(frameDots.map((f) => f.x)).toEqual([0, 25, 50, 75, 100]);
  });

  it('auto-orients along the direction of travel (rightward → 0°)', () => {
    expect(autoOrientAngleDeg(node, 0.5, engine)).toBeCloseTo(0);
  });
});

// ── Spatial bezier tangents (curved paths) — real engine ────────────

describe('spatial motion-path tangents', () => {
  const makeEngine = (): AnimationEngineReal => {
    const engine = new AnimationEngineReal();
    engine.setKeyframe('n1', 'x', 0, 0);
    engine.setKeyframe('n1', 'y', 0, 0);
    engine.setKeyframe('n1', 'x', 1, 100);
    engine.setKeyframe('n1', 'y', 1, 0);
    return engine;
  };

  it('exposes effective handles at the linear third-points by default', () => {
    const engine = makeEngine();
    const tans = motionPathTangents(mockNode(), engine);
    expect(tans).toHaveLength(2);
    expect(tans[0]!.out).toEqual({ x: 100 / 3, y: 0 });
    expect(tans[0]!.in).toBeNull(); // no segment arrives at the first keyframe
    expect(tans[1]!.in).toEqual({ x: 100 - 100 / 3, y: 0 });
    expect(tans[1]!.out).toBeNull();
  });

  it('setPathTangent bends the trajectory through the dragged handle', () => {
    const engine = makeEngine();
    const node = mockNode();
    // Straight path: y is 0 at the midpoint.
    expect(positionSamplerFor(node, engine)(0.5).y).toBeCloseTo(0);
    // Pull the out handle down (+y in comp space).
    setPathTangent('n1', 0, 'out', { x: 33, y: 60 }, false, engine);
    setPathTangent('n1', 1, 'in', { x: 67, y: 60 }, false, engine);
    const mid = positionSamplerFor(node, engine)(0.5);
    expect(mid.y).toBeGreaterThan(20); // curve dips through the handles
    // Keyframe positions themselves are unchanged.
    expect(positionSamplerFor(node, engine)(0).y).toBeCloseTo(0);
    expect(positionSamplerFor(node, engine)(1).y).toBeCloseTo(0);
  });

  it('mirror reflects the opposite handle; broken leaves it alone', () => {
    const engine = makeEngine();
    engine.setKeyframe('n1', 'x', 2, 200);
    engine.setKeyframe('n1', 'y', 2, 0);
    // Interior keyframe at t=1 has both sides. Mirrored drag of 'out'…
    setPathTangent('n1', 1, 'out', { x: 130, y: 40 }, true, engine);
    let kx = engine.getTrackKeyframes('n1', 'x')!.find((k) => k.t === 1)!;
    let ky = engine.getTrackKeyframes('n1', 'y')!.find((k) => k.t === 1)!;
    expect(kx.so).toBe(30);
    expect(kx.si).toBe(-30); // mirrored
    expect(ky.so).toBe(40);
    expect(ky.si).toBe(-40);
    // …then a broken drag of 'in' only moves 'in'.
    setPathTangent('n1', 1, 'in', { x: 80, y: 0 }, false, engine);
    kx = engine.getTrackKeyframes('n1', 'x')!.find((k) => k.t === 1)!;
    ky = engine.getTrackKeyframes('n1', 'y')!.find((k) => k.t === 1)!;
    expect(kx.si).toBe(-20);
    expect(kx.so).toBe(30); // untouched
    expect(ky.si).toBe(0);
    expect(ky.so).toBe(40);
  });

  it('smoothMotionPath curves the path; straightenMotionPath restores lines', () => {
    const engine = new AnimationEngineReal();
    const node = mockNode();
    // An L-shaped path: right then down.
    engine.setKeyframe('n1', 'x', 0, 0);
    engine.setKeyframe('n1', 'y', 0, 0);
    engine.setKeyframe('n1', 'x', 1, 100);
    engine.setKeyframe('n1', 'y', 1, 0);
    engine.setKeyframe('n1', 'x', 2, 100);
    engine.setKeyframe('n1', 'y', 2, 100);
    expect(hasPathTangents('n1', engine)).toBe(false);
    smoothMotionPath('n1', engine);
    expect(hasPathTangents('n1', engine)).toBe(true);
    // The smoothed corner overshoots x past 100 (classic rounded corner).
    const nearCorner = positionSamplerFor(node, engine)(1.2);
    expect(nearCorner.x).toBeGreaterThan(100);
    straightenMotionPath('n1', engine);
    expect(hasPathTangents('n1', engine)).toBe(false);
    expect(positionSamplerFor(node, engine)(1.2).x).toBeCloseTo(100);
  });
});
