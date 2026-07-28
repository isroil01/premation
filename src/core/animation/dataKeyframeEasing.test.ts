/**
 * Easy Ease / F9 on a DATA keyframe (Phase 2, step 3).
 *
 * `applyEasingToKeyframes` only ever walked `getTrackKeyframes` — the SCALAR
 * store — so pressing F9 on a puppet pin's position keyframe silently did
 * nothing. The sampler had honoured `easing`/`bezier` on a DataKeyframe all
 * along; nothing could author them.
 */

import { AnimationEngine, makeKeyframeId, setDataKeyframeEasing } from '@motion/animation';
import { applyEasingToKeyframes } from './keyframeAssistants';

const PIN = 'puppet.mover.position';

function engineWithPinTrack(): AnimationEngine {
  const anim = new AnimationEngine();
  anim.setDataTrack('m', PIN, {
    nodeId: 'm',
    prop: PIN,
    kind: 'points',
    keyframes: [
      { t: 0, value: [{ x: 0, y: 0 }] },
      { t: 2, value: [{ x: 60, y: 0 }] },
    ],
  } as never);
  return anim;
}

const kfAt = (anim: AnimationEngine, t: number) =>
  anim.getDataTrack('m', PIN)!.keyframes.find((k) => k.t === t)!;

const pinXAt = (anim: AnimationEngine, t: number) =>
  (anim.sampleData('m', PIN, t) as Array<{ x: number }>)[0]!.x;

describe('setDataKeyframeEasing (pure)', () => {
  const kfs = [
    { t: 0, value: [{ x: 0, y: 0 }] },
    { t: 1, value: [{ x: 5, y: 0 }] },
  ];

  it('sets easing on the matching keyframe only', () => {
    const out = setDataKeyframeEasing(kfs, 0, 'bezier', [0.33, 0, 0.67, 1]);
    expect(out[0]!.easing).toBe('bezier');
    expect(out[0]!.bezier).toEqual([0.33, 0, 0.67, 1]);
    expect(out[1]!.easing).toBeUndefined();
  });

  it('returns the SAME array when no keyframe sits at that time', () => {
    expect(setDataKeyframeEasing(kfs, 0.5, 'hold')).toBe(kfs);
  });

  it('clears a stale bezier when switching to a non-bezier easing', () => {
    const withBez = setDataKeyframeEasing(kfs, 0, 'bezier', [0.9, 0, 1, 0.2]);
    const linear = setDataKeyframeEasing(withBez, 0, 'linear');
    expect(linear[0]!.easing).toBe('linear');
    expect(linear[0]!.bezier).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(kfs);
    setDataKeyframeEasing(kfs, 0, 'hold');
    expect(JSON.stringify(kfs)).toBe(before);
  });
});

describe('Easy Ease reaches a puppet pin keyframe', () => {
  it('F9 (Ease) writes a bezier curve onto the data keyframe', () => {
    const anim = engineWithPinTrack();
    applyEasingToKeyframes([makeKeyframeId('m', PIN, 0)], 'Ease', anim);
    const kf = kfAt(anim, 0);
    expect(kf.easing).toBe('bezier');
    expect(kf.bezier).toBeDefined();
  });

  it('…and the eased curve actually changes the sampled pin position', () => {
    const linear = engineWithPinTrack();
    const eased = engineWithPinTrack();
    applyEasingToKeyframes([makeKeyframeId('m', PIN, 0)], 'EaseIn', eased);

    expect(pinXAt(eased, 1)).toBeLessThan(pinXAt(linear, 1) - 1);
    // Endpoints unchanged.
    expect(pinXAt(eased, 0)).toBeCloseTo(0, 5);
    expect(pinXAt(eased, 2)).toBeCloseTo(60, 5);
  });

  it('Hold freezes the pin until the next keyframe', () => {
    const anim = engineWithPinTrack();
    applyEasingToKeyframes([makeKeyframeId('m', PIN, 0)], 'Hold', anim);
    expect(kfAt(anim, 0).easing).toBe('hold');
    expect(pinXAt(anim, 1.9)).toBeCloseTo(0, 5);
    expect(pinXAt(anim, 2)).toBeCloseTo(60, 5);
  });

  it('Linear clears an earlier ease back to a straight segment', () => {
    const anim = engineWithPinTrack();
    applyEasingToKeyframes([makeKeyframeId('m', PIN, 0)], 'Ease', anim);
    applyEasingToKeyframes([makeKeyframeId('m', PIN, 0)], 'Linear', anim);
    expect(kfAt(anim, 0).easing).toBe('linear');
    expect(kfAt(anim, 0).bezier).toBeUndefined();
    expect(pinXAt(anim, 1)).toBeCloseTo(30, 5);
  });

  it('leaves the keyframe VALUE untouched', () => {
    const anim = engineWithPinTrack();
    applyEasingToKeyframes([makeKeyframeId('m', PIN, 0)], 'EaseOut', anim);
    expect(kfAt(anim, 0).value).toEqual([{ x: 0, y: 0 }]);
    expect(kfAt(anim, 2).value).toEqual([{ x: 60, y: 0 }]);
  });

  it('a scalar selection still eases exactly as before (no regression)', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe('m', 'opacity', 0, 0);
    anim.setKeyframe('m', 'opacity', 2, 100);
    applyEasingToKeyframes([makeKeyframeId('m', 'opacity', 0)], 'Ease', anim);
    const kf = anim.getTrackKeyframes('m', 'opacity')!.find((k) => k.t === 0)!;
    expect(kf.easing).toBe('bezier');
  });

  it('scalar Hold still stores the step spelling', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe('m', 'opacity', 0, 0);
    anim.setKeyframe('m', 'opacity', 2, 100);
    applyEasingToKeyframes([makeKeyframeId('m', 'opacity', 0)], 'Hold', anim);
    const kf = anim.getTrackKeyframes('m', 'opacity')!.find((k) => k.t === 0)!;
    expect(kf.easing).toBe('step');
  });

  it('a mixed selection eases both kinds in one action', () => {
    const anim = engineWithPinTrack();
    anim.setKeyframe('m', 'opacity', 0, 0);
    anim.setKeyframe('m', 'opacity', 2, 100);
    applyEasingToKeyframes(
      [makeKeyframeId('m', PIN, 0), makeKeyframeId('m', 'opacity', 0)],
      'Ease',
      anim,
    );
    expect(kfAt(anim, 0).easing).toBe('bezier');
    expect(anim.getTrackKeyframes('m', 'opacity')!.find((k) => k.t === 0)!.easing).toBe('bezier');
  });
});
