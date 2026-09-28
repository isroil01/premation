/**
 * What the Assets panel currently has selected, readable from outside React.
 *
 * The panel's selection has always been component `useState` — which is right
 * for a panel that owns it, and useless to a COMMAND. A command registered in
 * the registry runs from the palette and the menu bar, neither of which is
 * inside the panel's tree, so "New Composition from Selected Clips" had no way
 * to learn what "selected" meant.
 *
 * The alternative was a fourteenth selection store. That would have made the
 * panel read its own selection back through a subscription and re-render the
 * whole list on every click, to solve a problem only two commands have. This is
 * a mirror instead: the panel keeps owning the state and publishes it here on
 * change, and readers get a plain snapshot.
 *
 * ORDER IS THE PANEL'S ROW ORDER, not click order — the same rule the panel's
 * own "Add N to Composition" follows, so what lands in a comp matches what the
 * user is looking at.
 */

import type { ImportedAsset } from '@stores/assetStore';
import { documentMirror } from '@stores/documentMirror';
import { itemAssetsOf } from '@core/mirror/itemAssets';

let selectedIds: readonly string[] = [];

/** Publish the panel's selection. Called by the Assets panel; nothing else. */
export function setPanelAssetSelection(ids: readonly string[]): void {
  selectedIds = [...ids];
}

/** The published ids, unfiltered. */
export function panelAssetSelectionIds(): readonly string[] {
  return selectedIds;
}

/**
 * The selected assets that still exist, in panel row order.
 *
 * Filtered against the document's items on every read rather than pruned on
 * delete: the panel can unmount (a workspace switch, a pop-out window) while
 * its last published selection lingers, and a command acting on a deleted
 * asset is a crash, not a no-op.
 */
export function selectedPanelAssets(): ImportedAsset[] {
  // B4: the records built from the document mirror's items (ItemInfo: media URL, probe facts, interpretation).
  return itemAssetsOf(documentMirror(), selectedIds);
}

/** Selected FOOTAGE — video and image. Audio has no frame to size a comp from. */
export function selectedPanelFootage(): ImportedAsset[] {
  return selectedPanelAssets().filter((a) => a.type === 'video' || a.type === 'image');
}
