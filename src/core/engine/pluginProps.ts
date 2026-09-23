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
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { channelsToColor } from '@core/effects/effects';
import { fail } from './errors';
import type { PropBinding } from './props';

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

/** A stored key that is a plugin's own (not the host's `__kind`, `__cid`, …). */
const ownKey = (k: string): boolean => !k.startsWith('_') && SEG.test(k.split('.')[0]!) && k.split('.').length <= 2;

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

/** Write it: false when the layer has no such component (nothing is created); null = not a plugin track. */
export function writePluginStatic(nodeId: string, node: SceneNode, prop: string, value: number): boolean | null {
  const t = parsePluginTrack(prop);
  if (!t) return null;
  const { comp, key } = staticHome(node, t);
  if (!comp) return false;
  defaultSceneGraph.writeProp(nodeId, comp.id, key, value);
  return true;
}

// ── Bindings ─────────────────────────────────────────────────────────

/** A non-numeric stored value's type. */
function fieldType(v: unknown): 'bool' | 'string' | 'json' {
  return typeof v === 'boolean' ? 'bool' : typeof v === 'string' ? 'string' : 'json';
}

function numericBinding(path: string, name: string, members: string[]): PropBinding {
  const vt = members.length <= 1 ? 'scalar' : members.length === 2 ? 'vec2' : 'vec3';
  // `home: []`: the static seam owns the value (a write with no component to
  // hold it is `notFound` — nothing is invented on the Transform).
  return { path, name, matchName: members[0]!, valueType: vt, members, animatable: true, unit: '', home: [] };
}

function fieldBinding(path: string, name: string, component: string, key: string, stored: unknown): PropBinding {
  return {
    path, name, matchName: key, valueType: fieldType(stored), members: [], special: 'field',
    field: { owner: 'plugin', key, groupId: component }, animatable: false, unit: '',
  };
}

/**
 * Add the plugin bindings of a layer (props.ts catalogFor, after the latent
 * block): the layer kind's props, then each panel's params — numbers from the
 * stored values AND from animated tracks with no stored value.
 */
export function addPluginBindings(node: SceneNode, trackNames: readonly string[], add: (b: PropBinding) => void): void {
  const tracks = trackNames.map((p) => ({ p, t: parsePluginTrack(p) })).filter((x) => x.t !== null) as Array<{ p: string; t: PluginTrack }>;
  const kind = layerKindComponent(node);
  if (kind) {
    const props = kind.props as Record<string, unknown>;
    const names = new Set<string>();
    for (const k of Object.keys(props)) if (ownKey(k) && !k.includes('.')) names.add(k);
    for (const { t } of tracks) if (t.kind === 'layer') names.add(t.name);
    for (const name of [...names].sort()) {
      const v = props[name];
      const path = `plugin/${name}`;
      if (v === undefined || typeof v === 'number') add(numericBinding(path, name, [`${PLUGIN_LAYER_TRACK_PREFIX}${name}`]));
      else add(fieldBinding(path, name, kind.type, name, v));
    }
  }
  // Panels: the stored components, plus panels only animated tracks name.
  const panels = new Map<string, { slug: string; panel: string; comp?: Comp }>();
  for (const c of node.components) {
    const p = parsePanelType(c.type);
    if (p) panels.set(c.type, { ...p, comp: c });
  }
  for (const { t } of tracks) {
    if (t.kind !== 'panel') continue;
    const type = `${PLUGIN_PANEL_COMPONENT_PREFIX}${t.slug}.${t.panel}`;
    if (!panels.has(type)) panels.set(type, { slug: t.slug, panel: t.panel });
  }
  for (const type of [...panels.keys()].sort()) {
    const { slug, panel, comp } = panels.get(type)!;
    const props = (comp?.props ?? {}) as Record<string, unknown>;
    // name → the axes a number is stored / animated on ('' = a plain scalar).
    const numeric = new Map<string, Set<string>>();
    const other = new Map<string, unknown>();
    for (const [k, v] of Object.entries(props)) {
      if (!ownKey(k)) continue;
      const [name, axis] = k.split('.') as [string, string | undefined];
      if (typeof v === 'number') {
        if (axis !== undefined && !(AXES as readonly string[]).includes(axis)) continue;
        if (!numeric.has(name)) numeric.set(name, new Set());
        numeric.get(name)!.add(axis ?? '');
      } else if (axis === undefined) {
        other.set(name, v);
      }
    }
    for (const { t } of tracks) {
      if (t.kind !== 'panel' || t.slug !== slug || t.panel !== panel || other.has(t.name)) continue;
      if (!numeric.has(t.name)) numeric.set(t.name, new Set());
      numeric.get(t.name)!.add(t.axis ?? '');
    }
    const base = `plugin/${slug}/${panel}`;
    const prefix = `${PLUGIN_PANEL_TRACK_PREFIX}${slug}.${panel}.`;
    for (const name of [...new Set([...numeric.keys(), ...other.keys()])].sort()) {
      const path = `${base}/${name}`;
      if (other.has(name)) {
        add(fieldBinding(path, name, type, name, other.get(name)));
        continue;
      }
      const axes = AXES.filter((a) => numeric.get(name)!.has(a));
      const members = axes.length > 0 ? axes.map((a) => `${prefix}${name}.${a}`) : [`${prefix}${name}`];
      add(numericBinding(path, name, members));
    }
  }
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

// ── Fields (non-numeric values) ───────────────────────────────────────

export function readPluginField(node: SceneNode, b: PropBinding): Value {
  const comp = node.components.find((c) => c.type === b.field!.groupId);
  const v = (comp?.props as Record<string, unknown> | undefined)?.[b.field!.key];
  if (b.valueType === 'bool') return { kind: 'bool', value: v === true };
  if (b.valueType === 'string') return { kind: 'string', value: typeof v === 'string' ? v : '' };
  return { kind: 'json', value: JSON.stringify(v === undefined ? null : v) };
}

/** The raw value a plugin field stores for `value` (its own type, or ANY json). */
function pluginRaw(b: PropBinding, value: Value): unknown {
  switch (value.kind) {
    case 'bool': if (b.valueType === 'bool') return value.value; break;
    case 'string': if (b.valueType === 'string') return value.value; break;
    case 'json':
      try { return JSON.parse(value.value) as unknown; } catch { return fail('invalidArgument', 'invalid json', { path: b.path }); }
    default: break;
  }
  return fail('typeMismatch', `'${b.path}' takes a ${b.valueType} (or json), got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: b.valueType }) });
}

export function writePluginField(layerId: string, node: SceneNode, b: PropBinding, value: Value): void {
  const raw = pluginRaw(b, value);
  const comp = node.components.find((c) => c.type === b.field!.groupId);
  if (!comp) fail('notFound', `layer '${layerId}' has no ${b.field!.groupId}`, { layer: layerId, path: b.path });
  // Stored verbatim — JSON null included (an empty asset slot): deleting the key
  // would remove the property.
  defaultSceneGraph.writeProp(layerId, comp.id, b.field!.key, raw);
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
