/**
 * Easy Ease / F9 on a DATA keyframe (Phase 2, step 3).
 *
 * `applyEasingToKeyframes` only ever walked `getTrackKeyframes` — the SCALAR
 * store — so pressing F9 on a puppet pin's position keyframe silently did
 * nothing. The sampler had honoured `easing`/`bezier` on a DataKeyframe all
 * along; nothing could author them.
 */

import {  setDataKeyframeEasing } from '@motion/animation';

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
