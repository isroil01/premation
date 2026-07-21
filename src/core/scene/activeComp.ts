/**
 * activeComp — resolves the composition root the user is actually editing.
 *
 * Every "add a layer" path used to hardcode `getRoots()[0]`, which is always
 * the FIRST composition: with a second comp open, new layers landed in comp #1
 * and the active comp stayed permanently empty. Kept in its own tiny module so
 * stores and command modules can import it without dragging in the whole
 * insert helper tree.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { useProjectStore } from '@stores/projectStore';

/**
 * Root node id of the composition the active tab is editing. For drill-down
 * precomp tabs this is the precomp group node, which is exactly where an
 * insert should land. Falls back to the first root only when the tab points
 * at a comp with no scene node (never the case for healthy documents).
 */
export function activeCompRootId(): string {
  const proj = useProjectStore.getState();
  const compId = proj.tabs[proj.activeTabId ?? '']?.compositionId;
  if (compId && defaultSceneGraph.getNode(compId)) return compId;
  return defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
}
