import { AnimationEngine } from '@motion/animation';

/** Fresh engine per test — the module helpers accept an explicit engine. */
function engine(): AnimationEngine {
  return new AnimationEngine();
}

describe('AnimationEngine track capture/restore', () => {
  test('getTrackKeyframes returns null for an absent track and a deep copy otherwise', () => {
    const a = engine();
    expect(a.getTrackKeyframes('n', 'x')).toBeNull();
    a.setKeyframe('n', 'x', 0, 10);
    const kfs = a.getTrackKeyframes('n', 'x');
    expect(kfs).toEqual([{ t: 0, value: 10, easing: undefined }]);
    // Mutating the returned copy must not affect the engine.
    kfs![0]!.value = 999;
    expect(a.sample('n', 'x', 0)).toBe(10);
  });

  test('setTrackKeyframes(null) removes the track and prunes the node', () => {
    const a = engine();
    a.setKeyframe('n', 'x', 0, 10);
    a.setTrackKeyframes('n', 'x', null);
    expect(a.isAnimated('n', 'x')).toBe(false);
    expect(a.hasAnimation('n')).toBe(false);
  });
});
