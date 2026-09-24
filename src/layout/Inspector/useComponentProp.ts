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
 * Reads come from the document MIRROR (B4, `componentPropValue`): the row wakes
 * only when its own property (or the layer's header / tree) changes. Which
 * component a write lands on is the write seam's business
 * (`componentPropHome`, `isPluginLayerComponent` in @core/engine/propRefs) —
 * the API has no components.
 */

import { useCallback, useMemo } from 'react';
import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useRetainTree } from '@hooks/useMirror';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { componentPropPath, componentPropValue } from '@core/mirror/componentProps';
import { getTime } from '@stores/playbackClockStore';
import { parseColorChannels } from '@core/effects/effects';
import { compTime } from '@core/engine/propRefs';
import { values as apiValues, fieldWrite, fieldBindingForComponentProp, componentOfType, componentPropHome, isPluginLayerComponent } from '@core/engine/propRefs';
import { isLayer } from '@core/engine/doc';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { catalogFor } from '@core/engine/props';
import { trackRef, trackWrites } from './inspectorEdits';
import { useEngineEdit } from './useEngineEdit';

const HEX = /^#?[0-9a-fA-F]{3,8}$/;

/** A prop's registry label on a layer, from the mirror (history labels, the refusal toast). */
function propLabel(nodeId: string | undefined, key: string): string {
  const m = documentMirror();
  const layer = nodeId ? m.layer(nodeId) : undefined;
  return mirrorPropertyMeta(key, layer, layer && nodeId ? m.tree(nodeId) : undefined).label || key;
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
  if (isPluginLayerComponent(nodeId, componentId)) {
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
    const home = componentPropHome(nodeId, key, 'number');
    if (home !== undefined && home !== componentId) return null;
    if (!catalogFor(nodeId).byPath.get(r.ref.path)?.defaultValue) return null;
    return [{ type: 'resetProperty', prop: r.ref, time: compTime(seconds) }];
  }
  if (typeof value === 'number' && Number.isFinite(value) && r.valueType !== 'color') {
    if (componentPropHome(nodeId, key, 'number') !== componentId) return null;
    const writes = trackWrites(nodeId, { [key]: value }, seconds);
    return writes.length > 0 ? [{ type: 'setProperties', writes }] : null;
  }
  if (typeof value === 'string' && HEX.test(value.trim()) && r.valueType === 'color' && r.ref.path && r.members.length === 4) {
    if (componentPropHome(nodeId, key, 'string') !== componentId) return null;
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
    const r = isPluginLayerComponent(nodeId, componentId) ? null : trackRef(nodeId, key);
    if (r && typeof v === 'number' && Number.isFinite(v) && r.valueType !== 'color' && componentPropHome(nodeId, key, 'number') === componentId) {
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
  const names = keys.map((k) => propLabel(nodeId, k)).join(', ');
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
  const label = `Set ${propLabel(nodeId, key)}`;
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

/**
 * The component a row writes: its id, or `{ type }` — the layer's component of
 * that type, resolved at WRITE time by the write seam (a section that reads
 * only the mirror has no component ids to hand over).
 */
export type ComponentRef = string | { type: string };

const TYPE_PREFIX = '\u0000type:';

/** A stable string for a ComponentRef (memo deps; a `{ type }` literal is new every render). */
function refKey(ref: ComponentRef | undefined): string {
  return ref === undefined ? '' : typeof ref === 'string' ? ref : `${TYPE_PREFIX}${ref.type}`;
}

/** The component id behind a ref key, at call time. */
function componentIdOf(nodeId: string, key: string): string | undefined {
  if (!key) return undefined;
  return key.startsWith(TYPE_PREFIX) ? componentOfType(nodeId, key.slice(TYPE_PREFIX.length)) : key;
}

export function useComponentProp(
  nodeId: string | undefined,
  componentRef: ComponentRef | undefined,
  key: string,
): [unknown, (v: unknown) => void, ComponentPropHandle] {
  // B4: the value from the mirror; the row wakes on this property's info only
  // (plus the layer's header, and its tree while the property is not there yet).
  useRetainTree(nodeId);
  const e = useEngineEdit();
  const m = documentMirror();
  const path = nodeId ? componentPropPath(m.tree(nodeId), key) : null;
  useMirrorKeys(nodeId ? [`layer:${nodeId}`, path ? `prop:${nodeId}|${path}` : `tree:${nodeId}`] : []);
  const compKey = refKey(componentRef);
  const value = nodeId && compKey ? componentPropValue(m, nodeId, key) : undefined;

  const set = useCallback((v: unknown) => {
    const componentId = nodeId ? componentIdOf(nodeId, compKey) : undefined;
    if (!nodeId || !componentId) return;
    writeComponentProp(nodeId, componentId, key, v, (label, cmds) => e.send(label, cmds));
  }, [nodeId, compKey, key, e]);

  const handle = useMemo<ComponentPropHandle>(() => {
    const label = `Set ${propLabel(nodeId, key)}`;
    const onEngine = (): boolean => {
      const componentId = nodeId ? componentIdOf(nodeId, compKey) : undefined;
      return !!nodeId && !!componentId && (
        (!isPluginLayerComponent(nodeId, componentId) && trackRef(nodeId, key) !== null)
        || (isLayer(nodeId) && fieldBindingForComponentProp(nodeId, componentId, key) !== null));
    };
    return { scrub: e.scrub(label, onEngine), press: e.press(label, onEngine), active: () => e.active() };
  }, [e, key, nodeId, compKey]);

  return [value, set, handle];
}

export default useComponentProp;
