/**
 * Where an insert from a menu or panel lands: the composition the active tab
 * edits, and — when the tab is a group opened in its own tab — that group as
 * the parent. `activeCompRootId`'s answer, asked through the engine seam and
 * editor state (the tab) instead of the scene singleton (B4).
 */

import { compItemIds, compOfLayer, isCompItem, isLayer } from '@core/engine/doc';
import { useProjectStore } from '@stores/projectStore';

export interface InsertTarget {
  /** The composition item the new layers belong to. */
  comp: string;
  /** The group the active tab shows, when it is one. */
  parent?: string;
}

/** The active tab's insert target; the document's first composition when the tab shows none. Null with no composition. */
export function activeInsertTarget(): InsertTarget | null {
  const s = useProjectStore.getState();
  const id = s.tabs[s.activeTabId ?? '']?.compositionId;
  if (id && isLayer(id)) {
    const comp = compOfLayer(id);
    if (comp) return { comp, parent: id };
  }
  if (id && isCompItem(id)) return { comp: id };
  const first = compItemIds()[0];
  return first ? { comp: first } : null;
}
