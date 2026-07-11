import { sampleTrack } from './interpolate';
import { AnimationEngine } from './AnimationEngine';
import { makeKeyframeId, parseKeyframeId } from './keyframeId';
import type { PropertyTrack } from './types';

const track = (keyframes: PropertyTrack['keyframes']): PropertyTrack => ({
  nodeId: 'n',
  prop: 'x',
  keyframes,
});

describe('sampleTrack', () => {
  test('clamps before first and after last keyframe', () => {
    const t = track([{ t: 1, value: 10 }, { t: 3, value: 30 }]);
    expect(sampleTrack(t, 0)).toBe(10);
    expect(sampleTrack(t, 5)).toBe(30);
  });

  test('linear interpolates the midpoint', () => {
    const t = track([{ t: 0, value: 0 }, { t: 2, value: 100 }]);
    expect(sampleTrack(t, 1)).toBeCloseTo(50);
  });

  test('step easing holds the start value', () => {
    const t = track([{ t: 0, value: 0, easing: 'step' }, { t: 2, value: 100 }]);
    expect(sampleTrack(t, 1.9)).toBe(0);
    expect(sampleTrack(t, 2)).toBe(100);
  });

  test('easeIn is below linear at the midpoint', () => {
    const t = track([{ t: 0, value: 0, easing: 'easeIn' }, { t: 1, value: 100 }]);
    expect(sampleTrack(t, 0.5)).toBeCloseTo(25); // 0.5^2 * 100
  });

  test('empty track returns undefined', () => {
    expect(sampleTrack(track([]), 1)).toBeUndefined();
  });
});

describe('AnimationEngine', () => {
  test('setKeyframe + sample', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 100);
    a.setKeyframe('n1', 'x', 2, 300);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(200);
    expect(a.hasAnimation('n1')).toBe(true);
  });

  test('evaluateScene returns only animated props', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 10);
    a.setKeyframe('n1', 'y', 0, 5);
    const snap = a.evaluateScene(0.5);
    expect(snap.get('n1')?.get('x')).toBeCloseTo(5);
    expect(snap.get('n1')?.get('y')).toBe(5);
    expect(snap.get('n2')).toBeUndefined();
  });

  test('keyframes stay sorted and replace on same time', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 2, 20);
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 0, 5); // replace
    const kfs = a.tracksFor('n1')[0]!.keyframes;
    expect(kfs.map((k) => k.t)).toEqual([0, 2]);
    expect(kfs[0]!.value).toBe(5);
  });

  test('moveKeyframe reties a keyframe to a new time, preserving value', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    a.setKeyframe('n1', 'x', 1, 100);
    a.moveKeyframe('n1', 'x', 1, 3);
    const kfs = a.tracksFor('n1')[0]!.keyframes;
    expect(kfs.map((k) => k.t)).toEqual([0, 3]);
    expect(a.sample('n1', 'x', 3)).toBe(100);
  });

  test('removeTrack disables animation for a prop', () => {
    const a = new AnimationEngine();
    a.setKeyframe('n1', 'x', 0, 0);
    expect(a.isAnimated('n1', 'x')).toBe(true);
    a.removeTrack('n1', 'x');
    expect(a.isAnimated('n1', 'x')).toBe(false);
  });
});

describe('keyframeId codec', () => {
  test('round-trips node/prop/time', () => {
    const id = makeKeyframeId('shape_circle', 'x', 2.5);
    expect(parseKeyframeId(id)).toEqual({ nodeId: 'shape_circle', prop: 'x', t: 2.5 });
  });

  test('rejects malformed ids', () => {
    expect(parseKeyframeId('bad')).toBeNull();
    expect(parseKeyframeId('a::b::notnum')).toBeNull();
  });
});
