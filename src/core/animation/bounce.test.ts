/**
 * The bounce generator's geometry.
 *
 * Pure-function tests, because the thing that makes a bounce read as gravity
 * rather than as a wobble is arithmetic — overshoot and duration decaying
 * TOGETHER — and that is invisible in a screenshot and tedious to judge by eye.
 *
 * The from-zero and squash cases are here for the same reason: "the layer
 * arrives at its resting position" and "it squashes at the moment it lands, not
 * before or after" are properties of the numbers, and both were wrong in ways
 * that would have looked merely odd on screen.
 */

import {
  BOUNCE_STYLES,
  DEFAULT_BOUNCE,
  DEFAULT_DROP_IN,
  DEFAULT_SQUASH,
  bounceImpacts,
  bounceInTracks,
  bounceRebounds,
  bounceTracks,
  describeBounce,
  dropOffset,
  matchBounceStyle,
  squashTracks,
  type BounceOptions,
} from './bounce';
import type { PresetTrack } from './animationPresets';

/** A fall: y goes 0 → 100 over half a second. */
const fall = (): PresetTrack => ({
  prop: 'y' as PresetTrack['prop'],
  keyframes: [{ t: 0, value: 0 }, { t: 0.5, value: 100 }],
});

describe('bounceTracks', () => {
  it('adds two keyframes per bounce — a peak and a return', () => {
    const [t] = bounceTracks([fall()], { bounces: 3, decay: 0.5, elasticity: 0.35 });
    expect(t!.keyframes).toHaveLength(2 + 3 * 2);
  });

  it('overshoots AGAINST the direction of travel', () => {
    // Land after a fall and you rebound upward. Overshooting the same way the
    // layer was already moving is the sign error this pins.
    const [t] = bounceTracks([fall()], DEFAULT_BOUNCE);
    const firstPeak = t!.keyframes[2]!;
    expect(firstPeak.value).toBeLessThan(100);
  });

  it('returns to the landing value after every bounce', () => {
    const [t] = bounceTracks([fall()], { bounces: 3, decay: 0.5, elasticity: 0.35 });
    for (const i of [3, 5, 7]) expect(t!.keyframes[i]!.value).toBeCloseTo(100, 9);
  });

  it('decays the overshoot', () => {
    const [t] = bounceTracks([fall()], { bounces: 3, decay: 0.5, elasticity: 0.4 });
    const peaks = [2, 4, 6].map((i) => Math.abs(100 - t!.keyframes[i]!.value));
    expect(peaks[1]!).toBeLessThan(peaks[0]!);
    expect(peaks[2]!).toBeLessThan(peaks[1]!);
    expect(peaks[1]! / peaks[0]!).toBeCloseTo(0.5, 6);
  });

  it('decays the DURATION too, not just the height', () => {
    // The one that separates gravity from a wobble: shrinking the overshoot
    // while holding the timing gives an even, mechanical flutter.
    const [t] = bounceTracks([fall()], { bounces: 3, decay: 0.5, elasticity: 0.4 });
    const k = t!.keyframes;
    const first = k[3]!.t - k[1]!.t;
    const second = k[5]!.t - k[3]!.t;
    expect(second).toBeLessThan(first);
    expect(second / first).toBeCloseTo(0.5, 6);
  });

  it('advances monotonically in time', () => {
    const [t] = bounceTracks([fall()], DEFAULT_BOUNCE);
    for (let i = 1; i < t!.keyframes.length; i++) {
      expect(t!.keyframes[i]!.t).toBeGreaterThan(t!.keyframes[i - 1]!.t);
    }
  });

  it('leaves a track with nothing to bounce off alone', () => {
    const single: PresetTrack = { prop: 'y' as PresetTrack['prop'], keyframes: [{ t: 0, value: 0 }] };
    const hold: PresetTrack = {
      prop: 'y' as PresetTrack['prop'],
      keyframes: [{ t: 0, value: 5 }, { t: 1, value: 5 }],
    };
    expect(bounceTracks([single], DEFAULT_BOUNCE)[0]!.keyframes).toHaveLength(1);
    expect(bounceTracks([hold], DEFAULT_BOUNCE)[0]!.keyframes).toHaveLength(2);
  });

  it('zero bounces or zero elasticity is a no-op', () => {
    expect(bounceTracks([fall()], { ...DEFAULT_BOUNCE, bounces: 0 })[0]!.keyframes).toHaveLength(2);
    expect(bounceTracks([fall()], { ...DEFAULT_BOUNCE, elasticity: 0 })[0]!.keyframes).toHaveLength(2);
  });

  it('bounces upward travel downward', () => {
    // Symmetry: a rise should rebound below its landing, not above it.
    const rise: PresetTrack = {
      prop: 'y' as PresetTrack['prop'],
      keyframes: [{ t: 0, value: 100 }, { t: 0.5, value: 0 }],
    };
    const [t] = bounceTracks([rise], DEFAULT_BOUNCE);
    expect(t!.keyframes[2]!.value).toBeGreaterThan(0);
  });

  it('does not mutate the input tracks', () => {
    const input = fall();
    bounceTracks([input], DEFAULT_BOUNCE);
    expect(input.keyframes).toHaveLength(2);
  });

  it('preserves a track\'s relative flag, so a generated fall stays an offset', () => {
    const rel: PresetTrack = { ...fall(), relative: true };
    expect(bounceTracks([rel], DEFAULT_BOUNCE)[0]!.relative).toBe(true);
  });
});

describe('oscillate — spring vs gravity', () => {
  const springy: BounceOptions = { bounces: 4, decay: 0.6, elasticity: 0.5, oscillate: true };

  it('alternates the side it overshoots on', () => {
    const rebounds = bounceRebounds({ t: 0, value: 0 }, { t: 0.5, value: 100 }, springy);
    const sides = rebounds.map((r) => Math.sign(r.peakValue - 100));
    expect(sides).toEqual([-1, 1, -1, 1]);
  });

  it('gravity never crosses to the other side', () => {
    const rebounds = bounceRebounds({ t: 0, value: 0 }, { t: 0.5, value: 100 }, { ...springy, oscillate: false });
    expect(rebounds.every((r) => r.peakValue < 100)).toBe(true);
  });

  it('decays the same either way — only the sign differs', () => {
    const a = bounceRebounds({ t: 0, value: 0 }, { t: 0.5, value: 100 }, springy);
    const b = bounceRebounds({ t: 0, value: 0 }, { t: 0.5, value: 100 }, { ...springy, oscillate: false });
    expect(a.map((r) => r.amp)).toEqual(b.map((r) => r.amp));
    expect(a.map((r) => r.landT)).toEqual(b.map((r) => r.landT));
  });
});

describe('styles', () => {
  it('every style round-trips through matchBounceStyle', () => {
    for (const s of BOUNCE_STYLES) expect(matchBounceStyle(s.options)).toBe(s.id);
  });

  it('editing a parameter drops the style match', () => {
    // The panel lights a style chip only while the numbers still are that
    // style; a match that survived any edit would be a lie.
    expect(matchBounceStyle({ ...DEFAULT_BOUNCE, bounces: 7 })).toBeNull();
  });

  it('the four styles are four distinct shapes', () => {
    const shapes = BOUNCE_STYLES.map((s) => JSON.stringify(s.options));
    expect(new Set(shapes).size).toBe(BOUNCE_STYLES.length);
  });
});

describe('bounceInTracks — from zero', () => {
  it('starts off-position and lands ON the resting value', () => {
    // Relative track: 0 IS the layer's own position, so the last value being
    // anything else means the layer does not end up where it started.
    const [pos] = bounceInTracks(DEFAULT_DROP_IN, DEFAULT_BOUNCE);
    expect(pos!.relative).toBe(true);
    expect(pos!.keyframes[0]!.value).toBe(-DEFAULT_DROP_IN.distance);
    expect(pos!.keyframes[pos!.keyframes.length - 1]!.value).toBeCloseTo(0, 9);
  });

  it('needs no existing keyframes — this is the gap it closes', () => {
    const [pos] = bounceInTracks(DEFAULT_DROP_IN, DEFAULT_BOUNCE);
    expect(pos!.keyframes.length).toBe(2 + DEFAULT_BOUNCE.bounces * 2);
  });

  it('maps each direction onto the right axis and sign', () => {
    expect(dropOffset({ ...DEFAULT_DROP_IN, direction: 'top' })).toEqual({ axis: 'y', from: -320 });
    expect(dropOffset({ ...DEFAULT_DROP_IN, direction: 'bottom' })).toEqual({ axis: 'y', from: 320 });
    expect(dropOffset({ ...DEFAULT_DROP_IN, direction: 'left' })).toEqual({ axis: 'x', from: -320 });
    expect(dropOffset({ ...DEFAULT_DROP_IN, direction: 'right' })).toEqual({ axis: 'x', from: 320 });
  });

  it('a drop from the left writes x, not y', () => {
    const [pos] = bounceInTracks({ ...DEFAULT_DROP_IN, direction: 'left' }, DEFAULT_BOUNCE);
    expect(pos!.prop).toBe('x');
  });

  it('fades up before the landing, not through it', () => {
    const tracks = bounceInTracks({ ...DEFAULT_DROP_IN, fade: true }, DEFAULT_BOUNCE);
    const opacity = tracks.find((t) => t.prop === 'opacity');
    expect(opacity).toBeDefined();
    expect(opacity!.keyframes[0]!.value).toBe(0);
    expect(opacity!.keyframes[1]!.value).toBe(100);
    expect(opacity!.keyframes[1]!.t).toBeLessThan(DEFAULT_DROP_IN.duration);
  });

  it('writes no opacity track when fade is off', () => {
    expect(bounceInTracks(DEFAULT_DROP_IN, DEFAULT_BOUNCE).some((t) => t.prop === 'opacity')).toBe(false);
  });
});

describe('describeBounce', () => {
  it('names Position rather than the raw axis the keys landed on', () => {
    // The user never sees an `x`/`y` row — the timeline merges them into one
    // Position row — so reporting `y` describes something not on their screen.
    const msg = describeBounce({ mode: 'dropped', added: 8, props: ['y'], from: 0, to: 0.84 });
    expect(msg).toContain('Position');
    expect(msg).not.toMatch(/\by\b/);
  });

  it('states the count and the span, because nothing on screen does', () => {
    const msg = describeBounce({ mode: 'appended', added: 6, props: ['y'], from: 1, to: 1.9 });
    expect(msg).toContain('6 keyframes');
    expect(msg).toContain('1.00–1.90s');
  });

  it('says which of the two things happened', () => {
    const base = { added: 4, props: ['y'], from: 0, to: 1 };
    expect(describeBounce({ ...base, mode: 'dropped' })).toMatch(/Dropped in/);
    expect(describeBounce({ ...base, mode: 'appended' })).toMatch(/Bounce added/);
  });

  it('does not repeat Position when x and y both gained keys', () => {
    const msg = describeBounce({ mode: 'dropped', added: 8, props: ['x', 'y'], from: 0, to: 1 });
    expect(msg.match(/Position/g)).toHaveLength(1);
  });

  it('names the squash rows Scale, once, the way the timeline labels them', () => {
    // `scaleX`/`scaleY` are engine props; the row in front of the user reads
    // "Scale X" under a Scale group. Naming the raw prop makes them translate.
    const msg = describeBounce({ mode: 'dropped', added: 12, props: ['y', 'scaleX', 'scaleY'], from: 0, to: 1 });
    expect(msg).toContain('Position');
    expect(msg).toContain('Scale');
    expect(msg).not.toContain('scaleX');
    expect(msg.match(/Scale/g)).toHaveLength(1);
  });
});

describe('squash & stretch', () => {
  const impacts = bounceImpacts({ t: 0, value: -300 }, { t: 0.45, value: 0 }, DEFAULT_BOUNCE);
  const base = { scaleX: 1, scaleY: 1 };

  it('lands one impact per landing — the original plus one per rebound', () => {
    expect(impacts).toHaveLength(1 + DEFAULT_BOUNCE.bounces);
    expect(impacts[0]!.t).toBeCloseTo(0.45, 9);
    expect(impacts[0]!.strength).toBe(1);
  });

  it('weakens with each impact', () => {
    for (let i = 1; i < impacts.length; i++) {
      expect(impacts[i]!.strength).toBeLessThan(impacts[i - 1]!.strength);
    }
  });

  it('squashes ALONG the axis of travel and bulges across it', () => {
    const [sx, sy] = squashTracks(impacts, 'y', base, 0, DEFAULT_SQUASH);
    const atImpact = (t: PresetTrack): number =>
      t.keyframes.find((k) => Math.abs(k.t - 0.45) < 1e-9)!.value;
    // A layer dropping vertically goes flatter (Y down) and wider (X up).
    expect(atImpact(sy!)).toBeLessThan(1);
    expect(atImpact(sx!)).toBeGreaterThan(1);
  });

  it('swaps the axes for horizontal travel', () => {
    const [sx, sy] = squashTracks(impacts, 'x', base, 0, DEFAULT_SQUASH);
    const atImpact = (t: PresetTrack): number =>
      t.keyframes.find((k) => Math.abs(k.t - 0.45) < 1e-9)!.value;
    expect(atImpact(sx!)).toBeLessThan(1);
    expect(atImpact(sy!)).toBeGreaterThan(1);
  });

  it('preserves volume — one axis up by what the other goes down', () => {
    const [sx, sy] = squashTracks(impacts, 'y', base, 0, DEFAULT_SQUASH);
    const at = (t: PresetTrack, time: number): number =>
      t.keyframes.find((k) => Math.abs(k.t - time) < 1e-9)!.value;
    expect(at(sx!, 0.45) - 1).toBeCloseTo(1 - at(sy!, 0.45), 9);
  });

  it('recovers to the layer\'s own scale, not to 1', () => {
    // A layer already at 2× must come back to 2×; snapping it to 1 is the bug
    // a hardcoded base would produce and it would look like a resize.
    const [sx, sy] = squashTracks(impacts, 'y', { scaleX: 2, scaleY: 3 }, 0, DEFAULT_SQUASH);
    expect(sx!.keyframes[0]!.value).toBe(2);
    expect(sy!.keyframes[0]!.value).toBe(3);
    expect(sx!.keyframes[sx!.keyframes.length - 1]!.value).toBeCloseTo(2, 9);
    expect(sy!.keyframes[sy!.keyframes.length - 1]!.value).toBeCloseTo(3, 9);
  });

  it('opens with the layer at rest, so it is not deformed before it moves', () => {
    const [sx] = squashTracks(impacts, 'y', base, 0, DEFAULT_SQUASH);
    expect(sx!.keyframes[0]!.t).toBe(0);
    expect(sx!.keyframes[0]!.value).toBe(1);
  });

  it('keeps every scale keyframe strictly in time order', () => {
    // Later impacts are close together; an overlapping recovery would write a
    // key BEFORE the one it follows and the track would fight itself.
    for (const track of squashTracks(impacts, 'y', base, 0, { amount: 0.4, duration: 0.5 })) {
      for (let i = 1; i < track.keyframes.length; i++) {
        expect(track.keyframes[i]!.t).toBeGreaterThan(track.keyframes[i - 1]!.t);
      }
    }
  });

  it('writes scaleX and scaleY in lockstep', () => {
    const [sx, sy] = squashTracks(impacts, 'y', base, 0, DEFAULT_SQUASH);
    expect(sx!.keyframes.map((k) => k.t)).toEqual(sy!.keyframes.map((k) => k.t));
  });

  it('is nothing at all when switched off', () => {
    expect(bounceInTracks(DEFAULT_DROP_IN, DEFAULT_BOUNCE, null).some((t) => t.prop.startsWith('scale'))).toBe(false);
  });

  it('rides along with a drop-in when switched on', () => {
    const tracks = bounceInTracks(DEFAULT_DROP_IN, DEFAULT_BOUNCE, DEFAULT_SQUASH, { scaleX: 1, scaleY: 1 });
    expect(tracks.some((t) => t.prop === 'scaleX')).toBe(true);
    expect(tracks.some((t) => t.prop === 'scaleY')).toBe(true);
  });

  it('squashes at the landing, not during the fall', () => {
    const tracks = bounceInTracks(DEFAULT_DROP_IN, DEFAULT_BOUNCE, DEFAULT_SQUASH);
    const sy = tracks.find((t) => t.prop === 'scaleY')!;
    // The flattest moment must coincide with the first impact — the end of the
    // fall — rather than with any point along the way down.
    const flattest = sy.keyframes.reduce((a, b) => (b.value < a.value ? b : a));
    expect(flattest.t).toBeCloseTo(DEFAULT_DROP_IN.duration, 9);
  });
});
