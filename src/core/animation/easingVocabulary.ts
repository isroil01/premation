/**
 * The ONE place the two easing vocabularies are reconciled.
 *
 * ── The two vocabularies ────────────────────────────────────────────────────
 *
 * 1. `EasingKind` — what a keyframe STORES (`kf.easing`) and what the sampler
 *    switches on: linear / step / ease / easeIn / easeOut / easeInOut / bezier /
 *    hold / autoBezier / continuousBezier. Ten of them, fixed by the engine.
 *
 * 2. `EasingPreset` — what an ACTION applies: 'Linear' | 'Ease' | 'EaseIn' |
 *    'EaseOut' | 'Hold', plus every id in the ease library ('expo-out', …).
 *    This is what F9, the timeline pills and the ease library speak.
 *
 * They overlap without agreeing, and every disagreement below was a live bug
 * waiting to be written a second time:
 *
 *  • `'ease'` (a KIND) is the CSS ease curve [0.25, 0.1, 0.25, 1].
 *    `'Ease'` (a PRESET) is AE's Easy Ease, [1/3, 0, 2/3, 1], stored as
 *    `easing: 'bezier'`. Same word, different curve, different storage — so
 *    `easingPresetForKind('ease')` is deliberately NULL rather than 'Ease'.
 *    The Motion panel's "Smooth" chip wrote the first; its "Easy Ease" button
 *    wrote the second, and nothing said they were not the same thing.
 *
 *  • HOLD is spelled twice. The scalar apply path writes `'step'`
 *    (`applyEasingToKeyframes`), the panel's Hold chip wrote `'hold'`. The
 *    sampler honours both (see `interpolate.ts`), so both are real data on
 *    disk — which means any surface that ASKS "is this held?" must accept
 *    both. That is `isHoldKind`, and it is why the Hold pill lights for a
 *    keyframe either spelling produced.
 *
 *  • `'easeInOut'` is an analytic quadratic, not a bezier, and has no preset
 *    equivalent at all — picking it from the kind selector cannot be expressed
 *    as a library curve and vice versa.
 *
 * The rule this file enforces: a surface may speak either vocabulary, but it
 * translates HERE. Nothing else may map a kind to a preset or back.
 */

import {
  defaultAnimation,
  parseKeyframeId,
  expandKeyframeProp,
  type AnimationEngine,
  type EasingKind,
} from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import type { EasingPreset } from '@core/animation/keyframeAssistants';

/**
 * Every kind, with the name the UI shows. A `Record` over the union rather than
 * a list, so a kind added to the engine fails to compile until it is named.
 */
export const EASING_KIND_LABEL: Record<EasingKind, string> = {
  linear: 'Linear',
  easeIn: 'Ease In',
  easeOut: 'Ease Out',
  easeInOut: 'In-Out',
  ease: 'Smooth',
  bezier: 'Custom',
  autoBezier: 'Auto Bezier',
  continuousBezier: 'Continuous Bezier',
  step: 'Step',
  hold: 'Hold',
};

/** Display order for the kind selector — gentlest first, discontinuous last. */
export const EASING_KINDS: ReadonlyArray<{ kind: EasingKind; label: string }> = (
  [
    'linear',
    'easeIn',
    'easeOut',
    'easeInOut',
    'ease',
    'autoBezier',
    'continuousBezier',
    'bezier',
    'step',
    'hold',
  ] as const
).map((kind) => ({ kind, label: EASING_KIND_LABEL[kind] }));

/** True for both spellings of "hold this value until the next keyframe". */
export function isHoldKind(easing: string | undefined): boolean {
  return easing === 'hold' || easing === 'step';
}

/**
 * The kind a keyframe currently IS, for a selector's highlight.
 *
 * An absent `easing` is linear — that is what the sampler does with it, so the
 * selector must say so rather than showing nothing selected.
 */
export function activeEasingKind(kf: { easing?: EasingKind } | null | undefined): EasingKind {
  return kf?.easing ?? 'linear';
}

/**
 * The `EasingKind` a keyframe ends up carrying after `preset` is applied —
 * i.e. what `applyEasingToKeyframes` actually writes.
 *
 * Every library curve and every Easy Ease variant is stored as a bezier; only
 * Linear and Hold land on a kind of their own.
 */
export function easingKindForPreset(preset: EasingPreset): EasingKind {
  switch (preset) {
    case 'Linear':
      return 'linear';
    // The scalar store spells hold 'step'; see the header.
    case 'Hold':
      return 'step';
    default:
      return 'bezier';
  }
}

/**
 * The preset a kind corresponds to, or null when the kind has no named
 * equivalent.
 *
 * Null is the common answer and is not a gap: 'ease', 'easeIn', 'easeOut',
 * 'easeInOut', 'autoBezier' and 'continuousBezier' are curves the sampler
 * computes, not curves the preset table stores, and 'bezier' is "whatever
 * handles this keyframe happens to carry" — which is a shape, not a name.
 */
export function easingPresetForKind(kind: EasingKind): EasingPreset | null {
  if (kind === 'linear') return 'Linear';
  if (isHoldKind(kind)) return 'Hold';
  return null;
}

/**
 * Apply an interpolation KIND to a set of keyframe ids, as one undo step.
 *
 * The kind counterpart of `applyEasingToKeyframes`, and it reaches the same
 * places that does: a merged "Position" id expands to its x/y/z tracks, and
 * data tracks (puppet pins, gradient stops, mask paths) are written through
 * `setDataEasing` instead of being silently skipped.
 */
export function applyEasingKindToKeyframes(
  kfIds: ReadonlyArray<string>,
  kind: EasingKind,
  engine: AnimationEngine = defaultAnimation,
): void {
  if (kfIds.length === 0) return;
  runAnimEdit(`Set keyframe easing: ${EASING_KIND_LABEL[kind]}`, () => {
    for (const kfId of kfIds) {
      const ref = parseKeyframeId(kfId);
      if (!ref) continue;
      const { nodeId, t } = ref;
      for (const prop of expandKeyframeProp(ref.prop)) {
        // Data tracks first: they have no scalar keyframes, so the scalar
        // lookup below would find nothing and the click would do nothing.
        const dataTrack = engine.getDataTrack(nodeId, prop);
        if (dataTrack) {
          const dk = dataTrack.keyframes.find((k) => Math.abs(k.t - t) < 1e-6);
          if (dk) engine.setDataEasing(nodeId, prop, dk.t, kind);
          continue;
        }
        const kfs = engine.getTrackKeyframes(nodeId, prop);
        const kf = kfs?.find((k) => Math.abs(k.t - t) < 1e-6);
        if (!kf) continue;
        engine.setEasing(nodeId, prop, kf.t, kind);
      }
    }
  });
}
