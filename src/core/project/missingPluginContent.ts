/**
 * Effects and layers whose plugin is not here (docs/AE_PARITY_PLAN.md step 1.2).
 *
 * A project can name an effect type the engine does not know: a native SDK
 * plugin that is not installed (or failed to load) on this machine, or an old
 * JavaScript/WGSL plugin (docs/TS_ENGINE_REMOVAL.md G2). That content is the
 * user's data and is NEVER deleted: the engine keeps it in the document,
 * renders the effect as a pass-through and records it on the frame's
 * `layerErrors`; a save writes it back unchanged, so installing the plugin
 * brings it back. After an open (or a recovery restore) the caller shows ONE
 * notice naming the missing plugins.
 *
 * What counts as missing, decided from the engine's own answers (never from a
 * list in the page):
 *  - an effect whose type is neither a built-in nor a loaded native plugin's
 *    (`listEffects`), nor one a native plugin the engine found declares
 *    (`listPlugins`, loaded or not);
 *  - a layer provided by a plugin layer kind (`LayerInfo.generator`).
 *
 * Read-only and never throws: a query that fails reports nothing.
 */

import type { EngineClient } from '@motion/engine-api';

export interface MissingPluginContent {
  effects: number;
  layers: number;
  /** The plugins the content belongs to (an effect type's namespace), sorted. */
  plugins: string[];
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

/** `com.vendor.pack.effect` → `com.vendor.pack`; a type with no namespace names itself. */
export function pluginOfType(type: string): string {
  const dot = type.lastIndexOf('.');
  return dot > 0 ? type.slice(0, dot) : type;
}

/**
 * The engine document's content whose plugin is missing. Null when there is
 * none (or the engine could not be asked). Changes nothing.
 */
export async function findMissingPluginContent(client: EngineClient): Promise<MissingPluginContent | null> {
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
    const pluginLayers = layersRes.value.layers.filter((l) => l.generator !== '');
    const plugins = new Set<string>(pluginLayers.map((l) => pluginOfType(l.generator)));

    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(docRes.value.document));
    } catch {
      return null;
    }
    let effects = 0;
    for (const { id, node } of nodesOf(doc)) {
      if (!layerIds.has(id)) continue;
      for (const e of effectsOf(node)) {
        if (known.has(e.type) || belongsToNativePlugin(e.type, nativeIds)) continue;
        effects += 1;
        plugins.add(pluginOfType(e.type));
      }
    }
    if (effects === 0 && pluginLayers.length === 0) return null;

    const names = [...plugins].sort();
    const parts = [
      effects > 0 ? `${effects} effect${effects === 1 ? '' : 's'}` : '',
      pluginLayers.length > 0 ? `${pluginLayers.length} layer${pluginLayers.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    return {
      effects,
      layers: pluginLayers.length,
      plugins: names,
      message: `Missing plugin${names.length === 1 ? '' : 's'} ${shown}. `
        + `${parts.join(' and ')} ${effects + pluginLayers.length === 1 ? 'is' : 'are'} kept in the project and pass through until the plugin is installed.`,
    };
  } catch {
    return null;
  }
}
