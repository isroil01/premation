/**
 * subjectStore — which of a layer's subjects the Object Matte tool and the
 * Subjects panel are working on, and how the next click picks.
 *
 * Editor state only (never in the document): the subjects themselves are the
 * layer's (core/workspace/subjects.ts).
 */

import { create } from 'zustand';
import { FIRST_SUBJECT, layerSubjects } from '@core/workspace/subjects';

export interface SubjectStoreState {
  /** The active subject per layer (layer id → subject id). */
  active: Record<string, string>;
  /**
   * Found objects nest (a jacket inside a person): how far in a click picks
   * from the largest object under the pointer. 0 = the whole; Tab / the wheel
   * step it while the tool is up.
   */
  depth: number;
  setActive(layer: string, subject: string | null): void;
  setDepth(depth: number): void;
}

export const useSubjectStore = create<SubjectStoreState>((set) => ({
  active: {},
  depth: 0,
  setActive: (layer, subject) =>
    set((s) => {
      const active = { ...s.active };
      if (subject) active[layer] = subject;
      else delete active[layer];
      return { active };
    }),
  setDepth: (depth) => set({ depth: Math.max(0, Math.floor(depth)) }),
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
