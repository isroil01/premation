/**
 * activeComp — resolves the composition root the user is actually editing.
 *
 * Every "add a layer" path used to hardcode `getRoots[0]`, which is always
 * the FIRST composition: with a second comp open, new layers landed in comp #1
 * and the active comp stayed permanently empty. Kept in its own tiny module so
 * stores and command modules can import it without dragging in the whole
 * insert helper tree.
 */

import { useProjectStore } from '@stores/projectStore';
import { compItemIds, isCompItem } from '@core/mirror/docFacts';

/**
 * Id of the composition the active tab is editing (the engine document's, read
 * from the mirror). For drill-down precomp tabs this is the precomp group,
 * which is exactly where an insert should land. Falls back to the first
 * composition only when the tab points at one the document does not have
 * (never the case for healthy documents), and to the tab's own id before the
 * mirror has the document.
 */
export function activeCompRootId(): string {
  const proj = useProjectStore.getState();
  const compId = proj.tabs[proj.activeTabId ?? '']?.compositionId;
  if (compId && isCompItem(compId)) return compId;
  return compItemIds()[0] ?? compId ?? 'comp_root';
}

/**
 * Pixel size of the composition being edited — the FRAME a fit command or an
 * import fits into. Falls back to 1920×1080 only when the tab points at a comp
 * with no record, which healthy documents never do.
 */
export function activeCompSize(): { width: number; height: number } {
  const proj = useProjectStore.getState();
  const compId = proj.tabs[proj.activeTabId ?? '']?.compositionId ?? '';
  const c = proj.comps[compId];
  return c ? { width: c.width, height: c.height } : { width: 1920, height: 1080 };
}
