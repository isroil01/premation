/**
 * PER-CUT TRANSITIONS — a dissolve you can point at, rather than one you can
 * only re-derive.
 *
 * ## Why a record, when the crossfade already existed
 *
 * `TimelineController.writeCrossfades` has written cross-dissolves since
 * Sequence Layers shipped, and it does the job perfectly — once. What it leaves
 * behind is four opacity keyframes and two bars that happen to overlap, and
 * nothing anywhere says those seven facts are ONE thing. So the dissolve cannot
 * be selected, cannot be lengthened (you would have to re-derive which
 * keyframes belonged to it and how far the bars had been pushed), cannot be
 * removed without guessing what the opacity track held before, and cannot be
 * changed to a dip without doing all three by hand.
 *
 * A TRANSITION RECORD is the missing noun. It is small and declarative — which
 * cut, which kind, how long, how it sits on the cut — and everything visible is
 * MATERIALISED from it. That gives the three operations the UI actually needs:
 *
 *   • materialise — move the bars, write the keyframes / effects;
 *   • dematerialise — put back exactly what was there before;
 *   • change — dematerialise then materialise, in ONE undo entry.
 *
 * The record is the authority; the keyframes are its output. Anything derived
 * the other way round (scanning opacity tracks for something that looks like a
 * ramp) would misread a hand-authored fade as a transition and delete it.
 *
 * ## Exact restore, and what it costs
 *
 * `dematerialize` restores a SNAPSHOT captured at materialise time — bars,
 * keyframe tracks, effect stacks — copied verbatim, exactly as
 * `assistantPreview.beginTrackPreview` copies keyframes before The Smoother
 * touches them. It is not an inverse computed from the record, because these
 * writes are lossy: `setKeyframe` overwrites whatever sat at that time, and the
 * only faithful "before" is the array we kept.
 *
 * The honest cost of that choice: hand-edits made to the two layers' opacity
 * (or to the transition's own effect) AFTER the transition was applied are
 * discarded when it is removed. Restoring a remembered "before" and preserving
 * later edits to the same tracks are mutually exclusive, and of the two, being
 * able to take a transition off cleanly is the one a user relies on. The
 * snapshot travels INSIDE the record so it survives a save/reload — a
 * transition you cannot remove tomorrow is not much of a transition.
 *
 * ## Time units
 *
 * `durationFrames` is FRAMES, like everything else about a clip bar. Keyframes
 * are written on `compToKeyframeTime`'s axis, which is the only axis the
 * renderer samples — the same rule, and the same reasons, as `writeCrossfades`.
 *
 * ## Dip to white, and the solid layer that is not there
 *
 * A dip to BLACK is opacity: both layers ramp to nothing at the cut and the
 * composition background shows through, which is black by default and is
 * exactly what the name says.
 *
 * A dip to WHITE cannot be, because opacity 0 reveals the background, not
 * white. The two ways out are a white solid layer behind the pair, or a white
 * FILL on the layers themselves. This takes the fill: it needs no scene node
 * created, ordered beneath two specific layers, kept in step with them and
 * deleted again on removal (four chances to leave a stray solid in someone's
 * comp), it reads white over ANY background rather than only over a black one,
 * and it removes as cleanly as it applies — the effect stack is part of the
 * snapshot this module already takes. The trade is that the layers turn white
 * rather than disappearing, which is what a dip to white looks like anyway.
 */

import {
  
  
  
  
  effectPropPath,
} from '@core/effects/effects';
import {
  
  
  
  type TransitionRecord,
  type TransitionKind,
  type TransitionAlignment,
  
} from './transitionModel';
export {
  newTransitionId,
  TRANSITION_LABEL,
  TRANSITION_SHORT,
  TRANSITION_KINDS,
  DEFAULT_TRANSITION_FRAMES,
} from './transitionModel';
export type {
  TransitionRecord,
  TransitionKind,
  TransitionAlignment,
  TransitionSnapshot,
} from './transitionModel';

/** The two kinds that need the bars to OVERLAP; the dips do not. */
export function transitionOverlaps(kind: TransitionKind): boolean {
  return kind === 'crossDissolve' || kind === 'wipe';
}

/**
 * The transition's region on the comp axis, in frames either side of the cut.
 *
 * One conversion for all four kinds, so "centred" cannot come to mean two
 * different things depending on which kind is asked. For the overlapping kinds
 * `before` is what the RIGHT bar must gain at its head and `after` what the
 * LEFT bar must gain at its tail; for the dips they are simply the two ramps'
 * lengths, and a zero-length side writes no ramp at all.
 */
export function transitionRegion(
  durationFrames: number,
  alignment: TransitionAlignment,
): { before: number; after: number } {
  const n = Math.max(1, Math.round(durationFrames));
  if (alignment === 'startAtCut') return { before: 0, after: n };
  if (alignment === 'endAtCut') return { before: n, after: 0 };
  const before = Math.floor(n / 2);
  return { before, after: n - before };
}

/**
 * The effect ids a transition owns, derived from the record's id.
 *
 * Deterministic on purpose: `dematerialize` restores the whole effect STACK
 * from the snapshot, but the animation tracks driving those effects are keyed
 * by path, and a path can only be cleared if its id can be recomputed. A random
 * id stored nowhere would leave orphan keyframe tracks behind on every removal.
 */
export function transitionEffectId(rec: Pick<TransitionRecord, 'id'>, side: 'l' | 'r'): string {
  return `tx_${rec.id}_${side}`;
}

/** Every animation prop path this record's kind writes. */
export function transitionProps(rec: TransitionRecord): Array<{ nodeId: string; prop: string }> {
  switch (rec.kind) {
    case 'crossDissolve':
    case 'dipToBlack':
      return [
        { nodeId: rec.leftNodeId, prop: 'opacity' },
        { nodeId: rec.rightNodeId, prop: 'opacity' },
      ];
    case 'dipToWhite':
      return [
        { nodeId: rec.leftNodeId, prop: effectPropPath(transitionEffectId(rec, 'l'), 'opacity') },
        { nodeId: rec.rightNodeId, prop: effectPropPath(transitionEffectId(rec, 'r'), 'opacity') },
      ];
    case 'wipe':
      return [
        { nodeId: rec.rightNodeId, prop: effectPropPath(transitionEffectId(rec, 'r'), 'completion') },
      ];
  }
}

// ── Materialise ─────────────────────────────────────────────────────

export type TransitionResult =
  | { ok: true; record: TransitionRecord }
  | { ok: false; reason: string };
