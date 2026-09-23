/**
 * The Layers panel's eye / lock / solo / shy switches, through the engine API
 * (B3 reference migration — docs/B3_PATTERNS.md "simple set" and "multi-select
 * batch").
 *
 * Same rules the panel always had: ANCHORED on the clicked row (it acts on the
 * whole selection when the row is part of it, on that row alone otherwise), the
 * clicked row's state decides the direction for the whole set, and the lot is
 * ONE undo step. What changed is the write: one `setLayerSwitches` per layer in
 * one labelled batch, instead of assigning `node.visible` inside
 * `runDocumentEdit`. The engine records the inverse, refreshes the panels and
 * refuses what it cannot do with a typed error (toasted by `edit`).
 *
 * A composition ROOT is not a layer in the API (it is an item), so its row's
 * switches keep the legacy writer until compositions migrate.
 */

import type { Command, LayerSwitchesPatch } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isLayer } from '@core/engine/doc';
import { edit } from '@core/engine/uiEdits';
import { toggleSelectedLocked, toggleSelectedSolo, toggleSelectedVisible } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';

export type LayerSwitch = 'visible' | 'locked' | 'solo' | 'shy';

/** The ids an action on `anchorId` applies to: the selection when the row is in it, else the row. */
export function anchoredLayerIds(anchorId: string): string[] {
  const sel = useSelectionStore.getState().ids;
  return sel.includes(anchorId) ? [...sel] : [anchorId];
}

/** The switch's current state on one node (a display read — direct until B4). */
function readSwitch(nodeId: string, sw: LayerSwitch): boolean {
  const n = defaultSceneGraph.getNode(nodeId);
  if (!n) return false;
  if (sw === 'visible') return n.visible !== false;
  return (n as unknown as Record<LayerSwitch, unknown>)[sw] === true;
}

const LABELS: Record<LayerSwitch, [on: string, off: string]> = {
  visible: ['Show layer', 'Hide layer'],
  locked: ['Lock layer', 'Unlock layer'],
  solo: ['Solo layer', 'Unsolo layer'],
  shy: ['Enable Shy', 'Disable Shy'],
};

const LEGACY: Partial<Record<LayerSwitch, (anchorId: string) => void>> = {
  visible: toggleSelectedVisible,
  locked: toggleSelectedLocked,
  solo: toggleSelectedSolo,
};

/**
 * The commands that set `sw` to `next` on every layer of `ids` (non-layers
 * skipped). Exported for tests and for callers that fold it into a bigger batch.
 */
export function switchCommands(ids: readonly string[], sw: LayerSwitch, next: boolean): Command[] {
  const patch: LayerSwitchesPatch = { [sw]: next };
  // One command per layer: `setLayerSwitches` takes the layers of ONE
  // composition, and a selection may span several (a precomp's layers and the
  // outer comp's). The batch keeps them one undo entry.
  return ids.filter((id) => isLayer(id)).map((id) => ({ type: 'setLayerSwitches', layers: [id], patch }) as Command);
}

/** Toggle `sw` anchored on the clicked row (see the file header). */
export async function toggleLayerSwitchAnchored(anchorId: string, sw: LayerSwitch): Promise<void> {
  if (!defaultSceneGraph.getNode(anchorId)) return;
  if (!isLayer(anchorId)) {
    // A composition root's row: no API switch yet (see the header).
    LEGACY[sw]?.(anchorId);
    return;
  }
  const ids = anchoredLayerIds(anchorId);
  const next = !readSwitch(anchorId, sw);
  const cmds = switchCommands(ids, sw, next);
  if (cmds.length === 0) return;
  const [on, off] = LABELS[sw];
  const verb = next ? on : off;
  await edit(cmds.length === 1 ? verb : `${verb} (${cmds.length} layers)`, cmds);
}
