/**
 * The store that holds transition records — split out from `transitions.ts`
 * for one reason, and it is not tidiness.
 *
 * `transitions.ts` needs `runAsOneHistoryEntry`, which lives in
 * `compositeEdit.ts`, which captures and restores the whole editor document via
 * `cloudDocument.ts` — and `cloudDocument` has to read this store, because a
 * transition is authored state that belongs to the file. Keeping the store in
 * `transitions.ts` therefore closes a genuine import cycle
 * (transitions → compositeEdit → cloudDocument → transitions) whose resolution
 * order depends on which module the bundler happens to enter first.
 *
 * So the store lives here, at the leaf: zustand and nothing else at runtime.
 * The record type and its label tables are in
 * `src/core/timeline/transitionModel.ts` (type-only imports here, erased at
 * build time). `transitions.ts` re-exports every name, so callers never need
 * to know the split exists.
 */

import { create } from 'zustand';
import type { TransitionRecord } from '@core/timeline/transitionModel';

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
