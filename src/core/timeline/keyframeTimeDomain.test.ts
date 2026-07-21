/**
 * Reproduction: keyframes written from different surfaces must land on the
 * same time axis, and a surface must READ on the axis it WRITES on.
 *
 * The app has three keyframe-writing paths and they did not agree:
 *   - App.addKeyframesFor      → getRemappedTime(id, raw)
 *   - App.handlePropertyStopwatch → toLayerTime(id, raw)
 *   - TransformSection/TextSection → toLayerTime(id, raw)
 * and TransformSection *sampled* at the RAW time while writing at toLayerTime.
 */

import { AnimationEngine } from '@motion/animation';
import { getTimelineController, getRemappedTime } from '@core/timeline/TimelineController';

describe('the two time helpers must agree about a layer', () => {
  const controller = getTimelineController();

  it('agree when the node has no clips (identity both ways)', () => {
    expect(controller.toLayerTime('nope', 5)).toBe(5);
    expect(getRemappedTime('nope', 5)).toBe(5);
  });
});

describe('read/write domain symmetry', () => {
  /**
   * The invariant that actually matters, independent of clips: whatever time
   * function a surface uses to WRITE a keyframe, it must use the SAME one to
   * READ the value back. Otherwise typing a value at 5s stores it at one time
   * and displays a sample from another — and the next edit "corrects" the
   * display by overwriting the keyframe you already made.
   */
  it('a value written at t reads back at t', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe('n', 'x', 1, -400);
    anim.setKeyframe('n', 'x', 5, 0);
    expect(anim.sample('n', 'x', 1)).toBeCloseTo(-400);
    expect(anim.sample('n', 'x', 5)).toBeCloseTo(0);
    // Distinct times interpolate rather than collapsing to one value.
    expect(anim.sample('n', 'x', 3)).toBeGreaterThan(-400);
    expect(anim.sample('n', 'x', 3)).toBeLessThan(0);
  });

  it('writing at a DIFFERENT time than you read collapses the animation', () => {
    // This is the failure mode, made explicit: write at (t - offset), read at t.
    // The user sets -400 at 1s, moves to 5s, sees the clamped sample of the
    // only keyframe, types 0 — and the second write lands where the first
    // sample said, so the curve never gets two distinct values where expected.
    const anim = new AnimationEngine();
    const OFFSET = 1; // e.g. a clip starting at 1s
    anim.setKeyframe('n', 'x', 1 - OFFSET, -400); // stopwatch: layer-local
    anim.setKeyframe('n', 'x', 5, 0);             // timeline: absolute
    // The keyframes exist, but they are on two different axes: sampling the
    // comp's 1s gives the interpolated middle, not the -400 the user set.
    expect(anim.sample('n', 'x', 1)).not.toBeCloseTo(-400);
  });
});
