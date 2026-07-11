/**
 * Derives the live Focus Mode context from the focus store + scene graph:
 * the ghosting predicate for the renderer, a change key, the breadcrumb
 * trail, and the active-set (used to dim timeline/tree rows).
 */

import { useFocusStore, focusActiveSet, isFocusActive } from '@stores/focusStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SnapshotFocus } from '@core/rendering/buildSnapshot';

export interface Crumb {
  /** -1 = the root document ("Main"); >=0 = index into the focus path. */
  index: number;
  label: string;
  /** True for the leaf isolated layer crumb (not clickable to a sub-level). */
  isolated?: boolean;
}

export interface FocusContext {
  active: boolean;
  focus: SnapshotFocus | undefined;
  focusKey: string;
  activeSet: Set<string> | null;
  crumbs: Crumb[];
}

const nameOf = (id: string): string => defaultSceneGraph.getNode(id)?.name ?? 'Layer';

export function useFocusContext(): FocusContext {
  const path = useFocusStore((s) => s.path);
  const isolatedId = useFocusStore((s) => s.isolatedId);
  // Subtree membership can change as the scene changes.
  useSceneRevision((s) => s.rev);

  const activeSet = focusActiveSet(path, isolatedId);
  const active = isFocusActive({ path, isolatedId });
  const focus: SnapshotFocus | undefined = activeSet
    ? { isGhost: (id) => !activeSet.has(id) }
    : undefined;
  const focusKey = `${path.join('>')}|${isolatedId ?? ''}`;

  const crumbs: Crumb[] = [{ index: -1, label: 'Main' }];
  path.forEach((id, i) => crumbs.push({ index: i, label: nameOf(id) }));
  if (isolatedId) crumbs.push({ index: path.length, label: nameOf(isolatedId), isolated: true });

  return { active, focus, focusKey, activeSet, crumbs };
}
