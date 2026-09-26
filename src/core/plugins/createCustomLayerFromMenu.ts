/**
 * Creating the first layer of a plugin-defined kind, from the host's menu.
 *
 * This closes the gap that made layer kinds unusable in practice. A custom
 * layer is created BY its plugin, through `scene.createLayer` — but the plugin
 * only wakes on `onLayerKind`, which fires when a document CONTAINING the kind
 * is opened. So the first layer of any kind could never be made: the plugin
 * needed the layer to exist in order to start, and the layer needed the plugin
 * to be running in order to be made.
 *
 * The host breaks it, because only the host can. It creates the layer itself,
 * from the registered schema, and then activates the plugin — which finds its
 * layer already present and can regenerate it exactly as it would after a
 * document open. There is no new plugin-facing surface here at all.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { activeCompRootId } from '@core/scene/activeComp';
import { insertBuiltLayers } from '@core/engine/offDocument';
import pluginHost from './PluginHost';
import { findLayerKind } from './layerKindRegistry';
import { buildCustomLayerNode } from './customLayers';

/**
 * Insert a layer of `kind` into the active composition and wake the plugin
 * that owns it — the menu's New ▸ <kind>.
 *
 * The layer is built from the SCHEMA off-document (every declared property at
 * its declared default — the same node the plugin would have produced through
 * `scene.createLayer`, because it is the same builder) and inserted with ONE
 * engine `pasteLayers` (offDocument.ts): one undo entry, replayable, the id
 * minted by the engine. Selected, because a layer a user just asked for and
 * cannot see the properties of reads as nothing having happened.
 *
 * Resolves to the new layer's id, or null when the kind is not registered —
 * which happens if the user disabled the plugin between the menu opening and
 * the click, and is a no-op rather than an error — or the insert failed.
 */
export async function createCustomLayerFromMenu(kind: string, comp: string = activeCompRootId() as string): Promise<string | null> {
  const ids = await insertCustomLayer(kind, comp);
  if (!ids || ids.length === 0) return null;
  /*
    Then wake the plugin.

    Deliberately after the layer exists and outside the undo entry: the plugin's
    own regeneration is its own entry, and a worker boot must not sit inside a
    document edit. A `proxy` kind is an empty container until its plugin
    responds — which is the same state a document opened without the plugin is
    in, and already handled everywhere.
  */
  wakeCustomLayerKind(kind);
  return ids[0] ?? null;
}

/**
 * The menu insert as ONE engine `pasteLayers` (B3z / B5): a layer of `kind`
 * built off-document into `comp` (the active composition — AE: New ▸ lands in
 * the active comp) and selected, with no plugin wake-up (the caller calls
 * {@link wakeCustomLayerKind}). Resolves to the new ids ([] when the kind is
 * not registered), or null when the insert failed (toasted).
 */
export async function insertCustomLayer(kind: string, comp: string): Promise<string[] | null> {
  const entry = findLayerKind(kind);
  if (!entry) return [];
  return insertBuiltLayers(`New ${entry.kind.label}`, comp, () => {
    const node = buildCustomLayerNode(`n_${Math.random().toString(36).slice(2, 10)}`, entry.pluginId, entry.kind);
    defaultSceneGraph.addChild(comp, node);
    useSelectionStore.getState().set([node.id]);
  });
}

/** The menu label of a registered kind ("New Depth Image"), or null. */
export function customLayerLabel(kind: string): string | null {
  const entry = findLayerKind(kind);
  return entry ? `New ${entry.kind.label}` : null;
}

/** Wake the plugin that owns `kind` once its layer exists (outside the undo entry, see above). */
export function wakeCustomLayerKind(kind: string): void {
  pluginHost.activateForDocument([kind]);
}
