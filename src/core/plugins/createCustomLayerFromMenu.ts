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
import { runDocumentEdit } from '@core/commands/documentEdit';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import pluginHost from './PluginHost';
import { findLayerKind } from './layerKindRegistry';
import { buildCustomLayerNode } from './customLayers';

/**
 * Insert a layer of `kind` and wake the plugin that owns it.
 *
 * Returns the new layer's id, or null when the kind is not registered — which
 * happens if the user disabled the plugin between the menu opening and the
 * click, and is a no-op rather than an error.
 */
export function createCustomLayerFromMenu(kind: string): string | null {
  const entry = findLayerKind(kind);
  if (!entry) return null;

  const id = `n_${Math.random().toString(36).slice(2, 10)}`;

  runDocumentEdit(`New ${entry.kind.label}`, () => {
    // Built from the SCHEMA, so every declared property starts at its declared
    // default — the same node the plugin would have produced through
    // `scene.createLayer`, because it is the same builder.
    defaultSceneGraph.addNode(buildCustomLayerNode(id, entry.pluginId, entry.kind));
    bumpScene();
  });

  // Selected, because a layer a user just asked for and cannot see the
  // properties of reads as nothing having happened.
  useSelectionStore.getState().set([id]);

  /*
    Then wake the plugin.

    Deliberately after the layer exists and outside the undo entry: the plugin's
    own regeneration is its own entry, and a worker boot must not sit inside a
    document edit. A `proxy` kind is an empty container until its plugin
    responds — which is the same state a document opened without the plugin is
    in, and already handled everywhere.
  */
  pluginHost.activateForDocument([kind]);

  return id;
}
