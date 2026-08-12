/**
 * The one invariant: `stateAt(f)` does not depend on what was asked before it.
 *
 * Everything in `simulationCore.ts` exists to hold that, so these tests attack
 * it directly rather than checking the parts. The reference answer is always
 * "step naively from 0 with no cache at all", because that is the definition of
 * the state — the cache is an optimisation and is only ever allowed to agree
 * with it.
 *
 * The access orders below are chosen to be hostile, not representative. A cache
 * that keeps "the current state" and steps it forward passes any monotonic
 * test; it fails the first backward seek. Since monotonic playback is also the
 * common case, a test suite that mirrored real usage would miss precisely the
 * bug this design is built to avoid.
 */

import {
  SimulationCache,
  SimulationPreRollLimit,
  type Simulation,
} from './simulationCore';
import {
  createBounceSim,
  bounceDigest,
  DEFAULT_BOUNCE_CONFIG,
  type BounceState,
} from './bounceSim';

/** The definition of the state: no cache, no snapshots, just stepping. */
function naiveStateAt(sim: Simulation<BounceState>, frame: number): BounceState {
  let s = sim.init();
  for (let f = 1; f <= frame; f++) s = sim.step(s, f);
  return s;
}

const sim = (): Simulation<BounceState> => createBounceSim({ ...DEFAULT_BOUNCE_CONFIG, count: 24 });

describe('SimulationCache — the ordering invariant', () => {
  it('agrees with naive stepping at every frame it is asked for, in order', () => {
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 10 });
    for (const f of [0, 1, 7, 10, 33, 100]) {
      expect([f, bounceDigest(cache.stateAt(f))]).toEqual([f, bounceDigest(naiveStateAt(s, f))]);
    }
  });

  it('gives the same answer after a BACKWARD seek', () => {
    // The failure this suite exists for. A "keep the current state and step
    // forward" cache is correct up to here and wrong on the next line.
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 10 });
    cache.stateAt(200);
    expect(bounceDigest(cache.stateAt(10))).toBe(bounceDigest(naiveStateAt(s, 10)));
    expect(bounceDigest(cache.stateAt(3))).toBe(bounceDigest(naiveStateAt(s, 3)));
  });

  it('is unchanged by a deliberately chaotic access order', () => {
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 7 });
    const order = [97, 4, 60, 1, 60, 120, 0, 33, 121, 5, 97, 200, 61];
    for (const f of order) {
      expect([f, bounceDigest(cache.stateAt(f))]).toEqual([f, bounceDigest(naiveStateAt(s, f))]);
    }
  });

  it('two caches with different histories agree frame for frame', () => {
    // Preview and export are two caches over one simulation, driven very
    // differently: one scrubs, one walks forward. MOTION_FORMAT_FREEZE.md makes
    // them disagreeing a disqualifying bug, so it is asserted between caches
    // and not only against the naive reference.
    const s = sim();
    const scrubbed = new SimulationCache(s, { snapshotInterval: 10 });
    const played = new SimulationCache(s, { snapshotInterval: 25 });
    for (const f of [140, 12, 99, 3]) scrubbed.stateAt(f);
    for (let f = 0; f <= 140; f++) played.stateAt(f);
    for (const f of [0, 3, 12, 99, 140]) {
      expect([f, bounceDigest(scrubbed.stateAt(f))]).toEqual([f, bounceDigest(played.stateAt(f))]);
    }
  });

  it('survives eviction — a state reachable only by re-stepping is still right', () => {
    // maxSnapshots is small enough that the middle of the timeline is
    // guaranteed to have been thrown away by the time it is asked for again.
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 5, maxSnapshots: 3 });
    for (let f = 0; f <= 300; f += 5) cache.stateAt(f);
    expect(bounceDigest(cache.stateAt(40))).toBe(bounceDigest(naiveStateAt(s, 40)));
    expect(cache.getStats().snapshots).toBeLessThanOrEqual(4); // 3 + pinned frame 0
  });
});

describe('SimulationCache — ownership and mutation', () => {
  it('never hands out a state it also keeps', () => {
    // A caller that mutates the returned state must not be able to corrupt a
    // snapshot. Frame 0 is the sharpest case: it is pinned forever, so if
    // stateAt(0) returned the stored object, one careless caller would poison
    // every later answer for the lifetime of the cache.
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 10 });
    const before = bounceDigest(cache.stateAt(0));
    const handed = cache.stateAt(0);
    handed.x[0] = 99999;
    handed.vy[0] = -99999;
    expect(bounceDigest(cache.stateAt(0))).toBe(before);
    expect(bounceDigest(cache.stateAt(30))).toBe(bounceDigest(naiveStateAt(s, 30)));
  });

  it('clone() copies typed-array buffers rather than sharing them', () => {
    // `{...state}` would pass every value test above and still share every
    // buffer, so snapshots would silently track the live state. Asserted on the
    // sim directly because the cache's correctness rests on it entirely.
    const s = sim();
    const a = s.init();
    const b = s.clone(a);
    a.x[0] = 12345;
    expect(b.x[0]).not.toBe(12345);
  });
});

describe('SimulationCache — seeking and bounds', () => {
  it('treats frames before the start as frame 0, not as an error', () => {
    // A layer whose in-point is after the playhead asks for negative frames
    // during ordinary scrubbing.
    const s = sim();
    const cache = new SimulationCache(s, {});
    const zero = bounceDigest(naiveStateAt(s, 0));
    expect(bounceDigest(cache.stateAt(-1))).toBe(zero);
    expect(bounceDigest(cache.stateAt(-10_000))).toBe(zero);
  });

  it('refuses a seek that would pre-roll past the limit', () => {
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 1000, maxPreRoll: 50 });
    expect(() => cache.stateAt(10_000)).toThrow(SimulationPreRollLimit);
  });

  it('pins frame 0 so pre-roll never has to restart', () => {
    // The scoping note asked "how far may a seek pre-roll before restarting is
    // cheaper". The answer is never, and it holds only because frame 0 cannot
    // be evicted — otherwise a seek could land with nothing behind it.
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 2, maxSnapshots: 2 });
    for (let f = 0; f <= 100; f += 2) cache.stateAt(f);
    // Everything mid-timeline is long evicted; frame 0 must still answer.
    expect(bounceDigest(cache.stateAt(0))).toBe(bounceDigest(naiveStateAt(s, 0)));
  });

  it('reset() re-seeds, because a config change is a different history', () => {
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 10 });
    cache.stateAt(100);
    cache.reset();
    expect(cache.getStats().stepped).toBe(0);
    expect(bounceDigest(cache.stateAt(50))).toBe(bounceDigest(naiveStateAt(s, 50)));
  });
});

describe('SimulationCache — the cost it is hiding', () => {
  it('snapshots on the way past, so a re-seek into that region is cheap', () => {
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 10 });
    cache.stateAt(100);
    const after = cache.getStats().stepped;
    cache.stateAt(70); // lands on a snapshot laid down during the seek above
    expect(cache.getStats().stepped).toBe(after);
    expect(cache.getStats().hits).toBeGreaterThan(0);
  });

  it('bounds pre-roll by the snapshot interval, not by the seek distance', () => {
    // The property that makes scrubbing usable: seeking to frame 5000 costs the
    // same as seeking to frame 50 once the region has been visited.
    const s = sim();
    const cache = new SimulationCache(s, { snapshotInterval: 10, maxSnapshots: 1000 });
    for (let f = 0; f <= 5000; f += 10) cache.stateAt(f);
    const before = cache.getStats().stepped;
    cache.stateAt(4997);
    expect(cache.getStats().stepped - before).toBeLessThanOrEqual(10);
  });
});

describe('bounceSim is genuinely history-dependent', () => {
  it('collides — so no closed form could answer stateAt', () => {
    // If nothing ever hit a wall this would be ballistic and the whole
    // subsystem would be unnecessary, so the premise is asserted rather than
    // assumed. A particle whose vertical velocity REVERSES sign has bounced.
    const s = sim();
    let bounced = false;
    let prev = s.init();
    for (let f = 1; f <= 200 && !bounced; f++) {
      const before = prev.vy.slice();
      prev = s.step(prev, f);
      for (let i = 0; i < before.length; i++) {
        if (before[i]! > 0 && prev.vy[i]! < 0) { bounced = true; break; }
      }
    }
    expect(bounced).toBe(true);
  });

  it('is seeded, not random — same config, same history', () => {
    const a = createBounceSim({ ...DEFAULT_BOUNCE_CONFIG, count: 16, seed: 7 });
    const b = createBounceSim({ ...DEFAULT_BOUNCE_CONFIG, count: 16, seed: 7 });
    const c = createBounceSim({ ...DEFAULT_BOUNCE_CONFIG, count: 16, seed: 8 });
    expect(bounceDigest(naiveStateAt(a, 60))).toBe(bounceDigest(naiveStateAt(b, 60)));
    expect(bounceDigest(naiveStateAt(c, 60))).not.toBe(bounceDigest(naiveStateAt(a, 60)));
  });

  it('keeps particles inside the box, including after an overshoot', () => {
    // Reflecting without clamping leaves a fast particle outside the wall,
    // where it reflects again every frame and buzzes. Driven hard enough to
    // overshoot: high gravity, full restitution.
    const s = createBounceSim({
      ...DEFAULT_BOUNCE_CONFIG, count: 32, gravity: 40, restitution: 1, damping: 1,
    });
    const st = naiveStateAt(s, 300);
    const r = DEFAULT_BOUNCE_CONFIG.radius;
    for (let i = 0; i < st.x.length; i++) {
      expect(st.x[i]!).toBeGreaterThanOrEqual(r - 1e-9);
      expect(st.x[i]!).toBeLessThanOrEqual(DEFAULT_BOUNCE_CONFIG.width - r + 1e-9);
      expect(st.y[i]!).toBeGreaterThanOrEqual(r - 1e-9);
      expect(st.y[i]!).toBeLessThanOrEqual(DEFAULT_BOUNCE_CONFIG.height - r + 1e-9);
    }
  });
});
