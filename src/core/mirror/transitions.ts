/**
 * Cut transitions over the document MIRROR (B4) — the twins of
 * `core/timeline/transitions`' `transitionAtCut`, `compIdForTransition`,
 * `transitionOverlaps` and `transitionRegion`, reading a composition's
 * `MirrorComp.transitions` (the API's `Transition` records) instead of the
 * transition store. Pure: no engine, no store.
 *
 * The API states a transition's length in FLICKS (whole frames of its
 * composition); the timeline lays transitions out in FRAMES, as the legacy
 * record did. `transitionViewOf` converts once, keeping the record's field
 * names so the timeline's geometry (`layoutTransitions`) reads either.
 */

import { flicksToSeconds, type LayerInfo, type Transition, type TransitionAlignment, type TransitionKind } from '@motion/engine-api';

/** A transition as the timeline draws it: the cut's two layers, kind, length in frames, placement. */
export interface TransitionView {
  id: string;
  /** The layer whose bar ENDS at the cut. */
  leftNodeId: string;
  /** The layer whose bar STARTS at the cut. */
  rightNodeId: string;
  kind: TransitionKind;
  /** Length in FRAMES of the composition. */
  durationFrames: number;
  alignment: TransitionAlignment;
}

/** One API record as a view, at the composition's frame rate. */
export function transitionViewOf(t: Transition, fps: number): TransitionView {
  const rate = fps > 0 ? fps : 30;
  return {
    id: t.id,
    leftNodeId: t.left,
    rightNodeId: t.right,
    kind: t.kind,
    durationFrames: Math.max(1, Math.round(flicksToSeconds(t.duration) * rate)),
    alignment: t.alignment,
  };
}

const viewCache = new WeakMap<readonly Transition[], { fps: number; views: TransitionView[] }>();

/** A composition's transitions as views — the same array while its records and rate are unchanged. */
export function transitionViewsOf(transitions: readonly Transition[] | undefined, fps: number): TransitionView[] {
  if (!transitions || transitions.length === 0) return NO_VIEWS;
  const hit = viewCache.get(transitions);
  if (hit && hit.fps === fps) return hit.views;
  const views = transitions.map((t) => transitionViewOf(t, fps));
  viewCache.set(transitions, { fps, views });
  return views;
}

const NO_VIEWS: TransitionView[] = [];

/** The two kinds that need the bars to OVERLAP; the dips do not (the twin of `transitionOverlaps`). */
export function mirrorTransitionOverlaps(kind: TransitionKind): boolean {
  return kind === 'crossDissolve' || kind === 'wipe';
}

/**
 * The transition's region on the comp axis, in frames either side of the cut
 * (the twin of `transitionRegion`): centred splits it (the odd frame after),
 * `startAtCut` puts all of it after the cut, `endAtCut` all of it before.
 */
export function mirrorTransitionRegion(durationFrames: number, alignment: TransitionAlignment): { before: number; after: number } {
  const n = Math.max(1, Math.round(durationFrames));
  if (alignment === 'startAtCut') return { before: 0, after: n };
  if (alignment === 'endAtCut') return { before: n, after: 0 };
  const before = Math.floor(n / 2);
  return { before, after: n - before };
}

/** The composition a cut belongs to — the one owning its left layer (the twin of `compIdForTransition`). */
export function mirrorCompIdForTransition(m: { layer(id: string): LayerInfo | undefined }, cut: { leftNodeId: string }): string | undefined {
  return m.layer(cut.leftNodeId)?.comp;
}

/** The transition already sitting on this cut, if any (the twin of `transitionAtCut`). */
export function mirrorTransitionAtCut(
  m: { comp(id: string): { readonly transitions: readonly Transition[] } | undefined },
  compId: string | undefined,
  leftNodeId: string,
  rightNodeId: string,
): Transition | undefined {
  if (!compId) return undefined;
  return m.comp(compId)?.transitions.find((t) => t.left === leftNodeId && t.right === rightNodeId);
}
