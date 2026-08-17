/**
 * The onion-skin plan.
 *
 * Everything asserted here is a property that is invisible once it is wrong:
 * a ghost of the current frame reads as a contrast change, an inverted draw
 * order reads as motion going the wrong way, and a falloff that hits zero reads
 * as the count control being capped. None of them throw.
 */

import {
  onionSkinPlan,
  onionSkinSignature,
  DEFAULT_ONION_SKIN,
  ONION_PAST_TINT,
  ONION_FUTURE_TINT,
  type OnionSkinSettings,
} from './onionSkin';

const on = (patch: Partial<OnionSkinSettings> = {}): OnionSkinSettings => ({
  ...DEFAULT_ONION_SKIN,
  enabled: true,
  ...patch,
});

const WIDE = { min: -1000, max: 1000 };

describe('when nothing should be drawn', () => {
  it('is empty while disabled', () => {
    expect(onionSkinPlan(10, { ...DEFAULT_ONION_SKIN, enabled: false }, WIDE)).toEqual([]);
  });

  it('is empty with no ghosts on either side', () => {
    expect(onionSkinPlan(10, on({ before: 0, after: 0 }), WIDE)).toEqual([]);
  });

  it('is empty at zero opacity, rather than drawing invisible ghosts', () => {
    // Each ghost costs a full comp render. Queuing renders whose result cannot
    // be seen is the expensive way to draw nothing.
    expect(onionSkinPlan(10, on({ opacity: 0 }), WIDE)).toEqual([]);
  });
});

describe('which frames', () => {
  it('never includes the current frame', () => {
    // Ghosting the frame you are looking at just darkens it — it looks like a
    // contrast bug, not like an off-by-one.
    const plan = onionSkinPlan(10, on({ before: 3, after: 3 }), WIDE);
    expect(plan.map((p) => p.frame)).not.toContain(10);
  });

  it('takes `before` frames back and `after` frames forward', () => {
    const plan = onionSkinPlan(10, on({ before: 2, after: 3 }), WIDE);
    expect(plan.map((p) => p.frame).sort((a, b) => a - b)).toEqual([8, 9, 11, 12, 13]);
  });

  it('honours the step', () => {
    const plan = onionSkinPlan(10, on({ before: 2, after: 2, step: 3 }), WIDE);
    expect(plan.map((p) => p.frame).sort((a, b) => a - b)).toEqual([4, 7, 13, 16]);
  });

  it('treats a nonsense step as 1 rather than producing duplicates', () => {
    // step 0 would put every ghost on the current frame.
    const plan = onionSkinPlan(10, on({ before: 2, after: 0, step: 0 }), WIDE);
    expect(plan.map((p) => p.frame).sort((a, b) => a - b)).toEqual([8, 9]);
  });

  it('DROPS out-of-range frames instead of clamping them', () => {
    // Clamping would stack three ghosts on frame 0, which reads as one solid
    // ghost — a different picture from "there is nothing before this".
    const plan = onionSkinPlan(1, on({ before: 3, after: 0 }), { min: 0, max: 100 });
    expect(plan.map((p) => p.frame)).toEqual([0]);
  });

  it('drops past the end of the comp too', () => {
    const plan = onionSkinPlan(99, on({ before: 0, after: 3 }), { min: 0, max: 100 });
    expect(plan.map((p) => p.frame)).toEqual([100]);
  });
});

describe('draw order', () => {
  it('returns farthest first, so the nearest ghost ends up on top', () => {
    // Ghosts are translucent and overlap. Painting nearest-first buries the
    // frame closest to the playhead under the ones furthest away, and the sense
    // of direction inverts.
    const plan = onionSkinPlan(10, on({ before: 3, after: 0 }), WIDE);
    expect(plan.map((p) => p.frame)).toEqual([7, 8, 9]);
  });

  it('interleaves the two sides by distance', () => {
    const plan = onionSkinPlan(10, on({ before: 2, after: 2 }), WIDE);
    expect(plan.map((p) => p.frame)).toEqual([8, 12, 9, 11]);
  });

  it('opacity is non-decreasing through the array', () => {
    // The invariant that makes "farthest first" meaningful, asserted directly
    // rather than inferred from the frame order.
    const plan = onionSkinPlan(10, on({ before: 4, after: 4 }), WIDE);
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.opacity).toBeGreaterThanOrEqual(plan[i - 1]!.opacity - 1e-9);
    }
  });
});

describe('falloff', () => {
  it('gives the nearest ghost the configured opacity', () => {
    const plan = onionSkinPlan(10, on({ before: 3, after: 0, opacity: 0.6 }), WIDE);
    expect(plan[plan.length - 1]!.frame).toBe(9);
    expect(plan[plan.length - 1]!.opacity).toBeCloseTo(0.6, 6);
  });

  it('never falls to zero, so the outermost ghost still draws', () => {
    const plan = onionSkinPlan(10, on({ before: 5, after: 0, opacity: 0.5 }), WIDE);
    for (const g of plan) expect(g.opacity).toBeGreaterThan(0);
    expect(plan[0]!.opacity).toBeCloseTo(0.5 / 5, 6);
  });

  it('clamps a nonsense opacity into range', () => {
    const plan = onionSkinPlan(10, on({ before: 1, after: 0, opacity: 5 }), WIDE);
    expect(plan[0]!.opacity).toBe(1);
  });
});

describe('tint', () => {
  it('past is warm and future is cool', () => {
    const plan = onionSkinPlan(10, on({ before: 1, after: 1 }), WIDE);
    expect(plan.find((p) => p.frame === 9)!.tint).toBe(ONION_PAST_TINT);
    expect(plan.find((p) => p.frame === 11)!.tint).toBe(ONION_FUTURE_TINT);
  });

  it('labels each ghost with the side it came from', () => {
    const plan = onionSkinPlan(10, on({ before: 1, after: 1 }), WIDE);
    expect(plan.find((p) => p.frame === 9)!.side).toBe('before');
    expect(plan.find((p) => p.frame === 11)!.side).toBe('after');
  });

  it('is null with colorize off', () => {
    const plan = onionSkinPlan(10, on({ before: 1, after: 1, colorize: false }), WIDE);
    expect(plan.every((p) => p.tint === null)).toBe(true);
  });
});

describe('signature', () => {
  it('is empty while disabled, so no work is ever memoized for it', () => {
    expect(onionSkinSignature(10, { ...DEFAULT_ONION_SKIN, enabled: false }, 'k')).toBe('');
  });

  it('changes with the playhead', () => {
    expect(onionSkinSignature(10, on(), 'k')).not.toBe(onionSkinSignature(11, on(), 'k'));
  });

  it('changes with an edit or a view change, via the invalidation key', () => {
    // The ghosts are rendered through the same projection as the live frame, so
    // a pan or a scene edit invalidates them exactly as it invalidates the
    // frame cache. Sharing the key is what keeps the two from disagreeing.
    expect(onionSkinSignature(10, on(), 'k1')).not.toBe(onionSkinSignature(10, on(), 'k2'));
  });

  it.each([
    ['before', { before: 9 }],
    ['after', { after: 9 }],
    ['step', { step: 4 }],
    ['opacity', { opacity: 0.9 }],
    ['colorize', { colorize: false }],
  ] as const)('changes with %s', (_name, patch) => {
    expect(onionSkinSignature(10, on(), 'k')).not.toBe(onionSkinSignature(10, on(patch), 'k'));
  });

  it('is stable when nothing relevant changed', () => {
    // The point of the memo: a hover or a selection change must not re-render
    // every ghost.
    expect(onionSkinSignature(10, on(), 'k')).toBe(onionSkinSignature(10, on(), 'k'));
  });
});
