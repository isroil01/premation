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

import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import {
  addEffect,
  getNodeEffects,
  writeNodeEffects,
  updateEffectParam,
  effectPropPath,
} from '@core/effects/effects';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { HistoryService } from '@core/commands/HistoryService';
import { useHistoryStore } from '@stores/historyStore';
import { runAsOneHistoryEntry } from '@core/composition/compositeEdit';
import { getTimelineController, compToKeyframeTime } from './TimelineController';
import {
  useTransitionStore,
  newTransitionId,
  TRANSITION_LABEL,
  DEFAULT_TRANSITION_FRAMES,
  type TransitionRecord,
  type TransitionKind,
  type TransitionAlignment,
  type TransitionSnapshot,
} from './transitionStore';

// The record and its store live one module down, at the leaf, so that
// `cloudDocument` can read them without closing an import cycle through
// `compositeEdit` — see `transitionStore.ts`. Re-exported here so callers only
// ever have to know about `transitions.ts`.
export {
  useTransitionStore,
  newTransitionId,
  TRANSITION_LABEL,
  TRANSITION_SHORT,
  TRANSITION_KINDS,
  DEFAULT_TRANSITION_FRAMES,
} from './transitionStore';
export type {
  TransitionRecord,
  TransitionKind,
  TransitionAlignment,
  TransitionSnapshot,
} from './transitionStore';

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

/** The composition a transition belongs to — the one owning the left bar. */
export function compIdForTransition(rec: Pick<TransitionRecord, 'leftNodeId'>): string {
  return getTimelineController().compIdForNode(rec.leftNodeId);
}

/** Any transition already sitting on this cut. */
export function transitionAtCut(
  compId: string,
  leftNodeId: string,
  rightNodeId: string,
): TransitionRecord | undefined {
  return useTransitionStore
    .getState()
    .list(compId)
    .find((t) => t.leftNodeId === leftNodeId && t.rightNodeId === rightNodeId);
}

/** Every transition touching a scene node, on either side of its cut. */
export function transitionsForNode(compId: string, nodeId: string): TransitionRecord[] {
  return useTransitionStore
    .getState()
    .list(compId)
    .filter((t) => t.leftNodeId === nodeId || t.rightNodeId === nodeId);
}

// ── Materialise ─────────────────────────────────────────────────────

export type TransitionResult =
  | { ok: true; record: TransitionRecord }
  | { ok: false; reason: string };

const plural = (n: number): string => (n === 1 ? '1 frame' : `${n} frames`);

/**
 * Can this record be materialised as written? Answered WITHOUT touching
 * anything, so a refusal never leaves a half-applied edit or an empty undo
 * entry behind.
 */
export function checkTransition(rec: TransitionRecord): { ok: true } | { ok: false; reason: string } {
  const controller = getTimelineController();
  const bars = controller.cutBarsFor(rec.leftNodeId, rec.rightNodeId);
  if (!bars) {
    return { ok: false, reason: 'Those two layers no longer meet at a cut.' };
  }
  if (bars.left.locked || bars.right.locked) {
    return { ok: false, reason: 'One of the two layers is locked.' };
  }
  if (!transitionOverlaps(rec.kind)) return { ok: true };

  const handles = controller.cutHandlesFor(rec.leftNodeId, rec.rightNodeId);
  if (!handles) return { ok: false, reason: 'Those two layers no longer meet at a cut.' };
  const { before, after } = transitionRegion(rec.durationFrames, rec.alignment);
  const label = TRANSITION_LABEL[rec.kind];
  if (after > handles.leftTail) {
    return {
      ok: false,
      reason:
        `Not enough handle for a ${plural(Math.round(rec.durationFrames))} ${label}: the outgoing clip ` +
        `has ${plural(handles.leftTail)} of source after its out-point and needs ${plural(after)}. ` +
        `Trim it shorter, shorten the transition, or align it to end at the cut.`,
    };
  }
  if (before > handles.rightHead) {
    return {
      ok: false,
      reason:
        `Not enough handle for a ${plural(Math.round(rec.durationFrames))} ${label}: the incoming clip ` +
        `has ${plural(handles.rightHead)} of source before its in-point and needs ${plural(before)}. ` +
        `Trim it shorter, shorten the transition, or align it to start at the cut.`,
    };
  }
  return { ok: true };
}

/**
 * Check `next` against the cut as it would be with `existing` taken off.
 *
 * Two things make the naive check wrong, and both bite immediately:
 *
 *   • a longer dissolve measured while the shorter one is still applied is
 *     measured against handles its own overlap has already eaten, so growing a
 *     transition refuses long before it should;
 *   • worse, `cutBarsFor` finds the pair by their SEAM, and an overlapping
 *     transition has already pushed the bars 8 frames past meeting — so with a
 *     dissolve in place the cut cannot be found at all, and every second
 *     operation on it is refused with "those two layers no longer meet".
 *
 * So the existing one is peeled off, the question asked of the bare cut, and it
 * is put straight back. Nothing is recorded: `silently` mutes both history
 * mechanisms, and re-materialising `existing` restores the exact state the peel
 * removed — which is why its own snapshot stays valid and is deliberately kept
 * rather than replaced by the throwaway record the re-materialise returns.
 */
function checkAgainstBareCut(
  existing: TransitionRecord | undefined,
  next: TransitionRecord,
): { ok: boolean; reason: string } {
  if (!existing) {
    const v = checkTransition(next);
    return { ok: v.ok, reason: v.ok ? '' : v.reason };
  }
  const verdict: { ok: boolean; reason: string } = { ok: true, reason: '' };
  silently(() => {
    dematerializeTransition(existing);
    const v = checkTransition(next);
    verdict.ok = v.ok;
    verdict.reason = v.ok ? '' : v.reason;
    materializeTransition(existing);
  });
  return verdict;
}

/** Copy everything this record is about to overwrite. */
function captureBefore(rec: TransitionRecord): TransitionSnapshot {
  const controller = getTimelineController();
  const nodes = [rec.leftNodeId, rec.rightNodeId];
  return {
    bars: controller.captureClipBars(nodes),
    tracks: transitionProps(rec).map(({ nodeId, prop }) => ({
      nodeId,
      prop,
      // `getTrackKeyframes` hands back copies already; the clone is against a
      // future engine that stops doing so, since this array IS the undo state.
      keyframes: (defaultAnimation.getTrackKeyframes(nodeId, prop) ?? []).map((k) => ({ ...k })),
    })),
    effects: nodes.map((nodeId) => ({ nodeId, stack: structuredClone(getNodeEffects(nodeId)) })),
  };
}

/**
 * Comp frame → the axis the renderer samples for this node.
 *
 * ## The exclusive-end trap
 *
 * A bar's `end` is EXCLUSIVE, and `compToKeyframeTime` finds the governing clip
 * with `isActiveAt` — so asking it for the bar's end frame finds no clip and
 * falls through to identity, returning a time that has nothing to do with the
 * bar's source window. Every outgoing ramp lands on exactly that frame: a
 * dissolve ends where the clip ends.
 *
 * Left alone, the keyframe is written on the wrong axis and the fade plays
 * somewhere else entirely — and the failure hides, because a bar that has not
 * MOVED maps identically either way (the same coincidence
 * `sequenceCrossfade.test.ts` records catching in its own harness). It only
 * surfaces on a bar the overlap has just displaced, which is every bar a
 * transition touches.
 *
 * So `atBarEnd` maps the last frame that IS inside the bar and steps one frame
 * on from there — the bar's own mapping continued by one frame, rather than the
 * fall-through's unrelated answer.
 */
function kfTime(nodeId: string, frame: number, fps: number, atBarEnd = false): number {
  if (!atBarEnd) return compToKeyframeTime(nodeId, frame / fps);
  return compToKeyframeTime(nodeId, (frame - 1) / fps) + 1 / fps;
}

/**
 * Apply a record: move the bars, write the ramps.
 *
 * Returns the record with its `before` snapshot filled in — the caller must
 * store THAT one, because it is the only copy of the state removal has to
 * restore.
 */
export function materializeTransition(rec: TransitionRecord): TransitionResult {
  const check = checkTransition(rec);
  if (!check.ok) return check;

  const controller = getTimelineController();
  const handles = controller.cutHandlesFor(rec.leftNodeId, rec.rightNodeId);
  if (!handles) return { ok: false, reason: 'Those two layers no longer meet at a cut.' };
  const cutFrame = handles.cutFrame;
  const { before, after } = transitionRegion(rec.durationFrames, rec.alignment);
  const fps = controller.fpsForNode(rec.leftNodeId) || 30;
  const snapshot = captureBefore(rec);

  const startFrame = cutFrame - before;
  const endFrame = cutFrame + after;

  if (transitionOverlaps(rec.kind)) {
    // `after` frames of the LEFT bar's tail, `before` of the RIGHT bar's head —
    // see transitionRegion. One engine entry for both bars.
    controller.overlapCutBars(rec.leftNodeId, rec.rightNodeId, after, before);
  }

  switch (rec.kind) {
    case 'crossDissolve': {
      // Written exactly as `writeCrossfades` does, and AFTER the bars have
      // moved: `compToKeyframeTime` depends on where the bar now is, so the
      // same call before the overlap would place the ramp on the old geometry.
      runAnimEdit(TRANSITION_LABEL[rec.kind], () => {
        defaultAnimation.setKeyframe(rec.leftNodeId, 'opacity', kfTime(rec.leftNodeId, startFrame, fps), 100);
        // `true`: this frame IS the outgoing bar's exclusive end — see kfTime.
        defaultAnimation.setKeyframe(rec.leftNodeId, 'opacity', kfTime(rec.leftNodeId, endFrame, fps, true), 0);
        defaultAnimation.setKeyframe(rec.rightNodeId, 'opacity', kfTime(rec.rightNodeId, startFrame, fps), 0);
        defaultAnimation.setKeyframe(rec.rightNodeId, 'opacity', kfTime(rec.rightNodeId, endFrame, fps), 100);
      });
      break;
    }
    case 'dipToBlack': {
      // No overlap: the left bar still ends at the cut and the right still
      // starts there. Each side ramps its own half, and a zero-length half
      // (startAtCut / endAtCut) writes nothing rather than two keyframes at one
      // time, which is not a ramp and would read as a stray keyframe forever.
      runAnimEdit(TRANSITION_LABEL[rec.kind], () => {
        if (before > 0) {
          defaultAnimation.setKeyframe(rec.leftNodeId, 'opacity', kfTime(rec.leftNodeId, startFrame, fps), 100);
          defaultAnimation.setKeyframe(rec.leftNodeId, 'opacity', kfTime(rec.leftNodeId, cutFrame, fps, true), 0);
        }
        if (after > 0) {
          defaultAnimation.setKeyframe(rec.rightNodeId, 'opacity', kfTime(rec.rightNodeId, cutFrame, fps), 0);
          defaultAnimation.setKeyframe(rec.rightNodeId, 'opacity', kfTime(rec.rightNodeId, endFrame, fps), 100);
        }
      });
      break;
    }
    case 'dipToWhite': {
      // A white FILL rather than a solid layer — see the module docstring. The
      // layers stay fully opaque and turn white, so the dip reads white on any
      // background and removal is a stack restore rather than a node delete.
      const leftFx = transitionEffectId(rec, 'l');
      const rightFx = transitionEffectId(rec, 'r');
      if (before > 0) {
        addEffect(rec.leftNodeId, 'fill', leftFx);
        updateEffectParam(rec.leftNodeId, leftFx, 'color', '#ffffff');
        updateEffectParam(rec.leftNodeId, leftFx, 'opacity', 0);
      }
      if (after > 0) {
        addEffect(rec.rightNodeId, 'fill', rightFx);
        updateEffectParam(rec.rightNodeId, rightFx, 'color', '#ffffff');
        updateEffectParam(rec.rightNodeId, rightFx, 'opacity', 0);
      }
      runAnimEdit(TRANSITION_LABEL[rec.kind], () => {
        if (before > 0) {
          const p = effectPropPath(leftFx, 'opacity');
          defaultAnimation.setKeyframe(rec.leftNodeId, p, kfTime(rec.leftNodeId, startFrame, fps), 0);
          defaultAnimation.setKeyframe(rec.leftNodeId, p, kfTime(rec.leftNodeId, cutFrame, fps, true), 100);
        }
        if (after > 0) {
          const p = effectPropPath(rightFx, 'opacity');
          defaultAnimation.setKeyframe(rec.rightNodeId, p, kfTime(rec.rightNodeId, cutFrame, fps), 100);
          defaultAnimation.setKeyframe(rec.rightNodeId, p, kfTime(rec.rightNodeId, endFrame, fps), 0);
        }
      });
      break;
    }
    case 'wipe': {
      // The registry's own Linear Wipe, on the INCOMING clip, over the overlap
      // the two bars now share. `completion` runs 100 (nothing showing) → 0
      // (fully arrived), so the outgoing clip is revealed underneath for
      // exactly as long as the wipe takes. No opacity is touched at all — a
      // wipe that also faded would be two transitions wearing one name.
      const rightFx = transitionEffectId(rec, 'r');
      addEffect(rec.rightNodeId, 'linear-wipe', rightFx);
      updateEffectParam(rec.rightNodeId, rightFx, 'completion', 100);
      runAnimEdit(TRANSITION_LABEL[rec.kind], () => {
        const p = effectPropPath(rightFx, 'completion');
        defaultAnimation.setKeyframe(rec.rightNodeId, p, kfTime(rec.rightNodeId, startFrame, fps), 100);
        defaultAnimation.setKeyframe(rec.rightNodeId, p, kfTime(rec.rightNodeId, endFrame, fps), 0);
      });
      break;
    }
  }

  return { ok: true, record: { ...rec, before: snapshot } };
}

/**
 * Put the two layers back exactly as they were before `rec` was applied.
 *
 * Order matters: effects first (the stack restore removes the transition's own
 * effect, so the tracks cleared next belong to nothing), then the keyframe
 * tracks, then the bars — geometry last, because `compToKeyframeTime` reads it
 * and nothing after this point needs the pre-restore mapping.
 */
export function dematerializeTransition(rec: TransitionRecord): void {
  const snapshot = rec.before;
  if (!snapshot) return;
  for (const entry of snapshot.effects) {
    writeNodeEffects(entry.nodeId, structuredClone(entry.stack));
  }
  runAnimEdit(`Remove ${TRANSITION_LABEL[rec.kind]}`, () => {
    for (const track of snapshot.tracks) {
      defaultAnimation.setTrackKeyframes(
        track.nodeId,
        track.prop,
        track.keyframes.length ? track.keyframes.map((k) => ({ ...k })) : null,
      );
    }
  });
  getTimelineController().restoreClipBars(snapshot.bars);
}

// ── Undoable operations (one entry each) ─────────────────────────────

/**
 * Every transition op crosses BOTH history mechanisms — clip geometry lives on
 * the engine's command stack, keyframes and the effect stack on the app's
 * snapshot — which is exactly the case `runAsOneHistoryEntry` exists for. It
 * also captures the transition STORE, because `captureDocument` now carries it,
 * so undo puts the record back as well as the pixels it produced.
 */
export async function addTransition(
  leftNodeId: string,
  rightNodeId: string,
  kind: TransitionKind,
  durationFrames: number = DEFAULT_TRANSITION_FRAMES,
  alignment: TransitionAlignment = 'centred',
): Promise<{ ok: true; record: TransitionRecord } | { ok: false; reason: string }> {
  const compId = getTimelineController().compIdForNode(leftNodeId);
  const draft: TransitionRecord = {
    id: newTransitionId(),
    leftNodeId,
    rightNodeId,
    kind,
    durationFrames: Math.max(1, Math.round(durationFrames)),
    alignment,
  };
  const existing = transitionAtCut(compId, leftNodeId, rightNodeId);
  // Checked BEFORE the history entry is opened, so a refusal leaves no undo
  // step describing an edit that never happened.
  const check = checkAgainstBareCut(existing, draft);
  if (!check.ok) return { ok: false, reason: check.reason };
  // A holder rather than a bare `let`: the assignment happens inside a callback,
  // where TypeScript's narrowing cannot follow it.
  const out: { record: TransitionRecord | null } = { record: null };
  await runAsOneHistoryEntry(`Add ${TRANSITION_LABEL[kind]}`, () => {
    if (existing) {
      dematerializeTransition(existing);
      useTransitionStore.getState().drop(compId, existing.id);
    }
    const res = materializeTransition(draft);
    if (res.ok) {
      out.record = res.record;
      useTransitionStore.getState().put(compId, res.record);
    }
  });
  const made = out.record;
  return made ? { ok: true, record: made } : { ok: false, reason: 'The transition could not be applied.' };
}

/** Change a transition's duration, kind or alignment — one undo entry. */
export async function setTransition(
  compId: string,
  id: string,
  patch: Partial<Pick<TransitionRecord, 'kind' | 'durationFrames' | 'alignment'>>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const current = useTransitionStore.getState().find(compId, id);
  if (!current) return { ok: false, reason: 'That transition no longer exists.' };
  const next: TransitionRecord = {
    ...current,
    ...patch,
    ...(patch.durationFrames !== undefined
      ? { durationFrames: Math.max(1, Math.round(patch.durationFrames)) }
      : {}),
  };
  delete next.before;

  const verdict = checkAgainstBareCut(current, next);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  await runAsOneHistoryEntry(`Change ${TRANSITION_LABEL[next.kind]}`, () => {
    dematerializeTransition(current);
    const res = materializeTransition(next);
    if (res.ok) useTransitionStore.getState().put(compId, res.record);
    else useTransitionStore.getState().drop(compId, id);
  });
  return { ok: true };
}

/** Remove a transition and restore what the cut held before it. */
export async function removeTransition(compId: string, id: string): Promise<boolean> {
  const current = useTransitionStore.getState().find(compId, id);
  if (!current) return false;
  await runAsOneHistoryEntry(`Remove ${TRANSITION_LABEL[current.kind]}`, () => {
    dematerializeTransition(current);
    useTransitionStore.getState().drop(compId, id);
  });
  return true;
}

// ── Live preview (dragging a transition's end) ───────────────────────

/**
 * Run `fn` with BOTH history mechanisms muted.
 *
 * The same guard pair `runAsOneHistoryEntry` and `splitLayerAtFrame` use, held
 * open for a single call instead of a whole operation: a drag applies dozens of
 * these and not one of them is an edit the user made — only the release is.
 */
function silently(fn: () => void): void {
  let history: HistoryService | null = null;
  try {
    history = getCommandSystem().getHistory();
  } catch {
    history = null; // headless: no CommandSystem
  }
  history?.suspend();
  try {
    useHistoryStore.getState().runRestoring(fn);
  } finally {
    history?.resume();
  }
}

/** What the in-flight drag has painted, so the next step can undo its own work. */
let livePreview: { compId: string; id: string; painted: TransitionRecord } | null = null;

/**
 * Repaint a transition at a trial duration, recording nothing.
 *
 * The STORE is deliberately not touched: the record it holds is the "before"
 * that {@link commitTransitionPreview} restores to and that
 * `runAsOneHistoryEntry` then captures, so a preview that updated it would make
 * undo return to the last previewed frame instead of to where the drag began.
 */
export function previewTransition(compId: string, id: string, durationFrames: number): void {
  const stored = useTransitionStore.getState().find(compId, id);
  if (!stored) return;
  const from = livePreview && livePreview.id === id ? livePreview.painted : stored;
  const trial: TransitionRecord = {
    ...stored,
    durationFrames: Math.max(1, Math.round(durationFrames)),
  };
  delete trial.before;
  silently(() => {
    dematerializeTransition(from);
    const res = materializeTransition(trial);
    // A trial that outruns the handles paints the last good one back, so the
    // bracket stops at the limit instead of vanishing mid-drag.
    livePreview = { compId, id, painted: res.ok ? res.record : materializeOrKeep(from) };
  });
}

function materializeOrKeep(rec: TransitionRecord): TransitionRecord {
  const res = materializeTransition(rec);
  return res.ok ? res.record : rec;
}

/**
 * End a preview: unpaint it, put the original back, then apply the final
 * duration as ONE undo entry. Pass `null` to abandon the drag entirely.
 */
export async function commitTransitionPreview(
  compId: string,
  id: string,
  durationFrames: number | null,
): Promise<void> {
  const painted = livePreview && livePreview.id === id ? livePreview.painted : null;
  livePreview = null;
  const stored = useTransitionStore.getState().find(compId, id);
  if (painted && stored) {
    // Back to exactly where the drag started, so the entry below captures the
    // right "before". Nothing here is recorded.
    silently(() => {
      dematerializeTransition(painted);
      materializeTransition(stored);
    });
  }
  if (durationFrames === null || !stored) return;
  if (Math.max(1, Math.round(durationFrames)) === stored.durationFrames) return;
  await setTransition(compId, id, { durationFrames });
}

/** Test seam — forget any in-flight preview. */
export function resetTransitionPreviewForTest(): void {
  livePreview = null;
}
