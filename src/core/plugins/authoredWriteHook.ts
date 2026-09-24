/**
 * The plugin system's one hook on the document's write path.
 *
 * Two plugin behaviours, hooked at the ONE place an authored property write
 * happens (`SceneGraph.writeProp`, via `@core/scene/pluginPropWrites`):
 *
 *  - a generated child the user touched stops being managed by its plugin
 *    (`noteManualEdit`);
 *  - an authored edit of a custom layer's OWN declared property is reported to
 *    the plugin that owns the kind (`notifyAuthoredChange`).
 *
 * Doing it at the write rather than in the inspector is what makes both
 * structural: a user editing a plugin-generated layer detaches it wherever the
 * edit came from, and `onLayerChanged` cannot fire during playback at all —
 * animation samples tracks, it never writes props, so it cannot reach that path.
 *
 * Its own module (not inlined in `PluginHost`) because it is ENGINE-side: it
 * reads the scene graph on the write path. `PluginHost` is plugin management
 * (install, enable, list, logs, panels) that the UI calls; keeping the scene
 * read here keeps those calls honest for the B4 read ratchet
 * (docs/B4_MIRROR.md) and moves with the engine when it leaves the page.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setPluginPropWriteHandler } from '@core/scene/pluginPropWrites';
import { notifyAuthoredChange } from './layerChangeNotifier';
import { noteManualEdit } from './proxySubtree';
import { readCustomLayer, customLayerComponent } from './customLayers';

/** Install the hook (idempotent: a second call replaces the first). */
export function installAuthoredWriteHook(): void {
  setPluginPropWriteHandler((nodeId, componentId, propName) => {
    // A generated child the user touched: the plugin stops managing it.
    noteManualEdit(nodeId);

    // An authored edit on a custom layer's OWN property: tell its plugin.
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) return;
    const record = readCustomLayer(node);
    if (!record) return;
    // Only the component carrying the declared props, so a transform nudge
    // is not reported as a schema change.
    if (customLayerComponent(node)?.id !== componentId) return;
    if (propName.startsWith('__')) return;
    notifyAuthoredChange(nodeId, record.kind, propName);
  });
}
