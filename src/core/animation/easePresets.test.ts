/**
 * The ease library, asserted against the sampler that will actually run it.
 *
 * A table of magic numbers is exactly the kind of thing that looks right and is
 * not, so nothing here trusts the literals: every curve is SAMPLED through
 * `cubicBezierEase` — the same function the interpolator calls — and checked for
 * the property its name promises. A transposed control point survives review;
 * it does not survive "Expo In must be slower than Sine In at the midpoint".
 */

import { cubicBezierEase } from '@motion/animation';
import {
  EASE_PRESETS,
  easePresetById,
  isEasePresetId,
  easePresetsByFamily,
  type EasePreset,
} from './easePresets';

const byId = (id: string): EasePreset => {
  const p = easePresetById(id);
  if (!p) throw new Error(`no such ease preset: ${id}`);
  return p;
};

const at = (p: EasePreset, x: number): number => cubicBezierEase(p.bezier, x);

describe('the ease library is well formed', () => {
  it('covers 8 families × 3 directions, with unique ids', () => {
    expect(EASE_PRESETS).toHaveLength(24);
    expect(new Set(EASE_PRESETS.map((p) => p.id)).size).toBe(24);
  });

  it.each(EASE_PRESETS.map((p) => [p.id, p] as const))(
    '%s keeps both X handles inside [0,1]',
    (_id, p) => {
      // X is TIME. `cubicBezierEase` solves x(s) = t by Newton iteration, which
      // assumes the curve is a function of x; a control point outside [0,1]
      // makes it multi-valued and the solve lands on an arbitrary branch. Y is
      // the value axis and is deliberately unconstrained — that is overshoot.
      expect(p.bezier[0]).toBeGreaterThanOrEqual(0);
      expect(p.bezier[0]).toBeLessThanOrEqual(1);
      expect(p.bezier[2]).toBeGreaterThanOrEqual(0);
      expect(p.bezier[2]).toBeLessThanOrEqual(1);
    },
  );

  it.each(EASE_PRESETS.map((p) => [p.id, p] as const))(
    '%s is pinned at both ends',
    (_id, p) => {
      // Every easing must start at the departing value and arrive exactly at the
      // target, whatever it does between. A curve that ends at 0.98 leaves the
      // property short of its own keyframe.
      expect(at(p, 0)).toBeCloseTo(0, 5);
      expect(at(p, 1)).toBeCloseTo(1, 5);
    },
  );

  it('flags exactly the Back family as overshooting', () => {
    const flagged = EASE_PRESETS.filter((p) => p.overshoots).map((p) => p.id);
    expect(flagged.sort()).toEqual(['back-in', 'back-inOut', 'back-out'].sort());
  });

  it('overshoot is real, not just a flag on the record', () => {
    // Sampled, so the flag cannot drift from the curve. Back Out passes its
    // target and comes back; Back In dips below its start first.
    const outMax = Math.max(...Array.from({ length: 101 }, (_, i) => at(byId('back-out'), i / 100)));
    expect(outMax).toBeGreaterThan(1);
    const inMin = Math.min(...Array.from({ length: 101 }, (_, i) => at(byId('back-in'), i / 100)));
    expect(inMin).toBeLessThan(0);
  });

  it('has no Elastic or Bounce, which a single cubic cannot trace', () => {
    // Guarding the ABSENCE: both oscillate around their target, so any bezier
    // wearing those names would be a curve that is not what it claims. They are
    // generators and live in `bounce.ts`.
    const families = new Set(EASE_PRESETS.map((p) => p.family));
    expect(families.has('elastic' as never)).toBe(false);
    expect(families.has('bounce' as never)).toBe(false);
  });
});

describe('the curves behave the way their names promise', () => {
  it('every non-overshooting curve is monotonic', () => {
    // A curve that backtracks would move the property away from its target
    // mid-segment. Only Back is allowed to leave the corridor, and even it must
    // not reverse direction more than its single overshoot requires.
    for (const p of EASE_PRESETS.filter((q) => !q.overshoots)) {
      let prev = -Infinity;
      for (let i = 0; i <= 100; i++) {
        const y = at(p, i / 100);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = y;
      }
    }
  });

  it('"in" starts slow and "out" starts fast', () => {
    // The defining property of the direction, and the one most easily inverted
    // by a copy-paste: at 25% through the segment an ease-IN has barely moved,
    // an ease-OUT is already most of the way there.
    for (const p of EASE_PRESETS.filter((q) => q.family !== 'back')) {
      const y = at(p, 0.25);
      if (p.direction === 'in') expect(y).toBeLessThan(0.25);
      if (p.direction === 'out') expect(y).toBeGreaterThan(0.25);
    }
  });

  it('"inOut" is symmetric about the midpoint', () => {
    for (const p of EASE_PRESETS.filter((q) => q.direction === 'inOut' && q.family !== 'back')) {
      expect(at(p, 0.5)).toBeCloseTo(0.5, 1);
      // f(x) + f(1-x) == 1 for a symmetric ease.
      expect(at(p, 0.2) + at(p, 0.8)).toBeCloseTo(1, 1);
    }
  });

  it('severity increases across the family order at the same direction', () => {
    // Sine → Quad → … → Expo is meant to be a ramp of increasing sharpness. If
    // two families are transposed in the table this is what catches it: further
    // down the list, an ease-IN has moved LESS by the midpoint.
    const order = ['sine', 'quad', 'cubic', 'quart', 'quint', 'expo'] as const;
    const mids = order.map((f) => at(byId(`${f}-in`), 0.5));
    for (let i = 1; i < mids.length; i++) {
      expect(mids[i]!).toBeLessThan(mids[i - 1]!);
    }
  });
});

describe('lookup', () => {
  it('isEasePresetId accepts library ids and rejects the legacy names', () => {
    expect(isEasePresetId('expo-out')).toBe(true);
    // The AE interpolation types are NOT in this table — they resolve in
    // `presetCurve`, and treating them as curves here would double-source them.
    expect(isEasePresetId('Ease')).toBe(false);
    expect(isEasePresetId('Hold')).toBe(false);
    expect(isEasePresetId('elastic-out')).toBe(false);
  });

  it('groups every preset into exactly one family row', () => {
    const rows = easePresetsByFamily();
    expect(rows).toHaveLength(8);
    expect(rows.flatMap((r) => r.presets)).toHaveLength(EASE_PRESETS.length);
    for (const r of rows) expect(r.presets).toHaveLength(3);
  });
});
