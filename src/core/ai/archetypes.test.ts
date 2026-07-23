/**
 * Pure-math tests for the entrance-archetype system: keyframe generation,
 * deterministic weighted picking, and the non-uniform stagger. No scene graph.
 */

import {
  ENTRANCE_ARCHETYPES,
  entranceTrackPlans,
  blurResolvePoints,
  charCascadePoints,
  pickEntranceArchetype,
  nonUniformStagger,
  type EntranceParams,
  type EntranceArchetype,
} from './archetypes';

const P: EntranceParams = {
  start: 1,
  dur: 0.7,
  travelPx: 30,
  cy: 540,
  cx: 960,
  curve: [0.22, 1, 0.36, 1],
  direction: 'left',
};

describe('entranceTrackPlans', () => {
  it.each(ENTRANCE_ARCHETYPES.map((a) => [a] as const))('%s fades opacity 0 → 100 within the window', (arch) => {
    const plans = entranceTrackPlans(arch, P);
    const op = plans.find((p) => p.prop === 'opacity');
    expect(op).toBeDefined();
    expect(op!.points[0]).toMatchObject({ t: P.start, value: 0 });
    expect(op!.points[op!.points.length - 1]!.value).toBe(100);
    for (const plan of plans) {
      // Every track needs >= 2 keyframes (one keyframe holds a constant) and
      // must stay inside [start, start+dur].
      expect(plan.points.length).toBeGreaterThanOrEqual(2);
      for (const pt of plan.points) {
        expect(pt.t).toBeGreaterThanOrEqual(P.start);
        expect(pt.t).toBeLessThanOrEqual(P.start + P.dur + 1e-9);
      }
      // Times are strictly increasing within a track.
      for (let i = 1; i < plan.points.length; i++) {
        expect(plan.points[i]!.t).toBeGreaterThan(plan.points[i - 1]!.t);
      }
    }
  });

  it('rise travels from below to rest and tilts rotationX 15 → 0', () => {
    const plans = entranceTrackPlans('rise', P);
    const y = plans.find((p) => p.prop === 'y')!;
    expect(y.points[0]!.value).toBe(P.cy + P.travelPx);
    expect(y.points[y.points.length - 1]!.value).toBe(P.cy);
    const rx = plans.find((p) => p.prop === 'rotationX')!;
    expect(rx.points.map((p) => p.value)).toEqual([15, 0]);
  });

  it('scale_pop starts at 0.85 and lands on 1 with an overshoot bezier', () => {
    const scale = entranceTrackPlans('scale_pop', P).find((p) => p.prop === 'scale')!;
    expect(scale.points[0]!.value).toBe(0.85);
    expect(scale.points[scale.points.length - 1]!.value).toBe(1);
    expect(scale.points[0]!.bezier?.[1]).toBeGreaterThan(1); // overshoot curve
  });

  it('slide_settle clamps travel into the 40–80px band and honours direction', () => {
    const x = entranceTrackPlans('slide_settle', { ...P, travelPx: 10, direction: 'left' }).find((p) => p.prop === 'x')!;
    expect(P.cx - x.points[0]!.value).toBeGreaterThanOrEqual(40);
    const far = entranceTrackPlans('slide_settle', { ...P, travelPx: 200, direction: 'right' }).find((p) => p.prop === 'x')!;
    expect(far.points[0]!.value - P.cx).toBeLessThanOrEqual(80);
    const down = entranceTrackPlans('slide_settle', { ...P, direction: 'down' }).find((p) => p.prop === 'y')!;
    expect(down.points[0]!.value).toBeGreaterThan(P.cy);
  });

  it('mask_wipe expands scaleX from a sliver to full', () => {
    const sx = entranceTrackPlans('mask_wipe', P).find((p) => p.prop === 'scaleX')!;
    expect(sx.points[0]!.value).toBeLessThan(0.1);
    expect(sx.points[sx.points.length - 1]!.value).toBe(1);
  });

  it('blur/cascade helper tracks resolve to their rest values', () => {
    const blur = blurResolvePoints(2, 0.6);
    expect(blur[0]!.value).toBeGreaterThan(0);
    expect(blur[blur.length - 1]!.value).toBe(0);
    const sweep = charCascadePoints(2, 0.6);
    expect(sweep[0]!.value).toBe(0);
    expect(sweep[sweep.length - 1]!.value).toBe(100);
  });
});

describe('pickEntranceArchetype', () => {
  it('is deterministic for the same seed/role/index', () => {
    const a = pickEntranceArchetype({ role: 'title', styleName: 'premium', seed: 42, index: 0 });
    const b = pickEntranceArchetype({ role: 'title', styleName: 'premium', seed: 42, index: 0 });
    expect(a).toBe(b);
  });

  it('varies across seeds — the auto-pick is never always-rise', () => {
    const picks = new Set<EntranceArchetype>();
    for (let seed = 0; seed < 40; seed++) {
      picks.add(pickEntranceArchetype({ role: 'title', styleName: 'premium', seed, index: 0 }));
    }
    expect(picks.size).toBeGreaterThanOrEqual(3);
  });

  it('respects the role allow-list (a card never gets char_cascade)', () => {
    for (let seed = 0; seed < 60; seed++) {
      const pick = pickEntranceArchetype({ role: 'card', styleName: 'playful', seed, index: seed });
      expect(pick).not.toBe('char_cascade');
    }
  });
});

describe('nonUniformStagger', () => {
  it('starts at 0, stays monotonic, and keeps every gap in the 0.7–1.3× band', () => {
    const offsets = nonUniformStagger(8, 0.1, 7);
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i++) {
      const gap = offsets[i]! - offsets[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(0.1 * 0.7 - 1e-9);
      expect(gap).toBeLessThanOrEqual(0.1 * 1.3 + 1e-9);
    }
  });

  it('is not a metronome — gaps differ from each other', () => {
    const offsets = nonUniformStagger(6, 0.1, 99);
    const gaps = offsets.slice(1).map((t, i) => t - offsets[i]!);
    expect(new Set(gaps.map((g) => g.toFixed(4))).size).toBeGreaterThan(1);
  });
});
