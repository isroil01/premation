/**
 * The bridge between the scene graph's write path and the plugin system.
 *
 * A separate file, and a registered callback rather than a direct import,
 * because `SceneGraph` must not depend on the plugin system: the graph is the
 * lower layer, it is used by tests and tools that have no plugin host, and an
 * import in that direction would pull the whole plugin surface into every one
 * of them.
 *
 * Registered once at boot by `PluginHost`. Until then, and in any build without
 * plugins, this is a no-op — which is the correct behaviour, not a degradation.
 */

type Handler = (nodeId: string, componentId: string, propName: string) => void;

let handler: Handler | null = null;

export function setPluginPropWriteHandler(fn: Handler | null): void {
  handler = fn;
}

/** Called from `SceneGraph.writeProp` on every successful authored write. */
export function notePluginPropWrite(nodeId: string, componentId: string, propName: string): void {
  handler?.(nodeId, componentId, propName);
}
