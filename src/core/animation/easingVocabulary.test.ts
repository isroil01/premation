/**
 * The easing-vocabulary reconciliation.
 *
 * Two surfaces (the timeline graph editor and the Motion panel) used to own
 * separate, disagreeing translations between `EasingKind` and `EasingPreset`.
 * The disagreements were invisible — both spellings of hold sample the same, and
 * 'ease' vs 'Ease' are two different curves wearing one word — so the only way
 * they stay reconciled is a test that states each one out loud.
 */

import { AnimationEngine, makeKeyframeId, EASY_EASE_BEZIER, type EasingKind } from '@motion/animation';
import {
  EASING_KINDS,
  EASING_KIND_LABEL,
  activeEasingKind,
  applyEasingKindToKeyframes,
  easingKindForPreset,
  easingPresetForKind,
  isHoldKind,
} from './easingVocabulary';
import { applyEasingToKeyframes } from './keyframeAssistants';
import { ease } from '@motion/animation';

const NODE = 'vocab-node';
const PIN = 'puppet.mover.position';

function engineWithTrack(): AnimationEngine {
  const anim = new AnimationEngine();
  anim.setKeyframe(NODE, 'x', 0, 0, 'linear');
  anim.setKeyframe(NODE, 'x', 1, 100, 'linear');
  return anim;
}

const kfAt = (anim: AnimationEngine, prop: string, t: number) =>
  anim.getTrackKeyframes(NODE, prop)!.find((k) => Math.abs(k.t - t) < 1e-9)!;

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

  it('agrees with what the shared apply path actually writes', () => {
    const anim = engineWithTrack();
    const id = makeKeyframeId(NODE, 'x', 0);
    for (const preset of ['Linear', 'Ease', 'EaseIn', 'EaseOut', 'Hold', 'expo-out'] as const) {
      applyEasingToKeyframes([id], preset, anim);
      expect(kfAt(anim, 'x', 0).easing).toBe(easingKindForPreset(preset));
    }
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

describe('applyEasingKindToKeyframes', () => {
  it('writes every kind onto the keyframe verbatim', () => {
    const anim = engineWithTrack();
    const id = makeKeyframeId(NODE, 'x', 0);
    for (const { kind } of EASING_KINDS) {
      applyEasingKindToKeyframes([id], kind, anim);
      expect(kfAt(anim, 'x', 0).easing).toBe(kind);
    }
  });

  it('seeds handles when switching to a custom bezier', () => {
    const anim = engineWithTrack();
    applyEasingKindToKeyframes([makeKeyframeId(NODE, 'x', 0)], 'bezier', anim);
    expect(kfAt(anim, 'x', 0).bezier).toBeDefined();
  });

  it('expands a merged Position keyframe to its axes', () => {
    const anim = new AnimationEngine();
    for (const prop of ['x', 'y', 'z'] as const) {
      anim.setKeyframe(NODE, prop, 0, 0, 'linear');
      anim.setKeyframe(NODE, prop, 1, 10, 'linear');
    }
    applyEasingKindToKeyframes([makeKeyframeId(NODE, 'Position', 0)], 'easeOut', anim);
    for (const prop of ['x', 'y', 'z'] as const) {
      expect(kfAt(anim, prop, 0).easing).toBe('easeOut');
    }
  });

  it('reaches DATA tracks, which have no scalar keyframes at all', () => {
    const anim = new AnimationEngine();
    anim.setDataTrack('m', PIN, {
      nodeId: 'm',
      prop: PIN,
      kind: 'points',
      keyframes: [
        { t: 0, value: [{ x: 0, y: 0 }] },
        { t: 2, value: [{ x: 60, y: 0 }] },
      ],
    } as never);
    applyEasingKindToKeyframes([makeKeyframeId('m', PIN, 0)], 'hold', anim);
    expect(anim.getDataTrack('m', PIN)!.keyframes[0]!.easing).toBe('hold');
  });

  it('ignores an empty id list and unparseable ids', () => {
    const anim = engineWithTrack();
    const before = JSON.stringify(anim.getTrackKeyframes(NODE, 'x'));
    applyEasingKindToKeyframes([], 'hold', anim);
    applyEasingKindToKeyframes(['not-an-id'], 'hold', anim);
    expect(JSON.stringify(anim.getTrackKeyframes(NODE, 'x'))).toBe(before);
  });
});

// Type-level: every kind is reachable from the table (a compile-time check that
// the list below is exhaustive, kept next to the runtime one it backs).
const _exhaustive: ReadonlyArray<EasingKind> = EASING_KINDS.map((e) => e.kind);
void _exhaustive;
