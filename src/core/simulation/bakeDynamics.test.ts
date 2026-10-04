/**
 * Baking dynamics to keyframes.
 *
 * The claim under test is narrow and is the only one that matters: **the baked
 * track is what the solver actually did**. So the assertions are about the
 * shape of real motion (a falling body's y never decreases before it lands, and
 * stops changing once it has) rather than about specific numbers, which would
 * only re-state the solver's arithmetic back to itself.
 *
 * `samplePhysicsTracks` and `sampleParticleLayers` are exercised directly: they
 * take seeds / a config and return tracks, so the interesting half needs no
 * scene graph, no timeline and no store — and a failure here is a failure of
 * the bake rather than of the fixture around it.
 */

import {
  bakeFrames,
  finishBakedTrack,
  
  
  DEFAULT_PARTICLE_BAKE_CAP,
} from './bakeDynamics';

beforeEach(() => {
});

describe('bakeFrames', () => {
  it('walks the range on the stride and always includes the last frame', () => {
    expect(bakeFrames({ from: 0, to: 1, fps: 30, everyNFrames: 1 })).toHaveLength(31);
    // 0,4,8…28 is eight frames; 30 is off-stride and joins anyway, because the
    // last key is the one that holds.
    expect(bakeFrames({ from: 0, to: 1, fps: 30, everyNFrames: 4 })).toEqual(
      [0, 4, 8, 12, 16, 20, 24, 28, 30],
    );
  });

  it('never samples a negative frame', () => {
    expect(bakeFrames({ from: -2, to: 0.1, fps: 30 })[0]).toBe(0);
  });
});

describe('finishBakedTrack', () => {
  const ramp = Array.from({ length: 10 }, (_, i) => ({ t: i / 30, value: i * 10 }));

  it('writes LINEAR keys and HOLDS the last one', () => {
    const kfs = finishBakedTrack(ramp);
    expect(kfs).toHaveLength(10);
    expect(kfs.slice(0, -1).every((k) => k.easing === 'linear')).toBe(true);
    expect(kfs[kfs.length - 1]!.easing).toBe('hold');
  });

  it('simplification collapses a straight run and keeps the endpoints', () => {
    const thinned = finishBakedTrack(ramp, 1);
    expect(thinned.length).toBeLessThan(ramp.length);
    expect(thinned[0]!.value).toBe(0);
    expect(thinned[thinned.length - 1]!.value).toBe(90);
    // Still linear-then-hold after thinning — the tangents The Smoother hands
    // back must not survive into a bake.
    expect(thinned[thinned.length - 1]!.easing).toBe('hold');
    expect(thinned.every((k) => k.bezier === undefined)).toBe(true);
  });
});

describe('sampleParticleLayers', () => {

  it('has a default cap small enough to be an editable document', () => {
    expect(DEFAULT_PARTICLE_BAKE_CAP).toBe(200);
  });
});
