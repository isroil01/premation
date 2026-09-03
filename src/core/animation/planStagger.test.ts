/**
 * `planStagger`, the pure half of the parametric stagger.
 *
 * It is worth testing on its own because it is the piece with no excuse: no
 * scene graph, no engine, no clock. Everything it decides is a function of the
 * layers and the params, and the three ways that quietly stops being true are
 * all pinned here — an order that depends on array identity rather than
 * position, a seed that does not actually determine the rhythm, and offsets
 * that come back as fractions of a frame.
 *
 * That last one is the failure this whole model exists to prevent. Keyframe
 * times snap to the frame grid, so a plan expressed in anything finer is a plan
 * the engine is free to round back into a metronome — which is exactly what
 * happened to the old `nonUniformStagger` and is documented at length on
 * `staggerOffsets`.
 */

import {
  DEFAULT_STAGGER_PARAMS,
  planStagger,
  STAGGER_ORDERS,
  type StaggerLayer,
  type StaggerOrder,
  type StaggerParams,
} from './choreography';

/**
 * Four layers whose position order disagrees with their selection order on
 * every axis — otherwise "left to right" and "selection order" would produce
 * the same answer and the test would pass without testing anything.
 */
const LAYERS: StaggerLayer[] = [
  { nodeId: 'a', name: 'A', x: 300, y: 100 },
  { nodeId: 'b', name: 'B', x: 100, y: 400 },
  { nodeId: 'c', name: 'C', x: 400, y: 200 },
  { nodeId: 'd', name: 'D', x: 200, y: 300 },
];

function params(patch: Partial<StaggerParams> = {}): StaggerParams {
  return { ...DEFAULT_STAGGER_PARAMS, ...patch };
}

/** Node ids in the order they arrive. */
function arrival(order: StaggerOrder, patch: Partial<StaggerParams> = {}): string[] {
  return planStagger(LAYERS, params({ order, ...patch }))
    .slice()
    .sort((p, q) => p.rank - q.rank)
    .map((p) => p.nodeId);
}

describe('planStagger order modes', () => {
  it('timeline arrives in the order the layers were handed over', () => {
    expect(arrival('timeline')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reverse arrives back to front', () => {
    expect(arrival('reverse')).toEqual(['d', 'c', 'b', 'a']);
  });

  it('byPositionX arrives left to right', () => {
    expect(arrival('byPositionX')).toEqual(['b', 'd', 'a', 'c']);
  });

  it('byPositionY arrives top to bottom', () => {
    expect(arrival('byPositionY')).toEqual(['a', 'c', 'd', 'b']);
  });

  it('byDistanceFromCenter arrives outward from the centre it is given', () => {
    // An explicit centre, so this asserts the measurement rather than the
    // centroid fallback. Distances from (250,250): d=70.7, a=158.1, c=158.1,
    // b=212.1 — a and c are genuinely equidistant, so the input order breaks
    // the tie and `a` (index 0) goes first.
    const order = planStagger(LAYERS, params({ order: 'byDistanceFromCenter', center: { x: 250, y: 250 } }))
      .slice()
      .sort((p, q) => p.rank - q.rank)
      .map((p) => p.nodeId);
    expect(order).toEqual(['d', 'a', 'c', 'b']);
  });

  it('byDistanceFromCenter falls back to the centroid of the layers', () => {
    // The centroid of these four IS (250,250), so dropping the explicit centre
    // must not change the answer. This is what keeps the function pure: it
    // never needs to be told about the composition to be useful.
    expect(arrival('byDistanceFromCenter')).toEqual(
      planStagger(LAYERS, params({ order: 'byDistanceFromCenter', center: { x: 250, y: 250 } }))
        .slice()
        .sort((p, q) => p.rank - q.rank)
        .map((p) => p.nodeId),
    );
  });

  it('random is a genuine shuffle, not the input order under another name', () => {
    // Across many seeds SOME must differ from selection order. One seed proves
    // nothing — a broken shuffle that returns the input would pass on the seed
    // where the shuffle happens to be the identity.
    const shuffled = Array.from({ length: 40 }, (_, i) => arrival('random', { seed: i + 1 }))
      .filter((got) => got.join() !== 'a,b,c,d');
    expect(shuffled.length).toBeGreaterThan(20);
  });

  it('every order is a permutation — nothing dropped, nothing duplicated', () => {
    for (const order of STAGGER_ORDERS) {
      const got = arrival(order);
      expect(got.slice().sort()).toEqual(['a', 'b', 'c', 'd']);
      // And every rank is used exactly once.
      const ranks = planStagger(LAYERS, params({ order })).map((p) => p.rank).sort();
      expect(ranks).toEqual([0, 1, 2, 3]);
    }
  });

  it('returns entries in INPUT order whatever the arrival order', () => {
    // The panel renders these against its own layer list, so a plan that came
    // back sorted would label every row with the wrong name.
    for (const order of STAGGER_ORDERS) {
      expect(planStagger(LAYERS, params({ order })).map((p) => p.nodeId))
        .toEqual(['a', 'b', 'c', 'd']);
    }
  });

  it('ties keep their input order rather than swapping between renders', () => {
    const stacked: StaggerLayer[] = [
      { nodeId: 'p', x: 10, y: 10 },
      { nodeId: 'q', x: 10, y: 10 },
      { nodeId: 'r', x: 10, y: 10 },
    ];
    const plan = planStagger(stacked, params({ order: 'byPositionX' }));
    expect(plan.map((p) => p.rank)).toEqual([0, 1, 2]);
  });
});

describe('planStagger determinism', () => {
  it('the same seed gives the same offsets', () => {
    const once = planStagger(LAYERS, params({ seed: 12345, baseOffsetFrames: 6 }));
    const twice = planStagger(LAYERS, params({ seed: 12345, baseOffsetFrames: 6 }));
    expect(twice).toEqual(once);
  });

  it('the same seed gives the same shuffle', () => {
    expect(arrival('random', { seed: 99 })).toEqual(arrival('random', { seed: 99 }));
  });

  it('a different seed gives a different rhythm', () => {
    // Over a range of seeds, not one pair: two seeds can legitimately agree.
    const shapes = new Set(
      Array.from({ length: 30 }, (_, i) =>
        planStagger(LAYERS, params({ seed: i + 1, baseOffsetFrames: 6 })).map((p) => p.offsetFrames).join()),
    );
    expect(shapes.size).toBeGreaterThan(1);
  });

  it('uses no clock and no Math.random', () => {
    // A reroll button that cannot reproduce the shuffle it just showed you is
    // not a control. Stubbing both is the only way to say that out loud.
    const random = jest.spyOn(Math, 'random');
    const now = jest.spyOn(Date, 'now');
    planStagger(LAYERS, params({ order: 'random', seed: 4 }));
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    random.mockRestore();
    now.mockRestore();
  });
});

describe('planStagger rhythm', () => {
  it('starts the leading layer at zero', () => {
    for (const order of STAGGER_ORDERS) {
      const plan = planStagger(LAYERS, params({ order }));
      expect(plan.find((p) => p.rank === 0)!.offsetFrames).toBe(0);
    }
  });

  it('never goes backwards: later ranks are later in time', () => {
    const plan = planStagger(LAYERS, params({ baseOffsetFrames: 5, seed: 8 }))
      .slice()
      .sort((p, q) => p.rank - q.rank);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.offsetFrames).toBeGreaterThan(plan[i - 1]!.offsetFrames);
    }
  });

  it('gives every offset as a whole number of frames', () => {
    // The point of the whole model. A fractional offset is a swing the frame
    // grid will round away, which is how the old plan became a metronome.
    for (let seed = 1; seed <= 25; seed++) {
      for (const base of [1, 2, 3, 7, 13]) {
        for (const p of planStagger(LAYERS, params({ seed, baseOffsetFrames: base }))) {
          expect(Number.isInteger(p.offsetFrames)).toBe(true);
        }
      }
    }
  });

  it('rounds a fractional base offset onto the grid', () => {
    const plan = planStagger(LAYERS, params({ baseOffsetFrames: 4.6, swingPct: 0 }))
      .slice()
      .sort((p, q) => p.rank - q.rank);
    expect(plan.map((p) => p.offsetFrames)).toEqual([0, 5, 10, 15]);
  });

  it('zero swing is an exact metronome', () => {
    const plan = planStagger(LAYERS, params({ baseOffsetFrames: 4, swingPct: 0, seed: 3 }))
      .slice()
      .sort((p, q) => p.rank - q.rank);
    expect(plan.map((p) => p.offsetFrames)).toEqual([0, 4, 8, 12]);
  });

  it('swing actually varies the gaps for most seeds', () => {
    // The distribution, not one lucky seed — the failure this replaces was a
    // variation that survived quantization only about 60% of the time.
    let flat = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const offsets = planStagger(LAYERS, params({ seed, baseOffsetFrames: 6, swingPct: 30 }))
        .slice()
        .sort((p, q) => p.rank - q.rank)
        .map((p) => p.offsetFrames);
      const gaps = offsets.slice(1).map((o, i) => o - offsets[i]!);
      if (new Set(gaps).size === 1) flat++;
    }
    expect(flat).toBeLessThan(8);
  });

  it('floors the swing at one frame — the smallest step the timebase has', () => {
    // At base 2, ±30% is 0.6 of a frame. Rounding that gives 1, not 0, or the
    // control would silently do nothing at short spacings.
    const gapSets = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const offsets = planStagger(LAYERS, params({ seed, baseOffsetFrames: 2, swingPct: 30 }))
        .slice()
        .sort((p, q) => p.rank - q.rank)
        .map((p) => p.offsetFrames);
      gapSets.add(offsets.slice(1).map((o, i) => o - offsets[i]!).join());
    }
    expect(gapSets.size).toBeGreaterThan(1);
  });

  it('never lets a gap fall below one frame', () => {
    // A 100% swing on a 2-frame base would otherwise plan a zero gap, which is
    // two layers arriving together in what was asked to be a cascade.
    for (let seed = 1; seed <= 40; seed++) {
      const offsets = planStagger(LAYERS, params({ seed, baseOffsetFrames: 2, swingPct: 100 }))
        .slice()
        .sort((p, q) => p.rank - q.rank)
        .map((p) => p.offsetFrames);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]! - offsets[i - 1]!).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('a base of zero means all together, with no one-frame floor invented', () => {
    // "Everything at once" is a legitimate choice (a pop-on). Quietly turning
    // it into a one-frame cascade would be the app overruling the control.
    const plan = planStagger(LAYERS, params({ baseOffsetFrames: 0, swingPct: 50, seed: 9 }));
    expect(plan.map((p) => p.offsetFrames)).toEqual([0, 0, 0, 0]);
  });

  it('handles an empty and a single-layer selection', () => {
    expect(planStagger([], params())).toEqual([]);
    expect(planStagger([LAYERS[0]!], params()).map((p) => p.offsetFrames)).toEqual([0]);
  });
});

describe('planStagger per-layer overrides', () => {
  it('an override wins over the computed rhythm', () => {
    const plan = planStagger(LAYERS, params({ baseOffsetFrames: 4, swingPct: 0, perLayerOverrides: { c: 40 } }));
    const byId = new Map(plan.map((p) => [p.nodeId, p]));
    expect(byId.get('c')!.offsetFrames).toBe(40);
    expect(byId.get('c')!.overridden).toBe(true);
    // And only that one: an override is a nudge, not a mode.
    expect(byId.get('a')!.offsetFrames).toBe(0);
    expect(byId.get('b')!.offsetFrames).toBe(4);
    expect(byId.get('d')!.offsetFrames).toBe(12);
    expect(byId.get('d')!.overridden).toBe(false);
  });

  it('an override does not disturb the ranks the order produced', () => {
    // Ranks describe the ORDER; offsets describe the timing. Pushing one layer
    // to the end of the bar must not renumber the others, or every subsequent
    // gap would be computed from a different seat in the rhythm.
    const base = planStagger(LAYERS, params({ order: 'byPositionX', baseOffsetFrames: 4 }));
    const over = planStagger(LAYERS, params({ order: 'byPositionX', baseOffsetFrames: 4, perLayerOverrides: { a: 99 } }));
    expect(over.map((p) => p.rank)).toEqual(base.map((p) => p.rank));
  });

  it('rounds an override onto the frame grid too', () => {
    const plan = planStagger(LAYERS, params({ perLayerOverrides: { b: 7.7 } }));
    expect(plan.find((p) => p.nodeId === 'b')!.offsetFrames).toBe(8);
  });

  it('keeps a negative override — leading by two frames is a real thing to want', () => {
    const plan = planStagger(LAYERS, params({ perLayerOverrides: { d: -2 } }));
    expect(plan.find((p) => p.nodeId === 'd')!.offsetFrames).toBe(-2);
  });

  it('ignores an override for a layer that is not in the plan', () => {
    const plan = planStagger(LAYERS, params({ baseOffsetFrames: 4, swingPct: 0, perLayerOverrides: { gone: 50 } }));
    expect(plan.map((p) => p.offsetFrames)).toEqual([0, 4, 8, 12]);
  });

  it('ignores a non-finite override rather than writing NaN into a keyframe time', () => {
    const plan = planStagger(LAYERS, params({
      baseOffsetFrames: 4,
      swingPct: 0,
      perLayerOverrides: { a: Number.NaN, b: Number.POSITIVE_INFINITY },
    }));
    expect(plan.map((p) => p.offsetFrames)).toEqual([0, 4, 8, 12]);
    expect(plan.every((p) => !p.overridden)).toBe(true);
  });
});
