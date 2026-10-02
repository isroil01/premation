/**
 * A legacy writer's effect on EXISTING layers, as engine commands (B4 round 8,
 * the owner-write bridge — animEditBridge.ts).
 *
 * The writer runs OFF-DOCUMENT (offDocument.ts: the page document is restored
 * afterwards) and every layer it touched is compared through the API model —
 * the same records `getDocument` answers — before and after:
 *
 *   keyframes    setKeyframes per property whose keys differ (setAnimated off
 *                where they all went), member tracks folded into their property
 *   static value setProperties for a non-animated property whose value differs
 *   expression   setExpression (whole property, or per member)
 *   switches     setLayerSwitches (3D, visibility, motion blur, …)
 *   parent       setParent (no compensation: the writer already placed it)
 *   timing       setLayerTiming (in / out / start / stretch)
 *
 * What it cannot express is returned in `unexpressed`: a writer that created
 * or removed a layer, or touched something that is not a layer (an item, a
 * composition, a timeline) — the caller reports it.
 *
 * No React (src/core).
 */

import type { Command, Keyframe, LayerSwitches, LayerSwitchesPatch, LayerTiming, PropertyInfo, Value } from '@motion/engine-api';
import { offDocument } from './offDocument';
import { keyframeSets, layerSwitches, layerTiming, propertyTree } from './model';
import { catalogFor } from './props';
import { graph } from './doc';
import { apiParentOf, isLayer } from '@core/mirror/docFacts';

interface LayerState {
  keys: Map<string, Keyframe[]>;
  props: Map<string, PropertyInfo>;
  switches: LayerSwitches | null;
  parent: string | null;
  timing: LayerTiming | null;
}

function stateOf(layer: string): LayerState | null {
  if (!isLayer(layer)) return null;
  const node = graph.getNode(layer);
  if (!node) return null;
  let cat;
  try {
    cat = catalogFor(layer);
  } catch {
    return null;
  }
  const keys = new Map<string, Keyframe[]>();
  for (const s of keyframeSets(layer, cat)) {
    if (cat.byPath.get(s.prop.path)?.animatable !== false) keys.set(s.prop.path, s.keyframes);
  }
  const props = new Map<string, PropertyInfo>();
  for (const p of propertyTree(layer, cat)) if (p.kind !== 'group') props.set(p.path, p);
  let timing: LayerTiming | null = null;
  try {
    timing = layerTiming(layer);
  } catch {
    timing = null;
  }
  return { keys, props, switches: layerSwitches(node), parent: apiParentOf(layer), timing };
}

const json = (v: unknown): string => JSON.stringify(v ?? null);
const strip = (l: readonly Keyframe[] | undefined): string => json((l ?? []).map(({ id: _id, ...k }) => k));

/** One key per API time (member tracks keyed separately may sit an epsilon apart). */
function onePerTime(keys: readonly Keyframe[]): Keyframe[] {
  const seen = new Set<number>();
  return keys.filter((k) => (seen.has(k.time) ? false : (seen.add(k.time), true)));
}

function layerCommands(layer: string, a: LayerState, b: LayerState): Command[] {
  const out: Command[] = [];
  // Parent first: the property values below were written in the new parent's space.
  if (a.parent !== b.parent) {
    out.push({ type: 'setParent', layers: [layer], ...(b.parent ? { parent: b.parent } : {}), keepWorldTransform: false } as Command);
  }
  if (a.switches && b.switches) {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b.switches)) {
      if (json((a.switches as unknown as Record<string, unknown>)[k]) !== json(v)) patch[k] = v;
    }
    if (Object.keys(patch).length > 0) out.push({ type: 'setLayerSwitches', layers: [layer], patch: patch as LayerSwitchesPatch } as Command);
  }
  if (a.timing && b.timing) {
    const t: Record<string, unknown> = {};
    for (const k of ['inPoint', 'outPoint', 'startTime', 'stretch'] as const) {
      if (a.timing[k] !== b.timing[k]) t[k] = b.timing[k];
    }
    if (Object.keys(t).length > 0) out.push({ type: 'setLayerTiming', items: [{ layer, ...t }] } as Command);
  }
  const writes: Array<{ prop: { layer: string; path: string }; value: Value }> = [];
  for (const [path, p] of b.props) {
    const was = a.props.get(path);
    if (!was) continue;
    if (!p.animated && p.value !== undefined && json(p.value) !== json(was.value)) {
      writes.push({ prop: { layer, path }, value: p.value });
    }
  }
  if (writes.length > 0) out.push({ type: 'setProperties', writes } as Command);
  for (const path of new Set([...a.keys.keys(), ...b.keys.keys()])) {
    const ka = a.keys.get(path);
    const kb = b.keys.get(path);
    if (strip(ka) === strip(kb)) continue;
    if (!kb?.length && !ka?.length) continue;
    if (kb && kb.length > 0) out.push({ type: 'setKeyframes', prop: { layer, path }, keys: onePerTime(kb) } as Command);
    else out.push({ type: 'setAnimated', prop: { layer, path }, animated: false, time: ka?.[0]?.time ?? 0 } as Command);
  }
  for (const [path, p] of b.props) {
    const was = a.props.get(path);
    if (!was) continue;
    if (was.expression !== p.expression || was.expressionEnabled !== p.expressionEnabled) {
      out.push({ type: 'setExpression', prop: { layer, path }, source: p.expression, enabled: p.expressionEnabled } as Command);
    }
    const ma = json(was.memberExpressions);
    const mb = json(p.memberExpressions);
    if (ma !== mb) {
      for (const e of p.memberExpressions ?? []) {
        const old = (was.memberExpressions ?? []).find((x) => x.member === e.member);
        if (json(old) === json(e)) continue;
        out.push({ type: 'setExpression', prop: { layer, path }, source: e.source, enabled: e.enabled, member: e.member } as Command);
      }
      for (const old of was.memberExpressions ?? []) {
        if ((p.memberExpressions ?? []).some((x) => x.member === old.member)) continue;
        out.push({ type: 'setExpression', prop: { layer, path }, source: '', enabled: true, member: old.member } as Command);
      }
    }
  }
  return out;
}

export interface LayerDiffPlan<T> {
  value: T;
  cmds: Command[];
  /** Changed state keys the commands cannot carry (new / removed layers, items, compositions…). */
  unexpressed: string[];
}

/** Run `build` off-document and return the commands that make its changes to existing layers. */
export function layerDiffCommands<T>(build: () => T): LayerDiffPlan<T> {
  const run = offDocument(build, ({ value, changed }) => {
    const layers = new Set<string>();
    const unexpressed: string[] = [];
    for (const key of changed) {
      const sep = key.indexOf(':');
      const kind = key.slice(0, sep);
      const id = key.slice(sep + 1);
      if ((kind === 'anim' || kind === 'node') && id) layers.add(id);
      // Incidental to a layer change the layer diff carries (its bar, the stack).
      else if (kind === 'clips' || kind === 'tl' || key === 'order') continue;
      else unexpressed.push(key);
    }
    const after = new Map<string, LayerState | null>();
    for (const id of layers) after.set(id, stateOf(id));
    return { value, layers, after, unexpressed };
  });
  const cmds: Command[] = [];
  const unexpressed = [...run.unexpressed];
  for (const id of run.layers) {
    const a = stateOf(id);
    const b = run.after.get(id) ?? null;
    // A composition root's node changes with its children (a reparent): carried by the layers.
    if (!a && !b && graph.getNode(id) && !graph.getNode(id)!.parent) continue;
    if (!a || !b) {
      unexpressed.push(`layer:${id}`);
      continue;
    }
    cmds.push(...layerCommands(id, a, b));
  }
  return { value: run.value, cmds, unexpressed };
}
