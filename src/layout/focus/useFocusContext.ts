/**
 * Derives the live Focus Mode context from the focus store + scene graph:
 * the ghosting predicate for the renderer, a change key, the breadcrumb
 * trail, and the active-set (used to dim timeline/tree rows).
 */

import { useMemo } from 'react';
import { useFocusStore, focusActiveSet, isFocusActive } from '@stores/focusStore';
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

  // Memoised so the Set identity is stable between sceneRev bumps. Previously
  // useFocusContext subscribed to sceneRev, causing focusActiveSet() to return
  // a new Set on every scene edit — even when focus state hadn't changed — which
  // invalidated the focusTracks memo and cascaded into a full timelineModel
  // rebuild on every property drag tick.
  //
  // The activeSet only needs to recompute when path/isolatedId change (i.e. when
  // the user enters or exits focus mode). The renderer updates independently via
  // its own sceneRev path; timeline ghosting is a visual hint, not a gate.
  const activeSet = useMemo(
    () => focusActiveSet(path, isolatedId),
    // path is a ReadonlyArray — compare by joining so a new array with the same
    // contents (Zustand shallow-copy) doesn't bust the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path.join(','), isolatedId],
  );

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
