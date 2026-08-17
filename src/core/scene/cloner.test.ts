/**
 * The cloner plan.
 *
 * Everything here is arithmetic whose failures composite into something that
 * looks deliberate: a ring whose last clone sits on its first, a grid anchored
 * at its corner so every count change needs a position change to undo it, a
 * stagger that runs backwards, a falloff that masks the wrong half. None of
 * them throw, and none are obvious in a screenshot.
 */

import {
  clonerPlan,
  cloneCount,
  falloffWeight,
  DEFAULT_CLONER,
  MAX_CLONES,
  type ClonerConfig,
  type ClonerFalloff,
} from './cloner';

const cfg = (patch: Partial<ClonerConfig> = {}): ClonerConfig => ({
  ...DEFAULT_CLONER,
  enabled: true,
  ...patch,
});

const fo = (p: Partial<ClonerFalloff>): ClonerFalloff => ({ ...DEFAULT_CLONER.falloff, ...p });

const xs = (c: ClonerConfig): number[] => clonerPlan(c).map((p) => Math.round(p.x * 1000) / 1000);
const ys = (c: ClonerConfig): number[] => clonerPlan(c).map((p) => Math.round(p.y * 1000) / 1000);

describe('how many clones', () => {
  it('is zero while disabled, so the layer renders once as itself', () => {
    expect(cloneCount({ ...DEFAULT_CLONER, enabled: false })).toBe(0);
    expect(clonerPlan({ ...DEFAULT_CLONER, enabled: false })).toEqual([]);
  });

  it('multiplies rows by columns in grid mode', () => {
    expect(cloneCount(cfg({ mode: 'grid', countX: 4, countY: 3 }))).toBe(12);
  });

  it('caps at MAX_CLONES — each clone is a real renderable', () => {
    expect(cloneCount(cfg({ count: 100000 }))).toBe(MAX_CLONES);
    expect(cloneCount(cfg({ mode: 'grid', countX: 999, countY: 999 }))).toBe(MAX_CLONES);
  });

  it('treats negative or fractional counts sanely', () => {
    expect(cloneCount(cfg({ count: -5 }))).toBe(0);
    expect(cloneCount(cfg({ count: 3.7 }))).toBe(3);
  });
});

describe('linear', () => {
  it('is centred on the cloner, not growing from it', () => {
    // A run that grew from the origin would drift off-centre with every count
    // change, so each tweak would need a position tweak to undo it.
    expect(xs(cfg({ mode: 'linear', count: 3, offsetX: 100, offsetY: 0 }))).toEqual([-100, 0, 100]);
  });

  it('centres an even count between the two middle clones', () => {
    expect(xs(cfg({ mode: 'linear', count: 4, offsetX: 100 }))).toEqual([-150, -50, 50, 150]);
  });

  it('offsets both axes', () => {
    expect(ys(cfg({ mode: 'linear', count: 3, offsetX: 0, offsetY: 10 }))).toEqual([-10, 0, 10]);
  });

  it('a single clone sits exactly on the cloner', () => {
    expect(clonerPlan(cfg({ mode: 'linear', count: 1 }))[0]).toMatchObject({ x: 0, y: 0 });
  });
});

describe('grid', () => {
  it('fills rows then columns, centred both ways', () => {
    const p = clonerPlan(cfg({ mode: 'grid', countX: 2, countY: 2, offsetX: 100, offsetY: 50 }));
    expect(p.map((c) => [c.x, c.y])).toEqual([
      [-50, -25], [50, -25],
      [-50, 25], [50, 25],
    ]);
  });

  it('a 1×N grid degenerates to a column, still centred', () => {
    expect(ys(cfg({ mode: 'grid', countX: 1, countY: 3, offsetY: 10 }))).toEqual([-10, 0, 10]);
  });
});

describe('radial', () => {
  it('does not put the last clone on top of the first at a full circle', () => {
    // THE radial bug. At 360° with n clones the step must be 360/n, not
    // 360/(n-1) — otherwise clone n-1 lands exactly on clone 0 and the ring
    // silently has one fewer visible element than the count says.
    const p = clonerPlan(cfg({ mode: 'radial', count: 4, radius: 100, startAngle: 0, arc: 360 }));
    expect(p).toHaveLength(4);
    const first = p[0]!;
    const last = p[3]!;
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(1);
  });

  it('places a full ring at the expected angles', () => {
    const p = clonerPlan(cfg({ mode: 'radial', count: 4, radius: 100, startAngle: 0, arc: 360 }));
    expect(p.map((c) => [Math.round(c.x), Math.round(c.y)])).toEqual([
      [100, 0], [0, 100], [-100, 0], [-0, -100],
    ]);
  });

  it('a partial arc DOES reach its end angle', () => {
    // The converse of the wrap case: an arc is a span with two ends, and a
    // 180° arc that stopped short of 180° would look like a rounding bug.
    const p = clonerPlan(cfg({ mode: 'radial', count: 3, radius: 100, startAngle: 0, arc: 180 }));
    expect(p.map((c) => [Math.round(c.x), Math.round(c.y)])).toEqual([
      [100, 0], [0, 100], [-100, 0],
    ]);
  });

  it('alignToRadius turns each clone to face along the ring', () => {
    const p = clonerPlan(cfg({ mode: 'radial', count: 4, arc: 360, startAngle: 0, alignToRadius: true }));
    expect(p.map((c) => Math.round(c.rotation))).toEqual([90, 180, 270, 360]);
  });

  it('leaves rotation alone when not aligning', () => {
    const p = clonerPlan(cfg({ mode: 'radial', count: 4, alignToRadius: false }));
    expect(p.every((c) => c.rotation === 0)).toBe(true);
  });
});

describe('the step effector', () => {
  it('ramps from nothing on the first clone to full on the last', () => {
    const p = clonerPlan(cfg({ mode: 'linear', count: 3, offsetX: 0, step: { ...DEFAULT_CLONER.step, x: 90 } }));
    expect(p.map((c) => Math.round(c.x))).toEqual([0, 45, 90]);
  });

  it('ramps opacity down without going negative', () => {
    const p = clonerPlan(cfg({ count: 3, step: { ...DEFAULT_CLONER.step, opacity: -100 } }));
    expect(p.map((c) => Math.round(c.opacity))).toEqual([100, 50, 0]);
  });

  it('ramps scale as a fraction', () => {
    const p = clonerPlan(cfg({ count: 3, step: { ...DEFAULT_CLONER.step, scale: 1 } }));
    expect(p.map((c) => Math.round(c.scaleX * 100) / 100)).toEqual([1, 1.5, 2]);
  });

  it('never produces a NEGATIVE scale', () => {
    // A negative scale mirrors the layer, which is never what "smaller towards
    // the end" meant — it reads as clones flipping inside out partway along.
    const p = clonerPlan(cfg({ count: 3, step: { ...DEFAULT_CLONER.step, scale: -4 } }));
    expect(p.every((c) => c.scaleX >= 0)).toBe(true);
  });

  it('does not divide by zero with a single clone', () => {
    const p = clonerPlan(cfg({ count: 1, step: { ...DEFAULT_CLONER.step, x: 90, opacity: -100 } }));
    expect(p[0]!.x).toBe(0);
    expect(p[0]!.opacity).toBe(100);
  });
});

describe('the random effector', () => {
  it('is deterministic — the same seed gives the same layout', () => {
    // The contract that makes a cloner usable for anything you intend to
    // render: scrubbing to a frame and playing to it must agree.
    const c = cfg({ count: 20, random: { seed: 7, position: 50, rotation: 30, scale: 0.3 } });
    expect(clonerPlan(c)).toEqual(clonerPlan(c));
  });

  it('a different seed reshuffles', () => {
    const a = clonerPlan(cfg({ count: 10, random: { seed: 1, position: 50, rotation: 0, scale: 0 } }));
    const b = clonerPlan(cfg({ count: 10, random: { seed: 2, position: 50, rotation: 0, scale: 0 } }));
    expect(a.map((c) => c.x)).not.toEqual(b.map((c) => c.x));
  });

  it('scatters within the requested bound, both directions', () => {
    const p = clonerPlan(cfg({ mode: 'linear', count: 60, offsetX: 0, random: { seed: 3, position: 40, rotation: 0, scale: 0 } }));
    for (const c of p) expect(Math.abs(c.x)).toBeLessThanOrEqual(40);
    // …and actually uses both signs, rather than only ever pushing one way.
    expect(p.some((c) => c.x > 5)).toBe(true);
    expect(p.some((c) => c.x < -5)).toBe(true);
  });

  it('x and y are independent, not the same number twice', () => {
    const p = clonerPlan(cfg({ count: 20, offsetX: 0, offsetY: 0, random: { seed: 5, position: 50, rotation: 0, scale: 0 } }));
    expect(p.some((c) => Math.abs(c.x - c.y) > 1)).toBe(true);
  });

  it('does nothing at zero amplitude', () => {
    const p = clonerPlan(cfg({ mode: 'linear', count: 5, offsetX: 100, random: { seed: 9, position: 0, rotation: 0, scale: 0 } }));
    expect(p.map((c) => c.x)).toEqual([-200, -100, 0, 100, 200]);
  });
});

describe('falloff', () => {
  it('reaches everything when shaped none', () => {
    for (let i = 0; i < 5; i++) {
      expect(falloffWeight(i, 5, fo({ shape: 'none', position: 0.5, width: 0.1, invert: false }))).toBe(1);
    }
  });

  it('linear peaks at the centre and reaches zero at the width', () => {
    const f = fo(fo({ shape: 'linear', position: 0, width: 0.5, invert: false }));
    expect(falloffWeight(0, 5, f)).toBeCloseTo(1, 6);   // t=0, at centre
    expect(falloffWeight(2, 5, f)).toBeCloseTo(0, 6);   // t=0.5, at the edge
    expect(falloffWeight(4, 5, f)).toBeCloseTo(0, 6);   // t=1, outside
  });

  it('invert flips which clones are affected', () => {
    const base = fo(fo({ shape: 'linear', position: 0, width: 0.5, invert: false }));
    expect(falloffWeight(0, 5, { ...base, invert: true })).toBeCloseTo(0, 6);
    expect(falloffWeight(4, 5, { ...base, invert: true })).toBeCloseTo(1, 6);
  });

  it('a zero width still reaches the centre clone', () => {
    // Otherwise the control has a dead end at one extreme: drag width to 0 and
    // the effector silently switches off entirely.
    const f = fo(fo({ shape: 'linear', position: 0, width: 0, invert: false }));
    expect(falloffWeight(0, 5, f)).toBe(1);
    expect(falloffWeight(1, 5, f)).toBe(0);
  });

  it('radial is smooth at its edge, unlike linear', () => {
    const lin = fo(fo({ shape: 'linear', position: 0.5, width: 0.5, invert: false }));
    const rad = fo(fo({ shape: 'radial', position: 0.5, width: 0.5, invert: false }));
    // Just inside the edge the cosine shoulder is already close to zero, while
    // the straight ramp still carries visible weight — that is the seam the
    // radial shape exists to avoid.
    expect(falloffWeight(8, 11, rad)).toBeLessThan(falloffWeight(8, 11, lin));
  });

  it('scales the effectors rather than the layout', () => {
    // A falloff must mask the EFFECT, not delete clones or move the
    // arrangement: the un-affected clones stay exactly where the mode put them.
    const p = clonerPlan(cfg({
      mode: 'linear', count: 3, offsetX: 100,
      step: { ...DEFAULT_CLONER.step, y: 100 },
      falloff: fo({ shape: 'linear', position: 0, width: 0.4, invert: false }),
    }));
    expect(p.map((c) => c.x)).toEqual([-100, 0, 100]); // layout untouched
    expect(p[2]!.y).toBe(0);                            // last clone unaffected
  });

  it('a single clone does not divide by zero', () => {
    expect(falloffWeight(0, 1, fo({ shape: 'linear', position: 0.5, width: 0.5, invert: false })))
      .toBeGreaterThanOrEqual(0);
  });
});
