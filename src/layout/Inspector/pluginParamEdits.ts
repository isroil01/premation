/**
 * pluginParamEdits — a contributed plugin panel's params over the engine API
 * (B3z, docs/ENGINE_API.md §15.9 "Plugin properties"; engine side
 * src/core/engine/pluginProps.ts).
 *
 *   plugin/<slug>/<panel>           the panel's property GROUP (the layer's
 *                                   `PluginParams.<slug>.<panel>` component)
 *   plugin/<slug>/<panel>/<name>    one param (a point = one vec2 / vec3)
 *
 * A layer gains a panel's group the first time somebody sets one of its params
 * — never on selection (uiParams.ts: showing the section is free). The engine
 * has no plugin schema, so the CLIENT seeds it: every write to a layer whose
 * panel is absent is prefixed with `addPropertyGroup` carrying ALL declared
 * defaults (idempotent: adding a panel the layer has changes nothing), in the
 * SAME batch / gesture message — one undo entry, and every gesture message is
 * absolute and self-contained (latest-wins safe). Writes are addressed by PATH
 * (the property may not be in the catalog until the group lands).
 */

import type { Command, KeyframeInsert, PropertyWrite, Value } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { isLayer } from '@core/engine/doc';
import { compTime, values } from '@core/engine/propRefs';
import { readPropertyValue } from '@core/inspector/multiSelection';
import {
  paramAxes,
  paramHoldsValue,
  pluginParamComponentType,
  pluginParamPath,
  pluginParamSlug,
  type PluginInspectorPanelContribution,
  type PluginParamSchema,
} from '@core/plugins/uiParams';
import { pluginParamComponent, readPluginParam } from '@core/plugins/uiParamValues';

/** The API path of one param (a point's axes are members of it). */
export function pluginParamApiPath(pluginId: string, panelId: string, name: string): string {
  return `plugin/${pluginParamSlug(pluginId)}/${panelId}/${name}`;
}

/** A declared default as the Value the panel group's `init` carries (null when it holds none). */
function defaultValue(schema: PluginParamSchema): Value | null {
  const axes = paramAxes(schema);
  if (axes.length > 0) {
    const d = (schema.default && typeof schema.default === 'object' ? schema.default : {}) as Record<string, unknown>;
    const n = (a: string): number => (typeof d[a] === 'number' ? d[a] as number : 0);
    return axes.length === 3 ? values.vec3(n('x'), n('y'), n('z')) : values.vec2(n('x'), n('y'));
  }
  const v = schema.default;
  if (typeof v === 'number') return values.scalar(v);
  if (typeof v === 'boolean') return values.bool(v);
  if (typeof v === 'string') return values.string(v);
  return values.json(v === undefined ? null : v);
}

/**
 * The panel group, seeded with every declared default — [] when the layer has
 * it already (or is not a layer).
 */
export function ensurePanelCommands(nodeId: string, pluginId: string, panel: PluginInspectorPanelContribution): Command[] {
  if (!isLayer(nodeId) || pluginParamComponent(nodeId, pluginId, panel.id)) return [];
  const init: Array<{ path: string; value: Value }> = [];
  for (const p of panel.params) {
    if (!paramHoldsValue(p)) continue;
    const v = defaultValue(p);
    if (v) init.push({ path: p.name, value: v });
  }
  return [{ type: 'addPropertyGroup', layer: nodeId, parent: 'plugin', matchName: pluginParamComponentType(pluginId, panel.id), init }];
}

/** One layer's numeric param (or one axis of a point) at comp time `seconds`, stored units. */
function currentAxis(nodeId: string, pluginId: string, panel: PluginInspectorPanelContribution, schema: PluginParamSchema, axis: string | undefined, seconds: number): number {
  const track = pluginParamPath(pluginId, panel.id, schema.name, axis);
  const sampled = defaultAnimation.isAnimated(nodeId, track) ? readPropertyValue(nodeId, track, seconds) : undefined;
  if (sampled !== undefined) return sampled;
  const v = readPluginParam(nodeId, pluginId, panel.id, schema, axis);
  return typeof v === 'number' ? v : 0;
}

/**
 * "Set this numeric param (or one axis of a point) to `value` on each layer",
 * at the playhead: a key when it is animated (AE setValueAtTime), its first key
 * under Auto-Keyframe, else the static value — each layer's panel seeded first.
 */
export function numericParamCommands(
  pluginId: string,
  panel: PluginInspectorPanelContribution,
  schema: PluginParamSchema,
  axis: string | undefined,
  writes: ReadonlyArray<{ nodeId: string; value: number }>,
  opts: { seconds: number; autoKeyframe: boolean },
): Command[] {
  const ensure: Command[] = [];
  const sets: PropertyWrite[] = [];
  const keys: KeyframeInsert[] = [];
  const axes = paramAxes(schema);
  const time = compTime(opts.seconds);
  for (const w of writes) {
    if (!Number.isFinite(w.value) || !isLayer(w.nodeId)) continue;
    ensure.push(...ensurePanelCommands(w.nodeId, pluginId, panel));
    const nums = axes.length === 0
      ? [w.value]
      : axes.map((a) => (a === axis ? w.value : currentAxis(w.nodeId, pluginId, panel, schema, a, opts.seconds)));
    const value: Value = nums.length === 1 ? values.scalar(nums[0]!) : nums.length === 2 ? values.vec2(nums[0]!, nums[1]!) : values.vec3(nums[0]!, nums[1]!, nums[2]!);
    const prop = { layer: w.nodeId, path: pluginParamApiPath(pluginId, panel.id, schema.name) };
    const tracks = axes.length === 0 ? [pluginParamPath(pluginId, panel.id, schema.name)] : axes.map((a) => pluginParamPath(pluginId, panel.id, schema.name, a));
    const animated = tracks.some((t) => defaultAnimation.isAnimated(w.nodeId, t));
    if (!animated && opts.autoKeyframe) keys.push({ prop, time, value, spatialIn: [], spatialOut: [] });
    else sets.push({ prop, value, time });
  }
  const out: Command[] = [...ensure];
  if (sets.length > 0) out.push({ type: 'setProperties', writes: sets });
  if (keys.length > 0) out.push({ type: 'addKeyframes', keys });
  return out;
}

/** The stopwatch ON for a param on layers whose panel may not exist yet (the seeded default becomes the first key). */
export function paramStopwatchCommands(
  pluginId: string,
  panel: PluginInspectorPanelContribution,
  schema: PluginParamSchema,
  nodeIds: ReadonlyArray<string>,
  seconds: number,
): Command[] {
  const layers = nodeIds.filter((id) => isLayer(id));
  return [
    ...layers.flatMap((id) => ensurePanelCommands(id, pluginId, panel)),
    ...layers.map((layer): Command => ({
      type: 'setAnimated', prop: { layer, path: pluginParamApiPath(pluginId, panel.id, schema.name) }, animated: true, time: compTime(seconds),
    })),
  ];
}

/** A non-numeric param (checkbox, enum value, colour hex) on every layer — each panel seeded first. */
export function staticParamCommands(
  pluginId: string,
  panel: PluginInspectorPanelContribution,
  schema: PluginParamSchema,
  nodeIds: ReadonlyArray<string>,
  value: unknown,
): Command[] {
  const v: Value = typeof value === 'boolean' ? values.bool(value)
    : typeof value === 'string' ? values.string(value)
      : typeof value === 'number' ? values.scalar(value)
        : values.json(value === undefined ? null : value);
  const layers = nodeIds.filter((id) => isLayer(id));
  const writes: PropertyWrite[] = layers.map((layer) => ({ prop: { layer, path: pluginParamApiPath(pluginId, panel.id, schema.name) }, value: v }));
  if (writes.length === 0) return [];
  return [...layers.flatMap((id) => ensurePanelCommands(id, pluginId, panel)), { type: 'setProperties', writes }];
}
