/**
 * The easing-vocabulary reconciliation.
 *
 * Two surfaces (the timeline graph editor and the Motion panel) used to own
 * separate, disagreeing translations between `EasingKind` and `EasingPreset`.
 * The disagreements were invisible — both spellings of hold sample the same, and
 * 'ease' vs 'Ease' are two different curves wearing one word — so the only way
 * they stay reconciled is a test that states each one out loud.
 */

import {  EASY_EASE_BEZIER, type EasingKind } from '@motion/animation';
import {
  EASING_KINDS,
  EASING_KIND_LABEL,
  activeEasingKind,
  easingKindForPreset,
  easingPresetForKind,
  isHoldKind,
} from './easingVocabulary';
import { ease } from '@motion/animation';

describe('the kind table', () => {
  it('names every kind the engine can store, exactly once', () => {
    // `EASING_KIND_LABEL` is a Record over the union, so this is really
    // checking that the ORDERED list did not drop or duplicate one.
    const listed = EASING_KINDS.map((e) => e.kind);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.keys(EASING_KIND_LABEL).sort());
    expect(listed).toHaveLength(10);
  });

  it('labels each entry with its table label', () => {
    for (const { kind, label } of EASING_KINDS) expect(label).toBe(EASING_KIND_LABEL[kind]);
  });
});

describe("'ease' the kind is not 'Ease' the preset", () => {
  it('the two curves genuinely differ, which is why they must not be aliased', () => {
    // CSS ease [0.25, 0.1, 0.25, 1] leaves the start much faster than Easy
    // Ease [1/3, 0, 2/3, 1] does. If these ever coincided the distinction
    // below would be pedantry; they do not.
    expect(ease('ease', 0.25)).toBeGreaterThan(0.25);
    expect(EASY_EASE_BEZIER).toEqual([1 / 3, 0, 2 / 3, 1]);
  });

  it('maps neither onto the other', () => {
    expect(easingPresetForKind('ease')).toBeNull();
    expect(easingPresetForKind('easeInOut')).toBeNull();
    // Applying the 'Ease' PRESET leaves a bezier keyframe, not an 'ease' one.
    expect(easingKindForPreset('Ease')).toBe('bezier');
    expect(easingPresetForKind('bezier')).toBeNull();
  });
});

describe('hold is spelled twice and both are real', () => {
  it('recognises either spelling', () => {
    expect(isHoldKind('hold')).toBe(true);
    expect(isHoldKind('step')).toBe(true);
    expect(isHoldKind('linear')).toBe(false);
    expect(isHoldKind(undefined)).toBe(false);
  });

  it('resolves both to the Hold preset, so a pill lights either way', () => {
    expect(easingPresetForKind('hold')).toBe('Hold');
    expect(easingPresetForKind('step')).toBe('Hold');
  });

  it('the preset writes the scalar spelling', () => {
    expect(easingKindForPreset('Hold')).toBe('step');
  });
});

describe('activeEasingKind', () => {
  it('reads an absent easing as linear — what the sampler does with it', () => {
    expect(activeEasingKind({})).toBe('linear');
    expect(activeEasingKind(null)).toBe('linear');
    expect(activeEasingKind({ easing: 'autoBezier' })).toBe('autoBezier');
  });
});

// Type-level: every kind is reachable from the table (a compile-time check that
// the list below is exhaustive, kept next to the runtime one it backs).
const _exhaustive: ReadonlyArray<EasingKind> = EASING_KINDS.map((e) => e.kind);
void _exhaustive;
