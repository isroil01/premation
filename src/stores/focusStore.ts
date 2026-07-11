/**
 * Focus Mode / precomp navigation (spec §Focus Mode & Precomposition).
 *
 * Two related ideas share one navigation stack:
 *   - Enter a precomp/group "in place": push it onto `path`. The parent
 *     renders ghosted around the focused subtree — you never lose context.
 *   - Isolate a single layer: set `isolatedId`. Everything else ghosts.
 *
 * A breadcrumb (Main › Scene 2 › Logo) always shows location. `Esc` steps up
 * one level; clicking a breadcrumb jumps directly.
 */

import { create } from 'zustand';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';

interface FocusStore {
  /** Entered precomp/group ids, root → deepest. */
  path: ReadonlyArray<string>;
  /** Isolated leaf layer id, or null. */
  isolatedId: string | null;

  /** Enter a precomp/group in place. */
  enter: (id: string) => void;
  /** Isolate a single leaf layer. */
  isolate: (id: string) => void;
  /** Step up one level (isolate first, then the deepest precomp). */
  exitOne: () => void;
  /** Jump to a breadcrumb: index into `path`, or -1 for the root ("Main"). */
  jumpTo: (index: number) => void;
  /** Leave Focus Mode entirely. */
  clear: () => void;
}

export const useFocusStore = create<FocusStore>((set) => ({
  path: [],
  isolatedId: null,

  enter: (id) =>
    set((s) => (s.path.includes(id) ? s : { path: [...s.path, id], isolatedId: null })),
  isolate: (id) => set({ isolatedId: id }),

  exitOne: () =>
    set((s) => {
      if (s.isolatedId) return { isolatedId: null };
      if (s.path.length) return { path: s.path.slice(0, -1) };
      return s;
    }),

  jumpTo: (index) =>
    set((s) => ({ path: index < 0 ? [] : s.path.slice(0, index + 1), isolatedId: null })),

  clear: () => set({ path: [], isolatedId: null }),
}));

/** True when Focus Mode is engaged (something is isolated or a precomp entered). */
export function isFocusActive(s: Pick<FocusStore, 'path' | 'isolatedId'>): boolean {
  return s.path.length > 0 || s.isolatedId !== null;
}

/**
 * The set of node ids that render at full strength given the focus state, or
 * `null` when nothing is ghosted (top level). Everything not in the set ghosts.
 */
export function focusActiveSet(
  path: ReadonlyArray<string>,
  isolatedId: string | null,
): Set<string> | null {
  if (isolatedId) return new Set([isolatedId]);
  const deepest = path[path.length - 1];
  if (!deepest) return null;
  const set = new Set<string>();
  const walk = (id: string): void => {
    set.add(id);
    for (const child of defaultSceneGraph.getChildren(id)) walk(child.id);
  };
  walk(deepest);
  return set;
}
