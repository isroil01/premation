/**
 * subjectStore — which of a layer's subjects the Object Matte tool and the
 * Subjects panel are working on, how the next click picks, and how the
 * viewers show the subject.
 *
 * Editor state only (never in the document): the subjects themselves are the
 * layer's (core/workspace/subjects.ts).
 */

import { create } from 'zustand';
import { FIRST_SUBJECT, layerSubjects } from '@core/workspace/subjects';
import { useSelectionStore } from './selectionStore';

/**
 * How the viewers show the selected layer's subject (setViewport `subjectView`,
 * drawn by the engine through the subject's live edge): 'off' = as it renders.
 */
export type SubjectViewMode = 'off' | 'overlay' | 'black' | 'white' | 'alpha' | 'boundary';

export interface SubjectStoreState {
  /** The active subject per layer (layer id → subject id). */
  active: Record<string, string>;
  /**
   * Found objects nest (a jacket inside a person): how far in a click picks
   * from the largest object under the pointer. 0 = the whole; Tab / the wheel
   * step it while the tool is up.
   */
  depth: number;
  /** The view mode, and whether it shows every subject of the layer (false = the active one). */
  view: SubjectViewMode;
  viewAll: boolean;
  /** Subjects on footage that moves are tracked by themselves after each edit (layout/Workspace/autoTrack.ts). */
  autoTrack: boolean;
  setActive(layer: string, subject: string | null): void;
  setDepth(depth: number): void;
  setView(view: SubjectViewMode, all?: boolean): void;
  setAutoTrack(on: boolean): void;
}

export const useSubjectStore = create<SubjectStoreState>((set) => ({
  active: {},
  depth: 0,
  view: 'off',
  viewAll: false,
  autoTrack: true,
  setActive: (layer, subject) =>
    set((s) => {
      const active = { ...s.active };
      if (subject) active[layer] = subject;
      else delete active[layer];
      return { active };
    }),
  setDepth: (depth) => set({ depth: Math.max(0, Math.floor(depth)) }),
  setView: (view, all) => set((s) => ({ view, viewAll: all ?? s.viewAll })),
  setAutoTrack: (autoTrack) => set({ autoTrack }),
}));

/**
 * The subject brushes and Follow work on: the one made active (a click, the
 * Subjects panel), else the newest, else the first a layer gets.
 */
export function activeSubjectId(nodeId: string): string {
  const list = layerSubjects(nodeId);
  const stored = useSubjectStore.getState().active[nodeId];
  if (stored && list.some((s) => s.id === stored)) return stored;
  return list[list.length - 1]?.id ?? FIRST_SUBJECT;
}

export interface SubjectViewRequest {
  layer: string;
  /** Absent = every shown subject of the layer. */
  subject?: string;
  mode: Exclude<SubjectViewMode, 'off'>;
}

/**
 * What the viewers are asked to show now (setViewport `subjectView`): the view
 * mode on the one selected layer's active subject (or all of them), or null —
 * no mode, or no single layer with subjects selected.
 */
export function subjectViewNow(): SubjectViewRequest | null {
  const { view, viewAll } = useSubjectStore.getState();
  if (view === 'off') return null;
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 1) return null;
  const layer = ids[0]!;
  if (layerSubjects(layer).length === 0) return null;
  return viewAll ? { layer, mode: view } : { layer, subject: activeSubjectId(layer), mode: view };
}

/** Two subject views ask for the same frames. */
export function sameSubjectView(a: SubjectViewRequest | null, b: SubjectViewRequest | null): boolean {
  return a === b || (a !== null && b !== null && a.layer === b.layer && a.subject === b.subject && a.mode === b.mode);
}

/**
 * Calls `onChange` whenever what subjectViewNow() answers may have changed
 * (the mode, the active subject, the selection); the viewers then compare and
 * re-send their viewport. Returns the unsubscribe.
 */
export function subscribeSubjectView(onChange: () => void): () => void {
  const a = useSubjectStore.subscribe((s, p) => {
    if (s.view !== p.view || s.viewAll !== p.viewAll || s.active !== p.active) onChange();
  });
  const b = useSelectionStore.subscribe((s, p) => {
    if (s.ids !== p.ids && useSubjectStore.getState().view !== 'off') onChange();
  });
  return () => {
    a();
    b();
  };
}
