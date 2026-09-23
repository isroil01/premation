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
 * colour hexes are sent as values; anything else — booleans, enums, strings,
 * structured values, props the catalog does not list — is an ENGINE GAP and
 * keeps the pre-API writer, in exactly one place: `legacyComponentWrite` below.
 *
 * Reads stay direct (B4's mirror replaces them) and follow the node revision,
 * which both the engine's legacy refresh and the legacy writer bump.
 */

import { useCallback, useMemo } from 'react';
import type { Command } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { useNodeRevision } from '@hooks/useNodeRevision';
import { getTime } from '@stores/playbackClockStore';
import { parseColorChannels } from '@core/effects/effects';
import { compTime } from '@core/engine/propRefs';
import { values as apiValues } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { trackRef, trackWrites } from './inspectorEdits';
import { useEngineEdit } from './useEngineEdit';

const HEX = /^#?[0-9a-fA-F]{3,8}$/;

/** The component the engine's static writer would put `key` on (the first carrying it with that type). */
function engineHome(nodeId: string, key: string, kind: 'number' | 'string'): string | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  return node?.components.find((c) => typeof (c.props as Record<string, unknown>)[key] === kind)?.id;
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
  value: unknown,
  seconds: number,
): Command[] | null {
  const r = trackRef(nodeId, key);
  if (!r) return null;
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
 * back in `rest` for the legacy writer.
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
    const r = trackRef(nodeId, key);
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

/** Write several props of one component as ONE entry where the engine addresses them. */
export function writeComponentProps(nodeId: string, componentId: string, values: Readonly<Record<string, unknown>>, label: string): void {
  const { cmds, rest } = componentPropsCommands(nodeId, componentId, values, getTime());
  if (cmds.length > 0) void edit(label, cmds);
  for (const [k, v] of Object.entries(rest)) legacyComponentWrite(nodeId, componentId, k, v);
}

/**
 * The pre-API component write — every inspector write the engine cannot
 * address yet funnels through here (see the header for which).
 */
export function legacyComponentWrite(nodeId: string, componentId: string, key: string, value: unknown): boolean {
  // B3-legacy: engine gap — component props outside the engine catalog (booleans, enums, strings, structured values, unlisted numbers); needs a generic `layer/<prop>` binding.
  return updateNodeComponentProp(defaultSceneGraph, nodeId, componentId, key, value);
}

/** Write one component prop: engine when addressed, else the legacy writer. One entry. */
export function writeComponentProp(nodeId: string, componentId: string, key: string, value: unknown, send: (label: string, cmds: Command[]) => void): void {
  const cmds = componentPropCommands(nodeId, componentId, key, value, getTime());
  if (cmds) send(`Set ${resolvePropertyMeta(key, nodeId).label || key}`, cmds);
  else legacyComponentWrite(nodeId, componentId, key, value);
}

export interface ComponentPropHandle {
  /** ValueField scrub props: a drag of this prop is one gesture (engine route only). */
  scrub: { onScrubStart: () => void; onScrubEnd: () => void };
  /** Wrapper props for a control with no scrub events (a range input): press-drag-release = one gesture. */
  press: { onPointerDownCapture: () => void };
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
    const onEngine = (): boolean => !!nodeId && !!componentId && trackRef(nodeId, key) !== null;
    return { scrub: e.scrub(label, onEngine), press: e.press(label, onEngine) };
  }, [e, key, nodeId, componentId]);

  return [value, set, handle];
}

export default useComponentProp;
