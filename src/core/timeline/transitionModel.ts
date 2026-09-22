/**
 * The transition RECORD — the data half of what used to be `transitionStore.ts`.
 *
 * The zustand store that holds these records now lives in
 * `src/stores/transitionStore.ts` (T0 boundary: `src/core` does not import
 * zustand — see docs/NATIVE_CORE_PLAN.md §4 T0). This module is the leaf both
 * sides share: types, the label tables, the default length and the id
 * generator. It imports nothing at runtime, so the import-cycle reasoning in
 * `transitions.ts` still holds — `cloudDocument` can read the store without
 * closing a cycle through `compositeEdit`.
 *
 * `transitions.ts` re-exports every name below, so callers never need to know
 * the split exists.
 */

import type { Keyframe } from '@motion/animation';
import type { Effect } from '@core/effects/effects';
import type { ClipBarSnapshot } from './TimelineController';

export type TransitionKind = 'crossDissolve' | 'dipToBlack' | 'dipToWhite' | 'wipe';

/**
 * Where the transition sits relative to the cut.
 *
 * `centred` splits it either side (the NLE default, and the only one that keeps
 * both clips' framing), `startAtCut` puts all of it after the cut, `endAtCut`
 * all of it before. The same three words mean the same three things for every
 * kind: `transitionRegion` converts them once, and the kinds differ only in what
 * they DO with the region.
 */
export type TransitionAlignment = 'centred' | 'startAtCut' | 'endAtCut';

/** Bars, keyframe tracks and effect stacks, copied verbatim. */
export interface TransitionSnapshot {
  bars: ClipBarSnapshot[];
  /** One entry per prop path the transition writes. */
  tracks: Array<{ nodeId: string; prop: string; keyframes: Keyframe[] }>;
  effects: Array<{ nodeId: string; stack: Effect[] }>;
}

export interface TransitionRecord {
  id: string;
  /** The scene node whose bar ENDS at the cut. */
  leftNodeId: string;
  /** The scene node whose bar STARTS at the cut. */
  rightNodeId: string;
  kind: TransitionKind;
  /** Length in FRAMES (bars are frames; comp times are seconds). */
  durationFrames: number;
  alignment: TransitionAlignment;
  /**
   * Exactly what the two layers held before this transition was materialised.
   * Written by `materializeTransition`; read by `dematerializeTransition`, and
   * persisted with the record so a transition stays removable after a reload.
   */
  before?: TransitionSnapshot;
}

export const TRANSITION_LABEL: Readonly<Record<TransitionKind, string>> = {
  crossDissolve: 'Cross Dissolve',
  dipToBlack: 'Dip to Black',
  dipToWhite: 'Dip to White',
  wipe: 'Wipe',
};

/** Short form for the label drawn on the bracket in the timeline. */
export const TRANSITION_SHORT: Readonly<Record<TransitionKind, string>> = {
  crossDissolve: 'Dissolve',
  dipToBlack: 'Dip Black',
  dipToWhite: 'Dip White',
  wipe: 'Wipe',
};

/** The order the palette chips and the Add Transition submenu are drawn in. */
export const TRANSITION_KINDS: ReadonlyArray<TransitionKind> = [
  'crossDissolve',
  'dipToBlack',
  'dipToWhite',
  'wipe',
];

/** AE's default transition length, and what a double-click on a cut applies. */
export const DEFAULT_TRANSITION_FRAMES = 12;

let seq = 0;
export function newTransitionId(): string {
  seq += 1;
  return `tx${Date.now().toString(36)}${seq.toString(36)}`;
}
