/**
 * PLUGIN properties (B3z, docs/ENGINE_API.md §15.9 "Plugin properties") — the
 * values JavaScript plugins keep on a layer, as ordinary engine-API properties.
 *
 *   plugin/<name>                  a plugin-declared LAYER KIND's prop (the
 *                                  layer's `pluginLayer:<…>` component; keyed on
 *                                  the `plugin.<name>` track — customLayers.ts)
 *   plugin/<slug>/<panel>          the property GROUP of one contributed
 *                                  inspector panel (the `PluginParams.<slug>.<panel>`
 *                                  component, id `pluginui_<slug>_<panel>` —
 *                                  uiParams.ts); added / removed with
 *                                  `addPropertyGroup` / `removePropertyGroups`
 *   plugin/<slug>/<panel>/<name>   one of its params (keyed on the
 *                                  `pluginUi.<slug>.<panel>.<name>[.<axis>]` tracks)
 *
 * The engine has no plugin SCHEMA: a plugin's declaration is editor state
 * (the installed manifest), not document state, and the C++ engine never sees
 * it. So a binding is typed by what the DOCUMENT stores — After Effects' model
 * for an effect instance whose plug-in is missing: the params are still there
 * and editable by type. A number is an animatable scalar (a point's `<name>.x` /
 * `.y` / `.z` numbers one vec2 / vec3 — the AE Point Control); a boolean a bool,
 * a string a string (an enum value, a colour hex, an asset id), anything else
 * (null, objects) json. A non-numeric param also takes ANY json value (the
 * plug-in's arbitrary data: an asset slot goes from null to an id). A panel
 * group is added with ALL its declared defaults (`init` — the client knows the
 * schema), exactly what the editor's first write used to seed.
 *
 * Bindings are added in a fixed, SORTED order (property names, then panel
 * component types) so both engines list the same tree whatever order the
 * document's objects carry their keys in. Pure over the document; the C++
 * engine ports this file (native/engine/src/core/plugin_props.cpp).
 */

import type { Value } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { channelsToColor } from '@core/effects/effects';
import { fail } from './errors';

/** customLayers.ts COMPONENT_TYPE_PREFIX / CUSTOM_PROP_PREFIX. */
export const PLUGIN_LAYER_COMPONENT_PREFIX = 'pluginLayer:';
export const PLUGIN_LAYER_TRACK_PREFIX = 'plugin.';
/** uiParams.ts pluginParamComponentType / PLUGIN_PARAM_PREFIX / pluginParamComponentId. */
export const PLUGIN_PANEL_COMPONENT_PREFIX = 'PluginParams.';
export const PLUGIN_PANEL_TRACK_PREFIX = 'pluginUi.';
export const PLUGIN_PANEL_ID_PREFIX = 'pluginui_';

const AXES = ['x', 'y', 'z'] as const;
const SEG = /^[A-Za-z0-9-]+$/;

export type PluginTrack =
  | { kind: 'layer'; name: string }
  | { kind: 'panel'; slug: string; panel: string; name: string; axis?: string };

/** `plugin.<name>` / `pluginUi.<slug>.<panel>.<name>[.<axis>]`, or null. */
export function parsePluginTrack(prop: string): PluginTrack | null {
  if (prop.startsWith(PLUGIN_PANEL_TRACK_PREFIX)) {
    const seg = prop.slice(PLUGIN_PANEL_TRACK_PREFIX.length).split('.');
    if (seg.length < 3 || seg.length > 4 || !seg.every((s) => SEG.test(s))) return null;
    const axis = seg[3];
    if (axis !== undefined && !(AXES as readonly string[]).includes(axis)) return null;
    return { kind: 'panel', slug: seg[0]!, panel: seg[1]!, name: seg[2]!, ...(axis !== undefined ? { axis } : {}) };
  }
  if (prop.startsWith(PLUGIN_LAYER_TRACK_PREFIX)) {
    const name = prop.slice(PLUGIN_LAYER_TRACK_PREFIX.length);
    return SEG.test(name) && !name.startsWith('_') ? { kind: 'layer', name } : null;
  }
  return null;
}

/** The API path of a plugin member track (apiPathFor), or null. */
export function pluginApiPath(prop: string): string | null {
  const t = parsePluginTrack(prop);
  if (!t) return null;
  return t.kind === 'layer' ? `plugin/${t.name}` : `plugin/${t.slug}/${t.panel}/${t.name}`;
}

type Comp = SceneNode['components'][number];

function layerKindComponent(node: SceneNode): Comp | undefined {
  return node.components.find((c) => c.type.startsWith(PLUGIN_LAYER_COMPONENT_PREFIX));
}

function panelComponent(node: SceneNode, slug: string, panel: string): Comp | undefined {
  const type = `${PLUGIN_PANEL_COMPONENT_PREFIX}${slug}.${panel}`;
  return node.components.find((c) => c.type === type);
}

/** `PluginParams.<slug>.<panel>` → {slug, panel}, or null. */
function parsePanelType(type: string): { slug: string; panel: string } | null {
  if (!type.startsWith(PLUGIN_PANEL_COMPONENT_PREFIX)) return null;
  const seg = type.slice(PLUGIN_PANEL_COMPONENT_PREFIX.length).split('.');
  if (seg.length !== 2 || !seg.every((s) => SEG.test(s))) return null;
  return { slug: seg[0]!, panel: seg[1]! };
}

// ── The static seam (numbers) ─────────────────────────────────────────

/** The component + key a plugin member track's static value lives at, or null. */
function staticHome(node: SceneNode, t: PluginTrack): { comp: Comp | undefined; key: string } {
  if (t.kind === 'layer') return { comp: layerKindComponent(node), key: t.name };
  return { comp: panelComponent(node, t.slug, t.panel), key: t.axis ? `${t.name}.${t.axis}` : t.name };
}

/**
 * propertyValue.ts seam: the static number of a plugin member track —
 * `undefined` when it stores none, `null` when `prop` is not a plugin track.
 */
export function readPluginStatic(node: SceneNode, prop: string): number | undefined | null {
  const t = parsePluginTrack(prop);
  if (!t) return null;
  const { comp, key } = staticHome(node, t);
  const v = (comp?.props as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'number' ? v : undefined;
}

/** The panel group paths of a layer (`plugin/<slug>/<panel>`, one per stored panel component), sorted. */
export function pluginPanelGroupPaths(node: SceneNode): string[] {
  const out: string[] = [];
  for (const c of node.components) {
    const p = parsePanelType(c.type);
    if (p) out.push(`plugin/${p.slug}/${p.panel}`);
  }
  return out.sort();
}

// ── Panel groups (addPropertyGroup / removePropertyGroups) ───────────

/** `plugin/<slug>/<panel>` → the panel it names, or null (not a panel group path). */
export function parsePanelGroupPath(path: string): { slug: string; panel: string; type: string; id: string } | null {
  const seg = path.split('/');
  if (seg.length !== 3 || seg[0] !== 'plugin' || !SEG.test(seg[1]!) || !SEG.test(seg[2]!)) return null;
  return {
    slug: seg[1]!, panel: seg[2]!,
    type: `${PLUGIN_PANEL_COMPONENT_PREFIX}${seg[1]}.${seg[2]}`,
    id: `${PLUGIN_PANEL_ID_PREFIX}${seg[1]}_${seg[2]}`,
  };
}

/** The group a `PluginParams.<slug>.<panel>` match name adds under `plugin`, or null. */
export function panelGroupForMatchName(matchName: string): string | null {
  const p = parsePanelType(matchName);
  return p ? `plugin/${p.slug}/${p.panel}` : null;
}

/** An `init` value as the stored props (a point = `<name>.x` / `.y` / `.z` numbers). */
export function panelInitProps(init: ReadonlyArray<{ path: string; value: Value }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { path, value } of init) {
    if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(path)) fail('invalidArgument', `'${path}' is not a plugin param name`, { path });
    const num = (x: number): number => {
      if (!Number.isFinite(x)) fail('invalidArgument', `'${path}': value must be finite`, { path });
      return x;
    };
    switch (value.kind) {
      case 'scalar': case 'int': out[path] = num(value.value); break;
      case 'bool': out[path] = value.value; break;
      case 'string': case 'choice': out[path] = value.value; break;
      case 'vec2': out[`${path}.x`] = num(value.value.x); out[`${path}.y`] = num(value.value.y); break;
      case 'vec3': out[`${path}.x`] = num(value.value.x); out[`${path}.y`] = num(value.value.y); out[`${path}.z`] = num(value.value.z); break;
      case 'color': out[path] = channelsToColor(value.value.r, value.value.g, value.value.b, value.value.a); break;
      case 'json':
        try { out[path] = JSON.parse(value.value) as unknown; } catch { fail('invalidArgument', 'invalid json', { path }); }
        break;
      default: fail('typeMismatch', `'${path}': a plugin param takes a number, point, bool, string, colour or json`, { path });
    }
  }
  return out;
}
