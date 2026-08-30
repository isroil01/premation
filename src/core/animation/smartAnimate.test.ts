/**
 * The tween planner: what actually gets written once the correspondence is
 * known.
 *
 * The interesting assertions are all about RESTRAINT — properties that did not
 * change must produce no track at all, and absent properties must not be
 * invented. A planner that writes everything works, and buries the three
 * things that move under ninety that do not, which defeats the point of
 * handing the result to the graph editor.
 */

import {
  planArrivalTracks,
  planDepartureTracks,
  planMatchedTracks,
  TWEENABLE_PROPS,
  type TweenOptions,
} from './smartAnimate';

const OPTS: TweenOptions = { startTime: 1, durationSec: 0.8 };

const propsOf = (tracks: ReturnType<typeof planMatchedTracks>): string[] =>
  tracks.map((t) => t.prop).sort();

describe('planMatchedTracks', () => {
  it('writes a track for a property that moved', () => {
    const tracks = planMatchedTracks({ x: 0 }, { x: 400 }, OPTS);
    expect(propsOf(tracks)).toEqual(['x']);
    expect(tracks[0]!.keys.map((k) => [k.t, k.value])).toEqual([[1, 0], [1.8, 400]]);
  });

  it('writes NOTHING for a property that did not move', () => {
    expect(planMatchedTracks({ x: 100, y: 50 }, { x: 100, y: 50 }, OPTS)).toEqual([]);
  });

  it('ignores differences below the noise floor', () => {
    // Floating-point drift in the twelfth decimal is the same position, and a
    // track for it is a flat line cluttering the graph editor.
    expect(planMatchedTracks({ x: 100 }, { x: 100.000000001 }, OPTS)).toEqual([]);
    expect(planMatchedTracks({ rotation: 45 }, { rotation: 45.001 }, OPTS)).toEqual([]);
  });

  it('still writes a difference that is small but real', () => {
    expect(propsOf(planMatchedTracks({ x: 100 }, { x: 101 }, OPTS))).toEqual(['x']);
  });

  it('does not invent a property that only one side carries', () => {
    // A layer with no explicit scaleY has not "scaled to zero" — it simply
    // does not carry the property, and defaulting would collapse the layer.
    expect(planMatchedTracks({ x: 0 }, { x: 0, scaleY: 2 }, OPTS)).toEqual([]);
    expect(planMatchedTracks({ scaleY: 2 }, {}, OPTS)).toEqual([]);
  });

  it('skips non-finite values rather than writing NaN keyframes', () => {
    expect(planMatchedTracks({ x: Number.NaN }, { x: 10 }, OPTS)).toEqual([]);
    expect(planMatchedTracks({ x: 0 }, { x: Number.POSITIVE_INFINITY }, OPTS)).toEqual([]);
  });

  it('covers the whole transform a person would expect to morph', () => {
    const from = { x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 100, scale: 1 };
    const to = { x: 5, y: 5, width: 20, height: 20, rotation: 90, opacity: 50, scale: 2 };
    expect(propsOf(planMatchedTracks(from, to, OPTS)))
      .toEqual(['height', 'opacity', 'rotation', 'scale', 'width', 'x', 'y']);
  });

  it('eases the movement rather than running it linear', () => {
    const tracks = planMatchedTracks({ x: 0 }, { x: 100 }, OPTS);
    expect(tracks[0]!.keys[0]!.bezier).toBeDefined();
    // The last key ends a segment, so it carries no outgoing easing.
    expect(tracks[0]!.keys[1]!.bezier).toBeUndefined();
  });

  it('honours an explicit curve', () => {
    const curve: [number, number, number, number] = [0.1, 0.2, 0.3, 0.4];
    const tracks = planMatchedTracks({ x: 0 }, { x: 1 }, { ...OPTS, curve });
    expect(tracks[0]!.keys[0]!.bezier).toEqual(curve);
  });

  it('exposes every property it can write', () => {
    expect(TWEENABLE_PROPS).toContain('x');
    expect(TWEENABLE_PROPS).toContain('opacity');
    expect(TWEENABLE_PROPS).toContain('rotation');
  });
});

describe('planDepartureTracks', () => {
  it('holds at full opacity, then fades out before the move finishes', () => {
    const tracks = planDepartureTracks(100, OPTS);
    const keys = tracks[0]!.keys;
    expect(keys[0]).toMatchObject({ t: 1, value: 100 });
    expect(keys[1]!.value).toBe(0);
    // Gone before the layout settles — a departure that fades over the whole
    // transition reads as a dissolve rather than as an exit.
    expect(keys[1]!.t).toBeLessThan(OPTS.startTime + OPTS.durationSec);
  });

  it('starts from the layer’s own opacity, not a fixed 100', () => {
    expect(planDepartureTracks(40, OPTS)[0]!.keys[0]!.value).toBe(40);
  });

  it('assumes full opacity when the layer does not carry one', () => {
    expect(planDepartureTracks(undefined, OPTS)[0]!.keys[0]!.value).toBe(100);
  });

  it('writes nothing for a layer that is already invisible', () => {
    expect(planDepartureTracks(0, OPTS)).toEqual([]);
  });
});

describe('planArrivalTracks', () => {
  it('stays invisible, then fades in late', () => {
    const keys = planArrivalTracks(100, OPTS)[0]!.keys;
    expect(keys[0]!.value).toBe(0);
    expect(keys[1]).toMatchObject({ t: 1.8, value: 100 });
    // An arrival that appears immediately competes with the movement for
    // attention; it must start after the transition is under way.
    expect(keys[0]!.t).toBeGreaterThan(OPTS.startTime);
  });

  it('arrives at the layer’s own opacity', () => {
    expect(planArrivalTracks(60, OPTS)[0]!.keys[1]!.value).toBe(60);
  });

  it('writes nothing for a layer that is invisible in the target too', () => {
    expect(planArrivalTracks(0, OPTS)).toEqual([]);
  });

  it('arrives after a departure has gone, so they do not cross-dissolve', () => {
    const leaves = planDepartureTracks(100, OPTS)[0]!.keys;
    const arrives = planArrivalTracks(100, OPTS)[0]!.keys;
    expect(arrives[0]!.t).toBeGreaterThanOrEqual(leaves[leaves.length - 1]!.t - 1e-9);
  });
});
