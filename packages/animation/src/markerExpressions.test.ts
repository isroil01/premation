/**
 * `marker.*` — comp and layer markers in expressions.
 *
 * ## What the medium can and cannot see (rule 5·0)
 *
 * The observable is "what number does an expression get back", produced by the
 * scope objects in `expressions.ts`. `compileExpression(src).run(ctx)` samples
 * exactly that layer, so a unit test is the right medium here.
 *
 * What it CANNOT see is the host binding in `Providers.tsx` — that markers
 * reach the engine at all, and that `label` lands on `name`. A green file here
 * is consistent with `setMarkerProvider` never being called. That half is
 * covered by `AnimationEngine.marker.test.ts` (engine → context) and by the
 * runtime check (host → engine); this file deliberately claims neither.
 *
 * ## What the fixture values were chosen to make REACHABLE (rule 3a)
 *
 * Four things a tidier fixture would have hidden:
 *
 *  * markers are supplied OUT OF ORDER, so `key(n)`'s sort is exercised. A
 *    pre-sorted fixture cannot tell sorting from insertion order.
 *  * comp and layer markers have DIFFERENT times AND different counts, so a
 *    scope swap fails. Give both scopes the same list and every assertion here
 *    passes with `marker` and `thisComp.marker` transposed — rule 2a, since
 *    "which scope" is invisible to any assertion the two scopes agree on.
 *  * one marker's NAME equals another's COMMENT, which is the only way to pin
 *    the lookup precedence. With disjoint names and comments, comment-first
 *    and name-first are indistinguishable.
 *  * the empty list, which is the boundary the clean fixture cannot reach:
 *    every accessor must return zeros rather than throwing, because a comp
 *    with no markers is the state every project starts in.
 */

import { compileExpression, type ExprContext, type ExprMarkerData } from './expressions';

/**
 * Deliberately unsorted, and deliberately not the comp list.
 *
 * Sorted by time this is: 0.5 (index 1), 2.0 (index 2), 4.0 (index 3).
 */
const LAYER_MARKERS: ExprMarkerData[] = [
  { time: 2.0, duration: 0, name: 'Intro', comment: 'beat' },
  { time: 0.5, duration: 1.5, name: 'beat', comment: 'chorus' },
  { time: 4.0, duration: 0, name: 'Outro', comment: '' },
];

/** Two, not three, and at times the layer list does not contain. */
const COMP_MARKERS: ExprMarkerData[] = [
  { time: 3.0, duration: 0.25, name: 'End', comment: 'tail' },
  { time: 1.0, duration: 0, name: 'Start', comment: 'head' },
];

function ctx(over: Partial<ExprContext> = {}): ExprContext {
  return {
    time: 0,
    value: 0,
    markersAt: (scope) => (scope === 'comp' ? COMP_MARKERS : LAYER_MARKERS),
    ...over,
  };
}

/** Evaluate and return the number, failing loudly on an expression error. */
function evalNum(src: string, over: Partial<ExprContext> = {}): number {
  const e = compileExpression(src);
  expect(e.compileError).toBeNull();
  const r = e.run(ctx(over));
  expect(r.error).toBeNull();
  return r.value as number;
}

describe('marker.* — scope', () => {
  /**
   * The directional assertion of the file. Bare `marker` is the LAYER's
   * markers and `thisComp.marker` is the composition's, which is AE's rule and
   * the reverse of the natural guess. Different counts is what makes a
   * transposition fail here rather than pass quietly.
   */
  it('bare marker is the LAYER; thisComp.marker is the COMP', () => {
    expect(evalNum('marker.numKeys')).toBe(3);
    expect(evalNum('thisComp.marker.numKeys')).toBe(2);
  });

  it('thisLayer.marker is the same list as bare marker', () => {
    expect(evalNum('thisLayer.marker.numKeys')).toBe(3);
    expect(evalNum('thisLayer.marker.key(1).time')).toBeCloseTo(0.5, 10);
  });

  /** Times differ too, so the scopes are separable by more than length. */
  it('reads each scope’s own times', () => {
    expect(evalNum('marker.key(1).time')).toBeCloseTo(0.5, 10);
    expect(evalNum('thisComp.marker.key(1).time')).toBeCloseTo(1.0, 10);
  });
});

describe('marker.key(n)', () => {
  /**
   * Ordering is BY TIME, not by the order the host handed them over. The
   * fixture's first element is t=2.0; if `key(1)` returned it, sorting is not
   * happening.
   */
  it('numbers markers 1-based in TIME order, not provider order', () => {
    expect(evalNum('marker.key(1).time')).toBeCloseTo(0.5, 10);
    expect(evalNum('marker.key(2).time')).toBeCloseTo(2.0, 10);
    expect(evalNum('marker.key(3).time')).toBeCloseTo(4.0, 10);
  });

  it('reports index by sorted position', () => {
    expect(evalNum('marker.key(1).index')).toBe(1);
    expect(evalNum('marker.key(3).index')).toBe(3);
  });

  /** Clamps rather than throwing, matching the keyframe `key(n)` above it. */
  it('clamps out of range at both ends', () => {
    expect(evalNum('marker.key(0).time')).toBeCloseTo(0.5, 10);
    expect(evalNum('marker.key(-5).time')).toBeCloseTo(0.5, 10);
    expect(evalNum('marker.key(99).time')).toBeCloseTo(4.0, 10);
  });

  it('rounds a fractional index', () => {
    expect(evalNum('marker.key(1.6).time')).toBeCloseTo(2.0, 10);
  });

  it('carries duration through', () => {
    expect(evalNum('marker.key(1).duration')).toBeCloseTo(1.5, 10);
    expect(evalNum('marker.key(2).duration')).toBe(0);
  });

  /**
   * COMMENT wins over NAME. 'beat' is the comment of the t=2.0 marker and the
   * name of the t=0.5 one, so the two precedences give different answers —
   * which is the whole point of overlapping them.
   */
  it('looks up by string, matching comment before name', () => {
    expect(evalNum('marker.key("beat").time')).toBeCloseTo(2.0, 10);
    expect(evalNum('marker.key("beat").index')).toBe(2);
  });

  /** Name still works when no comment matches, or the string form is useless
   *  on markers this app creates — its commands fill the label, not the note. */
  it('falls back to name when no comment matches', () => {
    expect(evalNum('marker.key("Outro").time')).toBeCloseTo(4.0, 10);
  });

  it('returns the zero marker for an unknown string', () => {
    expect(evalNum('marker.key("nope").time')).toBe(0);
    expect(evalNum('marker.key("nope").index')).toBe(0);
  });
});

describe('marker.nearestKey(t)', () => {
  it('picks the closest marker', () => {
    expect(evalNum('marker.nearestKey(1.9).time')).toBeCloseTo(2.0, 10);
    expect(evalNum('marker.nearestKey(0).time')).toBeCloseTo(0.5, 10);
    expect(evalNum('marker.nearestKey(100).time')).toBeCloseTo(4.0, 10);
  });

  /**
   * The exact tie, which no other fixture can reach: 1.25 is equidistant from
   * 0.5 and 2.0. The comparison is strict `<`, so the EARLIER marker wins.
   * Asserted because relaxing it to `<=` silently flips the answer and every
   * other test here stays green.
   */
  it('breaks an exact tie toward the earlier marker', () => {
    expect(evalNum('marker.nearestKey(1.25).time')).toBeCloseTo(0.5, 10);
    expect(evalNum('marker.nearestKey(1.25).index')).toBe(1);
  });

  /** Defaults to the current `time`, as AE's does. */
  it('defaults its argument to the evaluation time', () => {
    expect(evalNum('marker.nearestKey().time', { time: 3.9 })).toBeCloseTo(4.0, 10);
    expect(evalNum('marker.nearestKey().time', { time: 0.4 })).toBeCloseTo(0.5, 10);
  });
});

describe('marker.* — the empty boundary', () => {
  const none: Partial<ExprContext> = { markersAt: () => [] };

  /**
   * Zeros, not a throw. `marker.nearestKey(time).time` on a marker-less comp
   * is what every half-written expression looks like, and taking the property
   * down there would be worse than answering "the start".
   */
  it('reports no markers without throwing', () => {
    expect(evalNum('marker.numKeys', none)).toBe(0);
    expect(evalNum('marker.nearestKey(5).time', none)).toBe(0);
    expect(evalNum('marker.key(1).time', none)).toBe(0);
    expect(evalNum('marker.key(1).index', none)).toBe(0);
    expect(evalNum('marker.key("x").duration', none)).toBe(0);
  });

  /** No provider at all is the same state as an empty one. */
  it('treats a missing provider as no markers', () => {
    expect(evalNum('marker.numKeys', { markersAt: undefined })).toBe(0);
    expect(evalNum('thisComp.marker.numKeys', { markersAt: undefined })).toBe(0);
  });

  /** One marker: nearestKey must return it from anywhere on the timeline. */
  it('handles a single marker', () => {
    const one: Partial<ExprContext> = {
      markersAt: () => [{ time: 7, duration: 0, name: 'Only', comment: '' }],
    };
    expect(evalNum('marker.numKeys', one)).toBe(1);
    expect(evalNum('marker.nearestKey(-100).time', one)).toBe(7);
    expect(evalNum('marker.nearestKey(100).time', one)).toBe(7);
    expect(evalNum('marker.key(4).time', one)).toBe(7);
  });
});

describe('marker.* — laziness', () => {
  /**
   * The provider must not be consulted by an expression that never mentions
   * markers. `run` is called per property per frame, so an eager build would
   * charge every expression in the project for this feature.
   *
   * This is a performance CONTRACT, asserted rather than commented, because
   * the eager version passes every other test in this file.
   */
  it('does not call the provider unless marker is used', () => {
    const markersAt = jest.fn(() => LAYER_MARKERS);
    compileExpression('time * 2').run(ctx({ markersAt }));
    expect(markersAt).not.toHaveBeenCalled();

    compileExpression('marker.numKeys').run(ctx({ markersAt }));
    expect(markersAt).toHaveBeenCalled();
  });

  /** And it builds the list once per evaluation, not once per access. */
  it('builds one list per evaluation', () => {
    const markersAt = jest.fn(() => LAYER_MARKERS);
    compileExpression('marker.numKeys + marker.key(1).time + marker.nearestKey(0).time')
      .run(ctx({ markersAt }));
    expect(markersAt).toHaveBeenCalledTimes(1);
  });
});
