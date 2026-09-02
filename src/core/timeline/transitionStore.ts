/**
 * The transition RECORD and the store that holds it — split out from
 * `transitions.ts` for one reason, and it is not tidiness.
 *
 * `transitions.ts` needs `runAsOneHistoryEntry`, which lives in
 * `compositeEdit.ts`, which captures and restores the whole editor document via
 * `cloudDocument.ts` — and `cloudDocument` has to read this store, because a
 * transition is authored state that belongs to the file. Keeping the store in
 * `transitions.ts` therefore closes a genuine import cycle
 * (transitions → compositeEdit → cloudDocument → transitions) whose resolution
 * order depends on which module the bundler happens to enter first.
 *
 * So the DATA lives here, at the leaf: zustand and nothing else at runtime.
 * `transitions.ts` re-exports every name below, so callers never need to know
 * the split exists.
 */

import { create } from 'zustand';
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

interface TransitionStore {
  /** composition id → its transitions, in creation order. */
  byComp: Record<string, TransitionRecord[]>;
  list(compId: string): ReadonlyArray<TransitionRecord>;
  find(compId: string, id: string): TransitionRecord | undefined;
  put(compId: string, rec: TransitionRecord): void;
  drop(compId: string, id: string): void;
  /** For the document capture — a deep copy, so the doc cannot alias the store. */
  capture(): Record<string, TransitionRecord[]>;
  restore(next: Record<string, TransitionRecord[]> | undefined | null): void;
  clear(): void;
}

export const useTransitionStore = create<TransitionStore>((set, get) => ({
  byComp: {},
  list: (compId) => get().byComp[compId] ?? [],
  find: (compId, id) => (get().byComp[compId] ?? []).find((t) => t.id === id),
  put: (compId, rec) =>
    set((s) => {
      const existing = s.byComp[compId] ?? [];
      const next = existing.some((t) => t.id === rec.id)
        ? existing.map((t) => (t.id === rec.id ? rec : t))
        : [...existing, rec];
      return { byComp: { ...s.byComp, [compId]: next } };
    }),
  drop: (compId, id) =>
    set((s) => ({
      byComp: { ...s.byComp, [compId]: (s.byComp[compId] ?? []).filter((t) => t.id !== id) },
    })),
  capture: () => structuredClone(get().byComp),
  // Assigned unconditionally when a map is supplied, including an empty one: a
  // project opened after one that had transitions must not inherit them.
  restore: (next) => set({ byComp: next ? structuredClone(next) : {} }),
  clear: () => set({ byComp: {} }),
}));

let seq = 0;
export function newTransitionId(): string {
  seq += 1;
  return `tx${Date.now().toString(36)}${seq.toString(36)}`;
}
