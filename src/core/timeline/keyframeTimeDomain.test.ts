/**
 * The canonical keyframe time axis.
 *
 * Keyframes are stored on ONE axis — the time `buildSnapshot` hands the
 * animation engine (`remapOf`): precomp-ancestor time remaps, then the active
 * clip's retime (`sourceIn + (frame − start)`), then the layer's own
 * stretch/reverse/freeze. `compToKeyframeTime` must reproduce that exactly,
 * and `keyframeToCompTime` must be its true inverse wherever an inverse
 * exists — that is what makes timeline diamonds, the graph editor and every
 * inspector agree with the pixels.
 *
 * History: the app once had TWO conversions (`getRemappedTime` — clip-only —
 * and the naive bar-relative `toLayerTime`) and surfaces mixed them, so a
 * value typed at 5s could overwrite the keyframe set at 1s the moment a clip
 * was moved or trimmed. `toLayerTime` survives for layer-BAR geometry
 * (markers) only.
 */

import { AnimationEngine } from '@motion/animation';
import {
  
  
  
  
} from '@core/timeline/TimelineController';

afterEach(() => {
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
    const anim = new AnimationEngine();
    const OFFSET = 1; // e.g. a clip starting at 1s
    anim.setKeyframe('n', 'x', 1 - OFFSET, -400); // naive: bar-local
    anim.setKeyframe('n', 'x', 5, 0);             // canonical: keyframe axis
    // The keyframes exist, but they are on two different axes: sampling the
    // comp's 1s gives the interpolated middle, not the -400 the user set.
    expect(anim.sample('n', 'x', 1)).not.toBeCloseTo(-400);
  });
});
