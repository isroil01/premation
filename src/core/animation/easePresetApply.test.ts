/**
 * The ease library reaching the keyframes — the WIRING, not the table.
 *
 * `easePresets.test.ts` proves the curves are the curves. This proves that
 * naming one actually writes it, through the single entry point every surface
 * uses (`applyEasingToKeyframes`), on BOTH stores: a library id that resolved
 * only on the scalar path would leave puppet pins and gradient stops silently
 * linear, which is the exact defect the data-track branch was added to fix.
 */

import { AnimationEngine, makeKeyframeId } from '@motion/animation';
import { applyEasingToKeyframes } from './keyframeAssistants';
import { EASE_PRESETS, easePresetById } from './easePresets';

const PIN = 'puppet.mover.position';

function scalarEngine(): AnimationEngine {
  const anim = new AnimationEngine();
  anim.setKeyframe('n', 'transform.x', 0, 0, 'linear');
  anim.setKeyframe('n', 'transform.x', 1, 100, 'linear');
  return anim;
}

function dataEngine(): AnimationEngine {
  const anim = new AnimationEngine();
  anim.setDataTrack('m', PIN, {
    nodeId: 'm',
    prop: PIN,
    kind: 'points',
    keyframes: [
      { t: 0, value: [{ x: 0, y: 0 }] },
      { t: 1, value: [{ x: 100, y: 0 }] },
    ],
  } as never);
  return anim;
}

describe('applying a library curve to a SCALAR keyframe', () => {
  it.each(EASE_PRESETS.map((p) => [p.id] as const))('%s writes its handles', (id) => {
    const anim = scalarEngine();
    applyEasingToKeyframes([makeKeyframeId('n', 'transform.x', 0)], id, anim);
    const kf = anim.getTrackKeyframes('n', 'transform.x')!.find((k) => k.t === 0)!;
    expect(kf.easing).toBe('bezier');
    expect(kf.bezier).toEqual(easePresetById(id)!.bezier);
  });

  it('changes the sampled value, so the curve is actually consulted', () => {
    // Writing the handles onto the keyframe proves nothing on its own — the
    // interpolator has to read them. Expo In has barely moved at the midpoint;
    // linear is at exactly half.
    const anim = scalarEngine();
    const x = (t: number) => anim.sample('n', 'transform.x', t)!;
    expect(x(0.5)).toBeCloseTo(50, 5);

    applyEasingToKeyframes([makeKeyframeId('n', 'transform.x', 0)], 'expo-in', anim);
    expect(x(0.5)).toBeLessThan(20);

    applyEasingToKeyframes([makeKeyframeId('n', 'transform.x', 0)], 'expo-out', anim);
    expect(x(0.5)).toBeGreaterThan(80);
  });

  it('back-out overshoots past the target value mid-segment', () => {
    // The property that makes Back worth having, asserted end to end: the
    // sampled value must exceed the arriving keyframe's 100 before settling.
    const anim = scalarEngine();
    applyEasingToKeyframes([makeKeyframeId('n', 'transform.x', 0)], 'back-out', anim);
    const x = (t: number) => anim.sample('n', 'transform.x', t)!;
    const peak = Math.max(...Array.from({ length: 101 }, (_, i) => x(i / 100)));
    expect(peak).toBeGreaterThan(100);
    // …and still lands exactly on it.
    expect(x(1)).toBeCloseTo(100, 5);
  });

  it('a later preset replaces an earlier one rather than compounding', () => {
    const anim = scalarEngine();
    const id = makeKeyframeId('n', 'transform.x', 0);
    applyEasingToKeyframes([id], 'back-out', anim);
    applyEasingToKeyframes([id], 'sine-in', anim);
    const kf = anim.getTrackKeyframes('n', 'transform.x')!.find((k) => k.t === 0)!;
    expect(kf.bezier).toEqual(easePresetById('sine-in')!.bezier);
  });

  it('the legacy interpolation types still resolve as before', () => {
    // The union grew; the five AE names must not have moved.
    const anim = scalarEngine();
    const id = makeKeyframeId('n', 'transform.x', 0);
    applyEasingToKeyframes([id], 'Linear', anim);
    expect(anim.getTrackKeyframes('n', 'transform.x')!.find((k) => k.t === 0)!.easing).toBe('linear');
    applyEasingToKeyframes([id], 'Hold', anim);
    expect(anim.getTrackKeyframes('n', 'transform.x')!.find((k) => k.t === 0)!.easing).toBe('step');
  });
});

describe('applying a library curve to a DATA keyframe', () => {
  it('writes the handles onto the data track too', () => {
    const anim = dataEngine();
    applyEasingToKeyframes([makeKeyframeId('m', PIN, 0)], 'quint-out', anim);
    const kf = anim.getDataTrack('m', PIN)!.keyframes.find((k) => k.t === 0)!;
    expect(kf.easing).toBe('bezier');
    expect(kf.bezier).toEqual(easePresetById('quint-out')!.bezier);
  });

  it('the data sampler honours it', () => {
    const anim = dataEngine();
    const x = (t: number) => (anim.sampleData('m', PIN, t) as Array<{ x: number }>)[0]!.x;
    expect(x(0.5)).toBeCloseTo(50, 5);
    applyEasingToKeyframes([makeKeyframeId('m', PIN, 0)], 'quint-out', anim);
    expect(x(0.5)).toBeGreaterThan(80);
  });
});
