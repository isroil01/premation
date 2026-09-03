/**
 * The last choreography run on each composition — so it can be edited instead
 * of undone.
 *
 * Animate In/Out and Stagger used to be strictly one-shot: they wrote
 * keyframes and forgot everything about how. If the rhythm was a frame too
 * slow, or the layers should have arrived from the left instead of in
 * selection order, the only move was Ctrl+Z and a second guess from a menu
 * that exposes none of those numbers. This store is what makes them
 * PARAMETRIC — it remembers the params, the layers, and, crucially, the exact
 * keyframes the run overwrote, so a re-apply can put the composition back
 * where it started before laying down the new plan.
 *
 * ── Why per composition, not per selection or per frame ─────────────
 * "The last choreography" is a property of the board you are working on. Keyed
 * by selection it would vanish the moment you clicked a layer to inspect it —
 * which is exactly when you want to nudge the rhythm. Keyed by nothing it
 * would follow you across boards and offer to re-apply layers that are not
 * there. One record per comp, replaced on every apply, is the granularity that
 * matches how the panel is used.
 *
 * ── Not persisted ───────────────────────────────────────────────────
 * In-session only, deliberately. The record holds a verbatim copy of keyframes
 * that a project reload would make meaningless (layer ids are not stable
 * across a reopen), and a "Re-apply" button that silently restores a stale
 * capture is worse than one that is simply absent. The params survive as
 * `lastParams` for as long as the app is open, which is what the Stagger menu
 * entry needs.
 */

import { create } from 'zustand';
import type {
  CapturedTrack,
  ChoreoInstall,
  StaggerParams,
} from '@core/animation/choreography';
import type { EntranceArchetype } from '@core/animation/entranceArchetypes';

/** Which gesture wrote the record. `stagger` shifts existing keyframes. */
export type ChoreographyKind = 'in' | 'out' | 'stagger';

export interface ChoreographyRecord {
  readonly kind: ChoreographyKind;
  readonly params: StaggerParams;
  /** The layers the run touched, in the order they were handed to the planner. */
  readonly nodeIds: readonly string[];
  /** Composition seconds the choreography is anchored at. */
  readonly atCompTime: number;
  readonly fps: number;
  /**
   * Every affected track exactly as it stood BEFORE the first apply — the only
   * faithful "before" for a generator that deletes and re-tangents keyframes.
   * `keyframes: null` means the property had no track and restoring removes it.
   */
  readonly captured: readonly CapturedTrack[];
  /** Blur effects and text animators the run installed, for reuse on re-apply. */
  readonly installs: Readonly<Record<string, ChoreoInstall>>;
  /** The keyframe-axis span the run wrote into, or null when it wrote none. */
  readonly range: { readonly start: number; readonly end: number } | null;
  /** Per-layer offsets actually used, whole frames, in `nodeIds` order. */
  readonly offsetFrames: readonly number[];
  /** The entrance chosen per layer — empty for `stagger`, which picks none. */
  readonly archetypes: readonly EntranceArchetype[];
  readonly keyframes: number;
  /** `Date.now()` of the most recent (re-)apply. */
  readonly at: number;
}

interface ChoreographyState {
  /** compositionId → its last choreography. */
  readonly byComp: Readonly<Record<string, ChoreographyRecord>>;
  /**
   * The parameters the next gesture starts from, wherever it is triggered.
   *
   * Global rather than per comp because it is a working preference, not a
   * property of a board: the Stagger menu entry has no dialog and must apply
   * *something*, and "what you last chose" is the only answer that does not
   * quietly ignore the panel sitting open next to it.
   *
   * `null` until something has actually been applied — "last used" has to mean
   * used. A caller that gets `null` is free to pick a default that suits it,
   * and the Stagger menu entry's does: it keeps promising 0.3s until someone
   * has told it otherwise.
   */
  readonly lastParams: StaggerParams | null;
  record(compId: string, entry: ChoreographyRecord): void;
  clear(compId: string): void;
  setLastParams(params: StaggerParams): void;
}

export const useChoreographyStore = create<ChoreographyState>((set) => ({
  byComp: {},
  lastParams: null,
  // Recording is also what makes the params "last used": every apply and
  // re-apply goes through here, so the two can never drift apart.
  record: (compId, entry) =>
    set((s) => ({ byComp: { ...s.byComp, [compId]: entry }, lastParams: entry.params })),
  clear: (compId) =>
    set((s) => {
      if (!(compId in s.byComp)) return s;
      const next = { ...s.byComp };
      delete next[compId];
      return { byComp: next };
    }),
  setLastParams: (lastParams) => set({ lastParams }),
}));

/** The composition's last choreography, or undefined. Non-reactive. */
export function lastChoreography(compId: string | undefined): ChoreographyRecord | undefined {
  return compId ? useChoreographyStore.getState().byComp[compId] : undefined;
}

/** The parameters last applied, or null if none ever were. Non-reactive. */
export function lastStaggerParams(): StaggerParams | null {
  return useChoreographyStore.getState().lastParams;
}
