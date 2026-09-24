/**
 * Expression controls as API property groups (B3, controlSpecs.ts):
 * `effects/ctrl_<name>` — matchName `ADBE Slider Control` … — with one value
 * property `effects/ctrl_<name>/<param>` bound to the stored numbers
 * `ctrl_<name><suffix>` on the layer's Transform component. Keyframes and
 * expressions live on those numbers' tracks, so `ctrl('<name>')` and saved
 * documents read exactly what they always did.
 *
 * C++ counterpart: native/engine/src/core/controls.cpp (the same rules, the
 * same order — the property tree is compared across engines).
 */

import { defaultAnimation } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { flattenScene } from '@core/scene/sceneDerive';
import { fail } from './errors';
import { graph } from './doc';
import {
  CONTROL_PREFIX,
  CONTROL_KIND_PREFIX,
  CONTROL_SPECS,
  controlSpecForMarker,
  nextFreeControlName,
  type ControlSpec,
} from './controlSpecs';
import type { PropBinding } from './props';

export interface LayerControl {
  name: string;
  spec: ControlSpec;
}

type Props = Record<string, unknown>;

function transformOf(node: SceneNode): { id: string; props: Props } | undefined {
  return node.components.find((c) => c.type === 'Transform') as { id: string; props: Props } | undefined;
}

/** The group id / path of a control. */
export const controlGroupId = (name: string): string => `${CONTROL_PREFIX}${name}`;
export const controlGroupPath = (name: string): string => `effects/${controlGroupId(name)}`;

/** The stored numbers behind a control's value, in value order. */
export const controlMembers = (c: LayerControl): string[] => c.spec.components.map((s) => `${CONTROL_PREFIX}${c.name}${s}`);

/**
 * A layer's controls in storage order (the Transform's key order). A control
 * exists while one of its numbers is stored; its kind is `ctrlkind_<name>`
 * (absent = slider). A number `ctrl_<s>` belongs to the kinded control whose
 * name + a component suffix spells `s`, else it is a slider named `s` (unless
 * a kinded control of another shape already owns that name). Names that could
 * not be a path segment (empty, containing `/`) are not exposed.
 */
export function readControls(node: SceneNode): LayerControl[] {
  const t = transformOf(node);
  if (!t) return [];
  const kinds: Array<[string, ControlSpec]> = [];
  for (const [k, v] of Object.entries(t.props)) {
    if (k.startsWith(CONTROL_KIND_PREFIX) && typeof v === 'string') kinds.push([k.slice(CONTROL_KIND_PREFIX.length), controlSpecForMarker(v)]);
  }
  const out: LayerControl[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(t.props)) {
    if (!k.startsWith(CONTROL_PREFIX) || typeof v !== 'number') continue;
    const s = k.slice(CONTROL_PREFIX.length);
    let owner: LayerControl | undefined;
    for (const [name, spec] of kinds) {
      if (spec.components.some((sfx) => name + sfx === s)) { owner = { name, spec }; break; }
    }
    if (!owner) {
      if (kinds.some(([name]) => name === s)) continue;
      owner = { name: s, spec: CONTROL_SPECS[0]! };
    }
    if (owner.name === '' || owner.name.includes('/') || seen.has(owner.name)) continue;
    seen.add(owner.name);
    out.push(owner);
  }
  return out;
}

/** The value bindings of a layer's controls (props.ts catalogFor). */
export function controlBindings(node: SceneNode): PropBinding[] {
  return readControls(node).map((c) => ({
    path: `${controlGroupPath(c.name)}/${c.spec.param}`,
    name: c.spec.propName,
    matchName: c.spec.propMatchName,
    valueType: c.spec.valueType,
    members: controlMembers(c),
    animatable: true,
    unit: c.spec.unit,
  }));
}

/** Group info of `effects/ctrl_<name>` (null when not a control of this layer). */
export function controlGroupInfo(node: SceneNode, path: string): { name: string; matchName: string; enabled: boolean; kind: 'group' } | null {
  const c = resolveControl(node, path);
  return c ? { name: c.name, matchName: c.spec.matchName, enabled: true, kind: 'group' } : null;
}

/** The control a group path names on this layer. */
export function resolveControl(node: SceneNode, path: string): LayerControl | null {
  const seg = path.split('/');
  if (seg.length !== 2 || seg[0] !== 'effects' || !seg[1]!.startsWith(CONTROL_PREFIX)) return null;
  const name = seg[1]!.slice(CONTROL_PREFIX.length);
  return readControls(node).find((c) => c.name === name) ?? null;
}

/** Every control VALUE name stored in the document (`nextControlName`'s "taken" set). */
function takenNames(): string[] {
  const out: string[] = [];
  for (const n of flattenScene(graph)) {
    const t = transformOf(n);
    if (!t) continue;
    for (const [k, v] of Object.entries(t.props)) if (k.startsWith(CONTROL_PREFIX) && typeof v === 'number') out.push(k.slice(CONTROL_PREFIX.length));
  }
  return out;
}

/** A control name the API accepts: trimmed, non-empty, no `/`. */
function validName(raw: string): string {
  const name = raw.trim();
  if (name === '' || name.includes('/')) fail('invalidArgument', `'${raw}' is not a control name (empty, or contains '/')`);
  return name;
}

/** Refuse a name another control of the layer — or any of its stored keys — already uses. */
function requireFree(node: SceneNode, t: { props: Props }, spec: ControlSpec, name: string): void {
  const clash = readControls(node).some((c) => c.name === name)
    || spec.components.some((sfx) => t.props[`${CONTROL_PREFIX}${name}${sfx}`] !== undefined)
    || t.props[`${CONTROL_KIND_PREFIX}${name}`] !== undefined;
  if (clash) fail('conflict', `layer '${node.id}' already has a control named '${name}'`, { layer: node.id, path: controlGroupPath(name) });
}

/**
 * `addPropertyGroup{parent:'effects', matchName:'ADBE <Kind> Control', name?}`:
 * validates now, returns the writer (the kind's default numbers, then the kind
 * marker — what the legacy `addControl` wrote). The generic handler applies `init`.
 */
export function planControlAdd(node: SceneNode, spec: ControlSpec, name: string | undefined, index: number | undefined): () => string {
  const t = transformOf(node);
  if (!t) fail('invalidArgument', `layer '${node.id}' has no Transform to hold an expression control`, { layer: node.id });
  if (index !== undefined) fail('unsupported', 'expression controls are appended; they have no index', { layer: node.id, path: 'effects' });
  const final = name !== undefined && name.trim() !== '' ? validName(name) : nextFreeControlName(spec, takenNames());
  requireFree(node, t, spec, final);
  const layer = node.id;
  return () => {
    const tid = liveTransform(layer).id;
    spec.components.forEach((sfx, i) => graph.writeProp(layer, tid, `${CONTROL_PREFIX}${final}${sfx}`, spec.defaults[i] ?? 0));
    graph.writeProp(layer, tid, `${CONTROL_KIND_PREFIX}${final}`, spec.kind);
    return controlGroupPath(final);
  };
}

/** Rename (or drop, `to` = null) exact keyframe tracks / expressions / data tracks of a layer. */
function remapTracks(layer: string, map: ReadonlyMap<string, string | null>): void {
  const snap = defaultAnimation.snapshotNode(layer);
  if (!snap) return;
  const pick = <V>(section: Record<string, V>, fix?: (k: string, v: V) => V): Record<string, V> => {
    const keep: Record<string, V> = {};
    const moved: Record<string, V> = {};
    for (const [k, v] of Object.entries(section)) {
      if (!map.has(k)) { keep[k] = v; continue; }
      const to = map.get(k);
      if (to) moved[to] = fix ? fix(to, v) : v;
    }
    return { ...keep, ...moved };
  };
  defaultAnimation.restoreNode(layer, {
    tracks: pick(snap.tracks),
    expressions: pick(snap.expressions),
    data: pick(snap.data, (k, v) => ({ ...v, prop: k })),
  });
}

/** The live Transform of a layer (re-read at apply time: writes replace component objects). */
function liveTransform(layer: string): { id: string; props: Props } {
  return transformOf(graph.getNode(layer)!)!;
}

/** Remove a control: its numbers, its kind marker, and every key / expression on its numbers. */
export function removeControlGroup(layer: string, c: LayerControl): void {
  const tid = liveTransform(layer).id;
  const members = controlMembers(c);
  for (const m of members) graph.writeProp(layer, tid, m, undefined);
  graph.writeProp(layer, tid, `${CONTROL_KIND_PREFIX}${c.name}`, undefined);
  remapTracks(layer, new Map(members.map((m) => [m, null])));
}

/** Validate a rename; returns the writer. The group's path follows the name. */
export function planControlRename(node: SceneNode, c: LayerControl, raw: string): () => void {
  const name = validName(raw);
  if (name === c.name) return () => undefined;
  requireFree(node, transformOf(node)!, c.spec, name);
  const layer = node.id;
  return () => {
    const move = (from: string, to: string): void => {
      const t = liveTransform(layer);
      const v = t.props[from];
      if (v === undefined) return;
      graph.writeProp(layer, t.id, to, v);
      graph.writeProp(layer, t.id, from, undefined);
    };
    const map = new Map<string, string>();
    for (const sfx of c.spec.components) {
      const from = `${CONTROL_PREFIX}${c.name}${sfx}`;
      const to = `${CONTROL_PREFIX}${name}${sfx}`;
      map.set(from, to);
      move(from, to);
    }
    move(`${CONTROL_KIND_PREFIX}${c.name}`, `${CONTROL_KIND_PREFIX}${name}`);
    remapTracks(layer, map);
  };
}

/** listGroupTypes rows (parent `effects`). */
export const CONTROL_GROUP_TYPES: Array<{ parent: string; matchName: string; displayName: string; category: string }> =
  CONTROL_SPECS.map((s) => ({ parent: 'effects', matchName: s.matchName, displayName: s.label, category: 'controls' }));
