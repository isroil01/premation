/**
 * Projects that still carry JavaScript-plugin content (docs/TS_ENGINE_REMOVAL.md
 * phase 4, G2: the JS/WGSL plugin system is not ported — accepted loss).
 *
 * Such a project must still OPEN — the C++ engine reads it and draws those
 * effects as passthrough — but the content is dead weight the user cannot
 * edit or render. So after an open (or a recovery restore) the effects of
 * JavaScript plugins and the layers of their layer kinds are dropped as ONE
 * undoable history entry, and the caller shows ONE notice saying so. Undo
 * brings them back for the session; saving drops them from the file.
 *
 * What counts as JavaScript-plugin content, decided from the engine's own
 * answers (never from a list in the page):
 *  - an effect whose type the engine does not know (`listEffects`: built-ins
 *    and loaded native SDK plugins) and that does not belong to a native SDK
 *    plugin the engine found, loaded or not (`listPlugins`: an uninstalled or
 *    failed NATIVE plugin's effects are kept for when it comes back);
 *  - a layer provided by a plugin layer kind (`LayerInfo.generator`, which
 *    only JavaScript plugins ever set).
 *
 * Never throws: a query that fails leaves the document as it opened.
 */

import type { Command, EngineClient } from '@motion/engine-api';

export interface RemovedPluginContent {
  effects: number;
  layers: number;
  /** The one notice to show. */
  message: string;
}

/** The fx component's effect list of one exported document node. */
function effectsOf(node: unknown): Array<{ id: string; type: string }> {
  const comps = (node as { components?: unknown }).components;
  if (!Array.isArray(comps)) return [];
  const out: Array<{ id: string; type: string }> = [];
  for (const c of comps) {
    if (!c || typeof c !== 'object' || (c as { type?: unknown }).type !== 'fx') continue;
    const list = ((c as { props?: { effects?: unknown } }).props ?? {}).effects;
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      const id = (e as { id?: unknown })?.id;
      const type = (e as { type?: unknown })?.type;
      if (typeof id === 'string' && typeof type === 'string') out.push({ id, type });
    }
  }
  return out;
}

/** Every scene node of an exported document (`scene.nodes` as an array or a map). */
function nodesOf(doc: unknown): Array<{ id: string; node: unknown }> {
  const nodes = (doc as { scene?: { nodes?: unknown } })?.scene?.nodes;
  const list = Array.isArray(nodes) ? nodes : nodes && typeof nodes === 'object' ? Object.values(nodes) : [];
  const out: Array<{ id: string; node: unknown }> = [];
  for (const n of list) {
    const id = (n as { id?: unknown })?.id;
    if (typeof id === 'string') out.push({ id, node: n });
  }
  return out;
}

function belongsToNativePlugin(type: string, nativeIds: ReadonlySet<string>): boolean {
  for (const id of nativeIds) if (type === id || type.startsWith(`${id}.`)) return true;
  return false;
}

/**
 * Drop the JavaScript-plugin content of the engine's document as one history
 * entry. Null when there is none (or the engine could not be asked).
 */
export async function dropRemovedPluginContent(client: EngineClient): Promise<RemovedPluginContent | null> {
  try {
    const [effectsRes, pluginsRes, docRes, layersRes] = await Promise.all([
      client.query({ type: 'listEffects', category: '' }),
      client.query({ type: 'listPlugins' }),
      client.query({ type: 'exportDocument' }),
      client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }),
    ]);
    if (!effectsRes.ok || !docRes.ok || !layersRes.ok) return null;
    const known = new Set(effectsRes.value.effects.map((e) => e.matchName));
    const nativePlugins = pluginsRes.ok ? pluginsRes.value.plugins : [];
    const nativeIds = new Set(nativePlugins.map((p) => p.id));
    for (const p of nativePlugins) for (const m of p.effects) known.add(m);
    const layerIds = new Set(layersRes.value.layers.map((l) => l.id));
    const pluginLayers = layersRes.value.layers.filter((l) => l.generator !== '').map((l) => l.id);
    const dropped = new Set(pluginLayers);

    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(docRes.value.document));
    } catch {
      return null;
    }
    const groups: Array<{ layer: string; path: string }> = [];
    for (const { id, node } of nodesOf(doc)) {
      if (!layerIds.has(id) || dropped.has(id)) continue;
      for (const e of effectsOf(node)) {
        if (known.has(e.type) || belongsToNativePlugin(e.type, nativeIds)) continue;
        groups.push({ layer: id, path: `effects/${e.id}` });
      }
    }
    if (groups.length === 0 && pluginLayers.length === 0) return null;

    const commands: Command[] = [];
    if (groups.length > 0) commands.push({ type: 'removePropertyGroups', groups });
    if (pluginLayers.length > 0) commands.push({ type: 'deleteLayers', layers: pluginLayers });
    const res = await client.batch('Remove JavaScript Plugin Content', commands);
    if (!res.ok) return null;
    const parts = [
      groups.length > 0 ? `${groups.length} effect${groups.length === 1 ? '' : 's'}` : '',
      pluginLayers.length > 0 ? `${pluginLayers.length} layer${pluginLayers.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return {
      effects: groups.length,
      layers: pluginLayers.length,
      message: `This project used ${parts.join(' and ')} from JavaScript plugins, which Premation no longer runs. `
        + 'They were removed (Undo brings them back until you save).',
    };
  } catch {
    return null;
  }
}
