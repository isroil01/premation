import {
  velocityAngleDeg,
  samplePath,
  hasPositionAnimation,
  positionSpan,
  keyframeTimes,
  motionPathKeyframes,
  autoOrientAngleDeg,
} from './motionPath';
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

  it('auto-orients along the direction of travel (rightward → 0°)', () => {
    expect(autoOrientAngleDeg(node, 0.5, engine)).toBeCloseTo(0);
  });
});
