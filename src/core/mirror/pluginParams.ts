/**
 * A contributed plugin panel's params read from the document MIRROR (B4) — the
 * mirror twins of `readPluginParam` / `pluginParamComponent` (uiParamValues.ts)
 * and of the per-axis "current value" the panel's write builder needs
 * (layout/Inspector/pluginParamEdits.ts). Pure: they take a mirror reader and
 * never touch the engine.
 *
 * The engine lists a panel as a property GROUP `plugin/<slug>/<panel>` and each
 * param as `plugin/<slug>/<panel>/<name>` (src/core/engine/pluginProps.ts):
 * a number is a scalar, a point ONE vec2 / vec3 (its axes are members, in
 * x, y, z order), anything else a bool / string / json field. A param the
 * layer does not store (a panel never written) reads as its declared default,
 * exactly as `readPluginParam` does.
 *
 *   pluginPanelPath(pluginId, panelId)                 the panel group's API path
 *   pluginParamApiPath(pluginId, panelId, name)        one param's API path
 *   mirrorHasPluginPanel(m, layer, pluginId, panelId)  the layer has the panel's group
 *   mirrorPluginParam(m, layer, pluginId, panelId, schema, axis?)   stored value, else the declared default
 *   mirrorPluginParamAnimated(m, layer, pluginId, panelId, name)    the param has keyframes
 *   mirrorPluginAxisAt(m, layer, pluginId, panelId, schema, axis, seconds)  a number / point axis at comp time `seconds`
 */

import { secondsToFlicks, type Keyframe, type PropertyInfo, type Value } from '@motion/engine-api';
import { paramAxes, paramHoldsValue, pluginParamSlug, type PluginParamSchema } from '@core/plugins/uiParams';
import { numbersOfValue, plainValue } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface PluginParamRead {
  property(layer: string, path: string): PropertyInfo | undefined;
  keyframes(layer: string, path: string): readonly Keyframe[];
  valueAt(layer: string, path: string, time: number): Value | undefined;
}

/** `plugin/<slug>/<panel>` — the panel's property group. */
export function pluginPanelPath(pluginId: string, panelId: string): string {
  return `plugin/${pluginParamSlug(pluginId)}/${panelId}`;
}

/** `plugin/<slug>/<panel>/<name>` — one param (a point's axes are members of it). */
export function pluginParamApiPath(pluginId: string, panelId: string, name: string): string {
  return `${pluginPanelPath(pluginId, panelId)}/${name}`;
}

/** Whether the layer carries the panel's group (the twin of `pluginParamComponent(...) !== null`). */
export function mirrorHasPluginPanel(m: Pick<PluginParamRead, 'property'>, layer: string, pluginId: string, panelId: string): boolean {
  return m.property(layer, pluginPanelPath(pluginId, panelId)) !== undefined;
}

/**
 * Which member of a point param's value holds `axis`. The engine numbers the
 * axes the layer stores, in x, y, z order; a panel seeded with its defaults
 * stores every declared axis, so the member is the axis's declared position.
 */
function axisMember(info: PropertyInfo, schema: PluginParamSchema, axis: string): number | undefined {
  const axes = paramAxes(schema);
  if (info.dimensions === axes.length) {
    const i = axes.indexOf(axis);
    return i >= 0 ? i : undefined;
  }
  // One stored axis alone is a scalar whose match name is its track.
  return info.dimensions <= 1 && info.matchName.endsWith(`.${axis}`) ? 0 : undefined;
}

/** The number one axis of a point holds in `v`, or undefined. */
function axisNumber(info: PropertyInfo, schema: PluginParamSchema, axis: string, v: Value | undefined): number | undefined {
  const member = axisMember(info, schema, axis);
  if (member === undefined) return undefined;
  const n = numbersOfValue(v)[member];
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** The declared default of a param (or of one axis of a point), as `readPluginParam` falls back to it. */
function declaredDefault(schema: PluginParamSchema, axis?: string): unknown {
  if (axis) {
    const d = schema.default as Record<string, number> | undefined;
    return typeof d?.[axis] === 'number' ? d[axis] : 0;
  }
  return schema.default;
}

/**
 * One param's STATIC value on a layer — what the layer stores, else the
 * declared default (the twin of `readPluginParam`). A keyed param's stored
 * value is its static value, as the legacy reader saw it.
 */
export function mirrorPluginParam(
  m: Pick<PluginParamRead, 'property'>,
  layer: string,
  pluginId: string,
  panelId: string,
  schema: PluginParamSchema,
  axis?: string,
): unknown {
  if (!paramHoldsValue(schema)) return undefined;
  const info = m.property(layer, pluginParamApiPath(pluginId, panelId, schema.name));
  if (info?.kind === 'property' && info.value) {
    const stored = axis ? axisNumber(info, schema, axis, info.value) : plainValue(info.value);
    if (stored !== undefined) return stored;
  }
  return declaredDefault(schema, axis);
}

/** Whether the param carries keyframes on this layer. */
export function mirrorPluginParamAnimated(m: Pick<PluginParamRead, 'keyframes'>, layer: string, pluginId: string, panelId: string, name: string): boolean {
  return m.keyframes(layer, pluginParamApiPath(pluginId, panelId, name)).length > 0;
}

/**
 * A numeric param (or one axis of a point) at comp time `seconds`: the keyed
 * value when it is animated, else its static value (stored or declared
 * default), 0 when it holds no number.
 */
export function mirrorPluginAxisAt(
  m: PluginParamRead,
  layer: string,
  pluginId: string,
  panelId: string,
  schema: PluginParamSchema,
  axis: string | undefined,
  seconds: number,
): number {
  const path = pluginParamApiPath(pluginId, panelId, schema.name);
  if (m.keyframes(layer, path).length > 0) {
    const info = m.property(layer, path);
    const v = m.valueAt(layer, path, secondsToFlicks(seconds));
    const n = info ? (axis ? axisNumber(info, schema, axis, v) : numbersOfValue(v)[0]) : undefined;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  const s = mirrorPluginParam(m, layer, pluginId, panelId, schema, axis);
  return typeof s === 'number' ? s : 0;
}
