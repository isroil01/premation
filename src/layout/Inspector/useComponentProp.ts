/**
 * useComponentProp — `useNodeComponentProp`'s replacement for inspector rows
 * (B3, docs/B3_PATTERNS.md): the same `[value, set]` over one component prop,
 * but the write goes through the engine API when the engine addresses that
 * prop, as ONE command (a scrub: ONE gesture — spread `scrub` onto the
 * ValueField).
 *
 * The engine addresses a component prop when its property catalog lists it
 * (props.ts `catalogFor` — the timeline's property rows: transform, camera
 * zoom, light intensity/radius, material/geometry options, effect and style
 * params, a solid's size…) AND the engine's static writer would land it on THIS
 * component (it writes the first component carrying the prop). Numbers and
 * colour hexes are sent as values; `undefined` on a number ("back to its
 * neutral value") is `resetProperty`. A Text component's static fields (font,
 * style, justification, box, OpenType… — G1 `text/<key>`), a layer's own fill
 * colour (`layer/fill`) and the B3z LAYER FIELDS (a light's type, a material's
 * shading, a primitive's shape… — layerFieldSpecs.ts) are sent as typed field
 * values. There is NO pre-API writer any more (B3z): a prop the engine does not
 * address (a node that is not a layer, a prop outside the catalog) is refused
 * with a toast — never written around the engine.
 *
 * Reads stay direct (B4's mirror replaces them) and follow the node revision,
 * which both the engine's legacy refresh and the legacy writer bump.
 */

import { useCallback, useMemo } from 'react';
import type { Command } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { useNodeRevision } from '@hooks/useNodeRevision';
import { getTime } from '@stores/playbackClockStore';
import { parseColorChannels } from '@core/effects/effects';
import { compTime } from '@core/engine/propRefs';
import { values as apiValues, fieldWrite, fieldBindingForComponentProp } from '@core/engine/propRefs';
import { isLayer } from '@core/engine/doc';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { catalogFor } from '@core/engine/props';
import { PLUGIN_LAYER_COMPONENT_PREFIX } from '@core/engine/pluginProps';
import { trackRef, trackWrites } from './inspectorEdits';
import { useEngineEdit } from './useEngineEdit';

const HEX = /^#?[0-9a-fA-F]{3,8}$/;

/** A plugin layer kind's component (its props are `plugin/<key>`, never bare keys). */
function isPluginKindComponent(nodeId: string, componentId: string): boolean {
  const comp = defaultSceneGraph.getNode(nodeId)?.components.find((c) => c.id === componentId);
  return comp?.type.startsWith(PLUGIN_LAYER_COMPONENT_PREFIX) === true;
}

/** The component the engine's static writer would put `key` on (the first carrying it with that type). */
function engineHome(nodeId: string, key: string, kind: 'number' | 'string'): string | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  const found = node?.components.find((c) => typeof (c.props as Record<string, unknown>)[key] === kind)?.id;
  if (found || kind !== 'number' || !node) return found;
  // A text prop the layer has not stored as a number yet (a string weight,
  // Grouping Alignment): the engine homes it on the Text component (G1).
  if (resolvePropertyMeta(key, nodeId).group === 'text') return node.components.find((c) => c.type === 'Text')?.id;
  // Any other number no component stores yet (a LATENT binding — a light's
  // Falloff Distance, a camera's Iris Rotation, a morph weight): its HOME
  // (props.ts writeStatic), else the Transform.
  let homes: readonly string[] = ['Transform'];
  try {
    homes = catalogFor(nodeId).byMember.get(key)?.home ?? homes;
  } catch {
    return undefined;
  }
  return homes.map((t) => node.components.find((c) => c.type === t)).find((c) => c !== undefined)?.id;
}

/**
 * The command for "component prop `key` := `value`" on this layer, or null
 * when the engine does not address it (see the header). `seconds` = the
 * playhead (a keyed property takes the value as a key there, AE setValueAtTime).
 */
export function componentPropCommands(
  nodeId: string,
  componentId: string,
  key: string,
  rawValue: unknown,
  seconds: number,
): Command[] | null {
  // A weight picked from a font menu is a CSS weight string ('700'): the engine
  // addresses wght as a number (`text/axes/wght`).
  const value = key === 'fontWeight' && typeof rawValue === 'string' && /^\d+(\.\d+)?$/.test(rawValue.trim()) ? Number(rawValue.trim()) : rawValue;
  // A plugin layer kind's prop (`plugin/<key>`, pluginProps.ts): addressed by
  // its component, never by the bare key (a plugin's `opacity` is not the
  // layer's Opacity).
  if (isPluginKindComponent(nodeId, componentId)) {
    const w = isLayer(nodeId) ? fieldWrite(nodeId, componentId, key, value, seconds) : null;
    return w ? [{ type: 'setProperty', prop: w.prop, value: w.value, ...(w.time !== undefined ? { time: w.time } : {}) }] : null;
  }
  const r = trackRef(nodeId, key);
  if (!r) {
    // A static field (G1): a Text component's strings / choices / switches /
    // box numbers, a layer's own fill colour.
    const w = isLayer(nodeId) ? fieldWrite(nodeId, componentId, key, value, seconds) : null;
    return w ? [{ type: 'setProperty', prop: w.prop, value: w.value, ...(w.time !== undefined ? { time: w.time } : {}) }] : null;
  }
  if (value === undefined && r.members.length === 1 && r.valueType !== 'color') {
    // "Back to the neutral value" (a cleared iris aspect, a centred pan): the
    // property's default — a key at the playhead when it is animated.
    const home = engineHome(nodeId, key, 'number');
    if (home !== undefined && home !== componentId) return null;
    if (!catalogFor(nodeId).byPath.get(r.ref.path)?.defaultValue) return null;
    return [{ type: 'resetProperty', prop: r.ref, time: compTime(seconds) }];
  }
  if (typeof value === 'number' && Number.isFinite(value) && r.valueType !== 'color') {
    if (engineHome(nodeId, key, 'number') !== componentId) return null;
    const writes = trackWrites(nodeId, { [key]: value }, seconds);
    return writes.length > 0 ? [{ type: 'setProperties', writes }] : null;
  }
  if (typeof value === 'string' && HEX.test(value.trim()) && r.valueType === 'color' && r.ref.path && r.members.length === 4) {
    if (engineHome(nodeId, key, 'string') !== componentId) return null;
    const [cr, cg, cb, ca] = parseColorChannels(value);
    return [{ type: 'setProperty', prop: r.ref, value: apiValues.color(cr, cg, cb, ca), time: compTime(seconds) }];
  }
  return null;
}

/**
 * Several props of one component as ONE command list: the numbers the engine
 * addresses are merged per API property (x, y and z are ONE Position write —
 * three separate writes would each re-read the others and undo each other),
 * colours become colour writes, and whatever the engine cannot address comes
 * back in `rest` (the caller refuses it — `reportUnaddressed`).
 */
export function componentPropsCommands(
  nodeId: string,
  componentId: string,
  values: Readonly<Record<string, unknown>>,
  seconds: number,
): { cmds: Command[]; rest: Record<string, unknown> } {
  const nums: Record<string, number> = {};
  const cmds: Command[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(values)) {
    const r = isPluginKindComponent(nodeId, componentId) ? null : trackRef(nodeId, key);
    if (r && typeof v === 'number' && Number.isFinite(v) && r.valueType !== 'color' && engineHome(nodeId, key, 'number') === componentId) {
      nums[key] = v;
      continue;
    }
    const c = componentPropCommands(nodeId, componentId, key, v, seconds);
    if (c) cmds.push(...c);
    else rest[key] = v;
  }
  const writes = trackWrites(nodeId, nums, seconds);
  if (writes.length > 0) cmds.unshift({ type: 'setProperties', writes });
  return { cmds, rest };
}

/**
 * A write the engine does not address is REFUSED, visibly (a toast) — never
 * written around the engine: that would be an edit outside history, outside the
 * command log and outside the C++ engine's document.
 */
export function reportUnaddressed(nodeId: string, keys: readonly string[], label: string): void {
  if (keys.length === 0) return;
  const names = keys.map((k) => resolvePropertyMeta(k, nodeId).label || k).join(', ');
  reportEngineError(label, { code: 'unsupported', message: `${names} cannot be edited here — it is not an engine property of this layer` });
}

/**
 * Write several props of one component as ONE entry. The whole write is refused
 * (nothing sent) when any prop is not addressable: half a write is worse than
 * none.
 */
export function writeComponentProps(nodeId: string, componentId: string, values: Readonly<Record<string, unknown>>, label: string): void {
  const { cmds, rest } = componentPropsCommands(nodeId, componentId, values, getTime());
  const missing = Object.keys(rest);
  if (missing.length > 0) {
    reportUnaddressed(nodeId, missing, label);
    return;
  }
  if (cmds.length > 0) void edit(label, cmds);
}

/** Write one component prop through the engine — one entry (refused when not addressable). */
export function writeComponentProp(nodeId: string, componentId: string, key: string, value: unknown, send: (label: string, cmds: Command[]) => void): void {
  const label = `Set ${resolvePropertyMeta(key, nodeId).label || key}`;
  const cmds = componentPropCommands(nodeId, componentId, key, value, getTime());
  if (cmds) send(label, cmds);
  else reportUnaddressed(nodeId, [key], label);
}

export interface ComponentPropHandle {
  /** ValueField scrub props: a drag of this prop is one gesture (engine route only). */
  scrub: { onScrubStart: () => void; onScrubEnd: () => void };
  /** Wrapper props for a control with no scrub events (a range input): press-drag-release = one gesture. */
  press: { onPointerDownCapture: () => void };
  /** True while this prop's gesture (scrub / press / typing) is open. */
  active: () => boolean;
}

export function useComponentProp(
  nodeId: string | undefined,
  componentId: string | undefined,
  key: string,
): [unknown, (v: unknown) => void, ComponentPropHandle] {
  useNodeRevision(nodeId);
  const e = useEngineEdit();
  const node = nodeId ? defaultSceneGraph.getNode(nodeId) : undefined;
  const comp = componentId ? node?.components.find((c) => c.id === componentId) : undefined;
  const value = comp ? (comp.props as Record<string, unknown>)[key] : undefined;

  const set = useCallback((v: unknown) => {
    if (!nodeId || !componentId) return;
    writeComponentProp(nodeId, componentId, key, v, (label, cmds) => e.send(label, cmds));
  }, [nodeId, componentId, key, e]);

  const handle = useMemo<ComponentPropHandle>(() => {
    const label = `Set ${resolvePropertyMeta(key, nodeId).label || key}`;
    const onEngine = (): boolean => !!nodeId && !!componentId && (
      (!isPluginKindComponent(nodeId, componentId) && trackRef(nodeId, key) !== null)
      || (isLayer(nodeId) && fieldBindingForComponentProp(nodeId, componentId, key) !== null));
    return { scrub: e.scrub(label, onEngine), press: e.press(label, onEngine), active: () => e.active() };
  }, [e, key, nodeId, componentId]);

  return [value, set, handle];
}

export default useComponentProp;
