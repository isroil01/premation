/**
 * "Convert audio to keyframes" must not freeze the app.
 *
 * The original write loop called `setKeyframe` once per keyframe. That method
 * re-sorts the whole track AND fires a synchronous app-wide change notification
 * per call (scene bump → hit-test rebuild → autosave), so a few thousand
 * keyframes meant a few thousand full notifications on the main thread and a
 * wedged UI. These lock in the two properties that fix it: ONE notification for
 * the whole track however big it is, and keyframe times that follow the layer's
 * clip bar instead of being pinned to comp time 0.
 */

import { defaultAnimation } from '@motion/animation';

let clipTimings: Array<{ id: string; enabled: boolean; startSec: number; inSec: number; outSec: number }> = [];

jest.mock('@core/timeline/TimelineController', () => ({
  getTimelineController: () => ({ fps: 30 }),
  // Identity axis: this test is about WHICH comp times get keyframes, and the
  // comp→keyframe conversion has its own tests.
  compToKeyframeTime: (_nodeId: string, compTime: number) => compTime,
}));
jest.mock('./audioScene', () => ({ readAudioClipTimings: () => clipTimings }));
jest.mock('@core/animation/animationCommands', () => ({
  runAnimEdit: (_label: string, mutate: () => void) => mutate(),
}));

import { applyAudioKeyframes, DEFAULT_AUDIO_KEYFRAME_OPTIONS } from './audioKeyframes';

/** A one-channel buffer whose loudness ramps, so no two frames are equal. */
function rampBuffer(seconds: number, sampleRate = 3000): AudioBuffer {
  const length = Math.floor(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    // A tone whose amplitude wanders — every frame differs from the last, so
    // thinning can't quietly collapse the track and hide a slow write.
    data[i] = Math.sin(i * 0.7) * (0.2 + 0.8 * Math.abs(Math.sin(i / 900)));
  }
  return {
    duration: length / sampleRate,
    length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

const opts = (over = {}) => ({ ...DEFAULT_AUDIO_KEYFRAME_OPTIONS, minDelta: 0, smoothing: 1, ...over });

beforeEach(() => {
  clipTimings = [];
  defaultAnimation.removeTrack('n1', 'audioAmplitude');
  defaultAnimation.setChangeListener(() => {});
});

describe('applyAudioKeyframes', () => {
  it('notifies ONCE for the whole track, not once per keyframe', () => {
    const notify = jest.fn();
    defaultAnimation.setChangeListener(notify);

    const written = applyAudioKeyframes('n1', rampBuffer(20), opts());

    expect(written).toBeGreaterThan(300); // a genuinely bulky track
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('writes a sorted, de-duplicated track', () => {
    applyAudioKeyframes('n1', rampBuffer(4), opts());
    const track = defaultAnimation.tracksFor('n1').find((t) => t.prop === 'audioAmplitude');
    const times = track!.keyframes.map((k) => k.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });

  it('offsets keyframes to where the clip BAR sits', () => {
    // Bar starts at comp 5s and plays the file from 0s — every keyframe shifts
    // by 5s. Pinning them to 0 was the old behaviour.
    clipTimings = [{ id: 'c1', enabled: true, startSec: 5, inSec: 0, outSec: 2 }];
    applyAudioKeyframes('n1', rampBuffer(2), opts());

    const track = defaultAnimation.tracksFor('n1').find((t) => t.prop === 'audioAmplitude');
    const times = track!.keyframes.map((k) => k.t);
    expect(Math.min(...times)).toBeCloseTo(5, 3);
    expect(Math.max(...times)).toBeLessThanOrEqual(7.001);
  });

  it('drops the parts of the file the bar trims away', () => {
    // Only source 1s–2s is on the timeline; the other 3 seconds are cut.
    clipTimings = [{ id: 'c1', enabled: true, startSec: 0, inSec: 1, outSec: 2 }];
    applyAudioKeyframes('n1', rampBuffer(4), opts());

    const track = defaultAnimation.tracksFor('n1').find((t) => t.prop === 'audioAmplitude');
    const times = track!.keyframes.map((k) => k.t);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(-0.001);
    expect(Math.max(...times)).toBeLessThanOrEqual(1.001);
  });

  it('writes nothing (and no track) for silence-free empty input', () => {
    const empty = { duration: 0, length: 0, sampleRate: 3000, numberOfChannels: 1, getChannelData: () => new Float32Array(0) } as unknown as AudioBuffer;
    expect(applyAudioKeyframes('n1', empty, opts())).toBe(0);
  });
});
