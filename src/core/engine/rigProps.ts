/**
 * Puppet pins and skeletons as API property groups and properties (B3z WS-R,
 * ENGINE_API.md §15.9 "Rigging — puppet and skeleton paths"): the catalog
 * bindings, their static reads and writes, and the group operations
 * (`addPropertyGroup`, `removePropertyGroups`, `movePropertyGroup`,
 * `renamePropertyGroup`, `setGroupEnabled`, the IK pole's `addProperties` /
 * `removeProperties`). The property table both engines read is
 * `rigSpecs.ts`; the C++ port is `native/engine/src/core/rig.cpp`.
 *
 *   puppet                              fx.puppet (After Effects' Puppet effect)
 *   puppet/mesh/<field>                 the rig's mesh settings
 *   puppet/pins/<pin>/<prop>            one pin (AE Deform ▸ Puppet Pin N)
 *   skeleton                            fx.skeleton
 *   skeleton/mesh/<field>, skeleton/weightPaint
 *   skeleton/bones/<bone>/<prop>        one bone
 *   skeleton/bones/<bone>/ik/<prop>     the IK goal whose end bone this is
 *   skeleton/controllers/<ctrl>/<prop>  one rig controller
 */

import { defaultAnimation } from '@motion/animation';
import type { Value, PropertyKind } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { fail } from './errors';
import { graph } from './doc';
import { dropTrackProps } from './fields';
import { RIG_PROPS, RIG_GROUP_MATCH, RIG_MESH_DENSITY_DEFAULT, type RigOwner, type RigPropSpec } from './rigSpecs';
import type { PropBinding } from './props';

/** A rig binding's storage: the spec and the owner's id (a pin, a bone; an IK goal = its bone). */
export interface RigRef {
  owner: RigOwner;
  /** Owner id ('' for the puppet / skeleton themselves). */
  id: string;
  /** The spec's path under the owner group. */
  spec: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const DEG = 180 / Math.PI;

function scaleOf(spec: RigPropSpec): number {
  return spec.scale === 'percent' ? 100 : spec.scale === 'radians' ? DEG : 1;
}

function specFor(owner: RigOwner, path: string): RigPropSpec | undefined {
  return RIG_PROPS.find((s) => s.owner === owner && s.path === path);
}

function specOf(b: PropBinding): RigPropSpec {
  const s = b.rig ? specFor(b.rig.owner, b.rig.spec) : undefined;
  if (!s) fail('internal', `'${b.path}' is not a rig property`, { path: b.path });
  return s;
}

/** API units per stored unit for a rig keyframe TRACK (props.ts `apiUnitFactor`). */
export function rigMemberFactor(member: string): number | undefined {
  if (/^puppet\.[^.]+\.scale$/.test(member)) return 100;
  if (/^bone\.[^.]+\.scale[XY]$/.test(member)) return 100;
  if (/^bone\.[^.]+\.rotation$/.test(member)) return DEG;
  return undefined;
}

// ── Reading the rig ─────────────────────────────────────────────────

function fxOf(node: SceneNode): Obj | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Obj | undefined;
}

export function puppetOf(node: SceneNode): Obj | undefined {
  const p = fxOf(node)?.puppet;
  return isObj(p) ? p : undefined;
}

export function skeletonOf(node: SceneNode): Obj | undefined {
  const s = fxOf(node)?.skeleton;
  return isObj(s) ? s : undefined;
}

function listOf(o: Obj | undefined, key: string): Obj[] {
  const v = o?.[key];
  return Array.isArray(v) ? v.filter(isObj) : [];
}

/** Entries of a rig list that carry a string id (the ones the API can address). */
function withIds(list: Obj[], idKey = 'id'): Obj[] {
  return list.filter((x) => typeof x[idKey] === 'string');
}

function getKey(o: Obj, key: string): unknown {
  const dot = key.indexOf('.');
  if (dot < 0) return o[key];
  const inner = o[key.slice(0, dot)];
  return isObj(inner) ? inner[key.slice(dot + 1)] : undefined;
}

function setKey(o: Obj, key: string, v: unknown): Obj {
  const dot = key.indexOf('.');
  if (dot < 0) {
    const out = { ...o };
    if (v === undefined) delete out[key];
    else out[key] = v;
    return out;
  }
  const head = key.slice(0, dot);
  const inner = isObj(o[head]) ? (o[head] as Obj) : {};
  return { ...o, [head]: setKey(inner, key.slice(dot + 1), v) };
}

/** The owner object of a rig binding (undefined when it vanished). */
function ownerObject(node: SceneNode, ref: RigRef): Obj | undefined {
  switch (ref.owner) {
    case 'layer': return fxOf(node) ?? {};
    case 'puppet': return puppetOf(node);
    case 'skeleton': return skeletonOf(node);
    case 'pin': return withIds(listOf(puppetOf(node), 'pins')).find((p) => p.id === ref.id);
    case 'bone': return withIds(listOf(skeletonOf(node), 'bones')).find((b) => b.id === ref.id);
    case 'ik': return withIds(listOf(skeletonOf(node), 'ikTargets'), 'boneId').find((t) => t.boneId === ref.id);
    case 'controller': return withIds(listOf(skeletonOf(node), 'controllers')).find((c) => c.id === ref.id);
  }
}

// ── Bindings ─────────────────────────────────────────────────────────

function binding(owner: RigOwner, id: string, base: string, spec: RigPropSpec): PropBinding {
  const k = scaleOf(spec);
  const members = (spec.tracks ?? []).map((t) => t.replace('{id}', id));
  const def = spec.default;
  let defaultValue: Value | undefined;
  if (spec.type === 'scalar' && typeof def === 'number') defaultValue = { kind: 'scalar', value: def * k };
  else if (spec.type === 'vec2' && Array.isArray(def)) defaultValue = { kind: 'vec2', value: { x: def[0]! * k, y: def[1]! * k } };
  else if (spec.type === 'choice' && typeof def === 'string') defaultValue = { kind: 'choice', value: def };
  else if (spec.type === 'string' && typeof def === 'string') defaultValue = { kind: 'string', value: def };
  else if (spec.type === 'json') defaultValue = { kind: 'json', value: 'null' };
  return {
    path: `${base}/${spec.path}`,
    name: spec.label,
    matchName: spec.matchName,
    valueType: spec.type,
    members,
    ...(spec.dataTrack ? { dataTrack: spec.dataTrack.replace('{id}', id) } : {}),
    special: 'rig',
    rig: { owner, id, spec: spec.path },
    animatable: members.length > 0 || spec.dataTrack !== undefined,
    unit: spec.unit ?? '',
    ...(spec.min !== undefined ? { min: spec.min } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    ...(spec.choices ? { choices: [...spec.choices] } : {}),
    ...(defaultValue ? { defaultValue } : {}),
  };
}

function hasTrack(layerId: string, prop: string): boolean {
  return (defaultAnimation.getTrackKeyframes(layerId, prop)?.length ?? 0) > 0;
}

/** Whether an IK goal carries its optional pole (a stored pole, or pole keys). */
function hasPole(layerId: string, target: Obj, boneId: string): boolean {
  return isObj(target.pole) || hasTrack(layerId, `ikPole.${boneId}.x`) || hasTrack(layerId, `ikPole.${boneId}.y`);
}

/** Every rig binding of a layer, in catalog order (props.ts calls this before the unclaimed tracks). */
export function addRigBindings(node: SceneNode, layerId: string, add: (b: PropBinding) => void): void {
  const specs = (owner: RigOwner): RigPropSpec[] => RIG_PROPS.filter((s) => s.owner === owner);
  if (canRig(node)) for (const s of specs('layer')) add(binding('layer', '', 'layer', s));
  const puppet = puppetOf(node);
  if (puppet) {
    for (const s of specs('puppet')) add(binding('puppet', '', 'puppet', s));
    for (const pin of withIds(listOf(puppet, 'pins'))) {
      const id = pin.id as string;
      for (const s of specs('pin')) add(binding('pin', id, `puppet/pins/${id}`, s));
    }
  }
  const skel = skeletonOf(node);
  if (skel) {
    for (const s of specs('skeleton')) add(binding('skeleton', '', 'skeleton', s));
    const targets = withIds(listOf(skel, 'ikTargets'), 'boneId');
    for (const bone of withIds(listOf(skel, 'bones'))) {
      const id = bone.id as string;
      for (const s of specs('bone')) add(binding('bone', id, `skeleton/bones/${id}`, s));
      const target = targets.find((t) => t.boneId === id);
      if (!target) continue;
      for (const s of specs('ik')) {
        if (s.optional && !hasPole(layerId, target, id)) continue;
        add(binding('ik', id, `skeleton/bones/${id}/ik`, s));
      }
    }
    for (const c of withIds(listOf(skel, 'controllers'))) {
      const id = c.id as string;
      for (const s of specs('controller')) add(binding('controller', id, `skeleton/controllers/${id}`, s));
    }
  }
}

/** The rig groups that exist even when empty, in order (props.ts ensures them). */
export function rigGroupPaths(node: SceneNode): string[] {
  const out: string[] = [];
  if (puppetOf(node)) out.push('puppet', 'puppet/mesh', 'puppet/pins');
  if (skeletonOf(node)) out.push('skeleton', 'skeleton/mesh', 'skeleton/bones', 'skeleton/controllers');
  return out;
}

export interface RigGroupInfo {
  name: string;
  matchName: string;
  enabled: boolean;
  kind: PropertyKind;
}

/** Name / match name / switch of a rig group path (null: not a rig group). */
export function rigGroupInfo(node: SceneNode, path: string): RigGroupInfo | null {
  const seg = path.split('/');
  const g = (name: string, matchName: string, kind: PropertyKind = 'group', enabled = true): RigGroupInfo => ({ name, matchName, enabled, kind });
  if (seg[0] === 'puppet') {
    if (seg.length === 1) return g('Puppet', RIG_GROUP_MATCH.puppet);
    if (path === 'puppet/mesh') return g('Mesh', 'ADBE FreePin3 Mesh Atom');
    if (path === 'puppet/pins') return g('Deform', 'ADBE FreePin3 PosPins', 'indexedGroup');
    if (seg[1] === 'pins' && seg.length === 3) {
      const pin = withIds(listOf(puppetOf(node), 'pins')).find((p) => p.id === seg[2]);
      return g(typeof pin?.name === 'string' && pin.name !== '' ? pin.name : seg[2]!, RIG_GROUP_MATCH.pin);
    }
    return null;
  }
  if (seg[0] === 'skeleton') {
    const skel = skeletonOf(node);
    if (seg.length === 1) return g('Skeleton', RIG_GROUP_MATCH.skeleton);
    if (path === 'skeleton/mesh') return g('Mesh', 'Premation Skeleton Mesh');
    if (path === 'skeleton/bones') return g('Bones', 'Premation Bones', 'indexedGroup');
    if (path === 'skeleton/controllers') return g('Controllers', 'Premation Rig Controllers', 'indexedGroup');
    if (seg[1] === 'bones' && seg.length === 3) {
      const bone = withIds(listOf(skel, 'bones')).find((b) => b.id === seg[2]);
      return g(typeof bone?.name === 'string' && bone.name !== '' ? bone.name : seg[2]!, RIG_GROUP_MATCH.bone);
    }
    if (seg[1] === 'bones' && seg.length === 4 && seg[3] === 'ik') {
      const t = withIds(listOf(skel, 'ikTargets'), 'boneId').find((x) => x.boneId === seg[2]);
      return g('IK', RIG_GROUP_MATCH.ik, 'group', t?.enabled !== false);
    }
    if (seg[1] === 'controllers' && seg.length === 3) {
      const c = withIds(listOf(skel, 'controllers')).find((x) => x.id === seg[2]);
      return g(typeof c?.name === 'string' && c.name !== '' ? c.name : seg[2]!, RIG_GROUP_MATCH.controller);
    }
    return null;
  }
  return null;
}

// ── Static values ────────────────────────────────────────────────────

function num2(spec: RigPropSpec, i: number): number {
  const d = spec.default;
  return Array.isArray(d) ? (d[i] as number) : typeof d === 'number' ? d : 0;
}

/** The bone's bind-pose entry, else the bone itself (skeletonCommands `bindPoseBones`). */
function bindEntry(skel: Obj, boneId: string, bone: Obj): Obj {
  const bind = listOf(skel, 'bindPose');
  if (bind.length === 0) return bone;
  return bind.find((b) => b.id === boneId) ?? bone;
}

/** A rig property's static value (API units). */
export function readRigStatic(node: SceneNode, b: PropBinding): Value {
  const spec = specOf(b);
  const ref = b.rig!;
  const o = ownerObject(node, ref) ?? {};
  const k = scaleOf(spec);
  switch (spec.codec) {
    case 'number': {
      const v = getKey(o, spec.keys[0]!);
      return { kind: 'scalar', value: (isNum(v) ? v : num2(spec, 0)) * k };
    }
    case 'xy': {
      const x = getKey(o, spec.keys[0]!);
      const y = getKey(o, spec.keys[1]!);
      return { kind: 'vec2', value: { x: (isNum(x) ? x : num2(spec, 0)) * k, y: (isNum(y) ? y : num2(spec, 1)) * k } };
    }
    case 'point': {
      const p = getKey(o, spec.keys[0]!);
      const x = isObj(p) && isNum(p.x) ? p.x : num2(spec, 0);
      const y = isObj(p) && isNum(p.y) ? p.y : num2(spec, 1);
      return { kind: 'vec2', value: { x: x * k, y: y * k } };
    }
    case 'pinPosition': {
      const p = o.position;
      if (isObj(p) && isNum(p.x) && isNum(p.y)) return { kind: 'vec2', value: { x: p.x, y: p.y } };
      return { kind: 'vec2', value: { x: isNum(o.x) ? o.x : 0, y: isNum(o.y) ? o.y : 0 } };
    }
    case 'choice': {
      const v = getKey(o, spec.keys[0]!);
      return { kind: 'choice', value: typeof v === 'string' && spec.choices!.includes(v) ? v : String(spec.default) };
    }
    case 'string': {
      const v = getKey(o, spec.keys[0]!);
      return { kind: 'string', value: typeof v === 'string' ? v : '' };
    }
    case 'parent': {
      const v = o.parentId;
      return { kind: 'string', value: typeof v === 'string' ? v : '' };
    }
    case 'json':
    case 'wholeRig': {
      const v = getKey(o, spec.keys[0]!);
      return { kind: 'json', value: JSON.stringify(v === undefined ? null : v) };
    }
    case 'ikMode':
      return { kind: 'scalar', value: o.ikMode === 'fk' ? 0 : 1 };
    case 'bind': {
      const skel = skeletonOf(node) ?? {};
      const e = bindEntry(skel, ref.id, o);
      const nums = spec.keys.map((key, i) => {
        const v = e[key];
        return (isNum(v) ? v : num2(spec, i)) * k;
      });
      return spec.type === 'vec2' ? { kind: 'vec2', value: { x: nums[0]!, y: nums[1]! } } : { kind: 'scalar', value: nums[0]! };
    }
  }
}

function typeErr(b: PropBinding, v: Value): never {
  return fail('typeMismatch', `'${b.path}' takes a ${b.valueType}, got ${v.kind}`, { path: b.path, detail: JSON.stringify({ expected: b.valueType }) });
}

/** The API numbers of a scalar / vec2 value, type-, finiteness- and range-checked. */
function apiNumbers(b: PropBinding, spec: RigPropSpec, v: Value): number[] {
  let nums: number[];
  if (spec.type === 'scalar') {
    if (v.kind !== 'scalar') typeErr(b, v);
    nums = [v.value];
  } else {
    if (v.kind !== 'vec2') typeErr(b, v);
    nums = [v.value.x, v.value.y];
  }
  for (const x of nums) {
    if (!Number.isFinite(x)) fail('invalidArgument', `'${b.path}': value must be finite`, { path: b.path });
    if ((spec.min !== undefined && x < spec.min) || (spec.max !== undefined && x > spec.max)) {
      fail('outOfRange', `'${b.path}' takes ${spec.min ?? '-∞'}..${spec.max ?? '∞'}`, { path: b.path });
    }
  }
  return nums;
}

/** The skeleton with its bind pose pinned to the current bones when it has none (captureBindPose). */
function captured(skel: Obj): Obj {
  if (listOf(skel, 'bindPose').length > 0) return skel;
  return { ...skel, bindPose: listOf(skel, 'bones').map((b) => ({ ...b })) };
}

/** Is `candidate` `boneId` or one of its descendants? */
function inSubtree(bones: Obj[], boneId: string, candidate: string): boolean {
  let cur: string | null = candidate;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    if (cur === boneId) return true;
    seen.add(cur);
    const b = bones.find((x) => x.id === cur);
    cur = b && typeof b.parentId === 'string' ? b.parentId : null;
  }
  return false;
}

/** The owner object with this write applied (validation included). */
function nextOwner(node: SceneNode, b: PropBinding, spec: RigPropSpec, o: Obj, value: Value): Obj {
  const k = scaleOf(spec);
  const stored = (x: number): number => x / k;
  switch (spec.codec) {
    case 'number': {
      const s = stored(apiNumbers(b, spec, value)[0]!);
      return setKey(o, spec.keys[0]!, spec.clearAtDefault && s === spec.default ? undefined : s);
    }
    case 'xy': {
      const n = apiNumbers(b, spec, value);
      let out = o;
      spec.keys.forEach((key, i) => {
        const s = stored(n[i]!);
        out = setKey(out, key, spec.clearAtDefault && s === num2(spec, i) ? undefined : s);
      });
      return out;
    }
    case 'point': {
      const n = apiNumbers(b, spec, value);
      return setKey(o, spec.keys[0]!, { x: stored(n[0]!), y: stored(n[1]!) });
    }
    case 'pinPosition': {
      const n = apiNumbers(b, spec, value);
      return { ...o, position: { x: n[0]!, y: n[1]! } };
    }
    case 'choice': {
      if (value.kind !== 'choice' && value.kind !== 'string') typeErr(b, value);
      if (!spec.choices!.includes(value.value)) {
        fail('outOfRange', `'${value.value}' is not a choice of '${b.path}'`, { path: b.path, detail: JSON.stringify({ choices: spec.choices }) });
      }
      return setKey(o, spec.keys[0]!, value.value);
    }
    case 'string': {
      if (value.kind !== 'string') typeErr(b, value);
      return setKey(o, spec.keys[0]!, value.value);
    }
    case 'parent': {
      if (value.kind !== 'string') typeErr(b, value);
      const bones = withIds(listOf(skeletonOf(node), 'bones'));
      const id = b.rig!.id;
      if (value.value !== '') {
        if (!bones.some((x) => x.id === value.value)) fail('notFound', `no bone '${value.value}'`, { path: b.path });
        if (inSubtree(bones, id, value.value)) fail('cycle', `bone '${value.value}' cannot parent '${id}'`, { path: b.path });
      }
      return { ...o, parentId: value.value === '' ? null : value.value };
    }
    case 'json': {
      if (value.kind !== 'json') typeErr(b, value);
      let v: unknown;
      try {
        v = JSON.parse(value.value) as unknown;
      } catch {
        return fail('invalidArgument', 'invalid json', { path: b.path });
      }
      if (v !== null && !isObj(v)) fail('invalidArgument', `'${b.path}' takes null or a JSON object`, { path: b.path });
      return setKey(o, spec.keys[0]!, v === null ? undefined : v);
    }
    case 'ikMode': {
      const x = apiNumbers(b, spec, value)[0]!;
      return { ...o, ikMode: x >= 0.5 ? 'ik' : 'fk' };
    }
    case 'bind':
    case 'wholeRig':
      return o;
  }
}

function writePuppet(layerId: string, rig: Obj | undefined): void {
  graph.setPuppet(layerId, rig);
}

function writeSkeleton(layerId: string, rig: Obj | undefined): void {
  graph.setSkeleton(layerId, rig);
}

/** Replace the entry of `key` whose `idKey` is `id`. */
function replaceIn(rig: Obj, key: string, idKey: string, id: string, next: Obj): Obj {
  return { ...rig, [key]: (Array.isArray(rig[key]) ? (rig[key] as unknown[]) : []).map((x) => (isObj(x) && x[idKey] === id ? next : x)) };
}

/**
 * Write a rig property's static value. `creating`: the write initialises a
 * group `addPropertyGroup` just made (no bind-pose capture).
 */
export function writeRigStatic(layerId: string, node: SceneNode, b: PropBinding, value: Value, creating = false): void {
  const spec = specOf(b);
  const ref = b.rig!;
  if (spec.codec === 'wholeRig') {
    writeWholeRig(layerId, node, b, spec.keys[0] as 'puppet' | 'skeleton', value);
    return;
  }
  const o = ownerObject(node, ref);
  if (!o) fail('notFound', `layer '${layerId}' has no '${b.path}'`, { layer: layerId, path: b.path });
  if (ref.owner === 'puppet' || ref.owner === 'pin') {
    const rig = puppetOf(node)!;
    const next = nextOwner(node, b, spec, o, value);
    writePuppet(layerId, ref.owner === 'puppet' ? next : replaceIn(rig, 'pins', 'id', ref.id, next));
    return;
  }
  let skel = skeletonOf(node)!;
  if (spec.codec === 'bind') {
    const n = apiNumbers(b, spec, value);
    const k = scaleOf(spec);
    skel = captured(skel);
    const bind = listOf(skel, 'bindPose');
    let entry = bind.find((x) => x.id === ref.id);
    const patch: Obj = {};
    spec.keys.forEach((key, i) => { patch[key] = n[i]! / k; });
    if (entry) {
      entry = { ...entry, ...patch };
      writeSkeleton(layerId, replaceIn(skel, 'bindPose', 'id', ref.id, entry));
    } else {
      // A bone added after the bind was captured binds where it was drawn:
      // its rest entry starts as the bone.
      writeSkeleton(layerId, { ...skel, bindPose: [...(skel.bindPose as unknown[]), { ...o, ...patch }] });
    }
    return;
  }
  const next = nextOwner(node, b, spec, o, value);
  if (spec.poseCapture && !creating) skel = captured(skel);
  switch (ref.owner) {
    case 'skeleton': writeSkeleton(layerId, next); return;
    case 'bone': writeSkeleton(layerId, replaceIn(skel, 'bones', 'id', ref.id, next)); return;
    case 'ik': writeSkeleton(layerId, replaceIn(skel, 'ikTargets', 'boneId', ref.id, next)); return;
    case 'controller': writeSkeleton(layerId, replaceIn(skel, 'controllers', 'id', ref.id, next)); return;
    default: return;
  }
}

// ── Pin position keys (a points data track, API vec2) ────────────────

/** A `puppet.<pin>.position` key value → the API vec2. */
export function pinKeyToApi(v: unknown): Value {
  const p = Array.isArray(v) ? v[0] : undefined;
  return { kind: 'vec2', value: { x: isObj(p) && isNum(p.x) ? p.x : 0, y: isObj(p) && isNum(p.y) ? p.y : 0 } };
}

/** The API vec2 → a `puppet.<pin>.position` key value. */
export function apiToPinKey(b: PropBinding, v: Value): Array<{ x: number; y: number }> {
  if (v.kind !== 'vec2') typeErr(b, v);
  return [{ x: v.value.x, y: v.value.y }];
}

/** A pin key's spatial tangents (the data key's `si`/`so` for point 0) as API per-dimension lists. */
export function pinKeySpatial(k: { si?: Array<{ x: number; y: number } | null>; so?: Array<{ x: number; y: number } | null> }): { spatialIn: number[]; spatialOut: number[] } {
  const si = k.si?.[0];
  const so = k.so?.[0];
  if (!si && !so) return { spatialIn: [], spatialOut: [] };
  return { spatialIn: si ? [si.x, si.y] : [0, 0], spatialOut: so ? [so.x, so.y] : [0, 0] };
}

// ── Groups ───────────────────────────────────────────────────────────

/** The rig groups `addPropertyGroup` can add (listGroupTypes rows). */
export const RIG_GROUP_TYPES: Array<{ parent: string; matchName: string; displayName: string; category: string }> = [
  { parent: '', matchName: RIG_GROUP_MATCH.puppet, displayName: 'Puppet', category: 'rig' },
  { parent: 'puppet/pins', matchName: RIG_GROUP_MATCH.pin, displayName: 'Puppet Pin', category: 'rig' },
  { parent: '', matchName: RIG_GROUP_MATCH.skeleton, displayName: 'Skeleton', category: 'rig' },
  { parent: 'skeleton/bones', matchName: RIG_GROUP_MATCH.bone, displayName: 'Bone', category: 'rig' },
  { parent: 'skeleton/bones/*', matchName: RIG_GROUP_MATCH.ik, displayName: 'IK Goal', category: 'rig' },
  { parent: 'skeleton/controllers', matchName: RIG_GROUP_MATCH.controller, displayName: 'Rig Controller', category: 'rig' },
];

export type RigGroupRef =
  | { kind: 'rigRoot'; layer: string; root: 'puppet' | 'skeleton' }
  | { kind: 'pin' | 'bone' | 'controller'; layer: string; id: string; index: number }
  | { kind: 'ik'; layer: string; id: string };

/** A rig group path of a layer (null: not a rig path; notFound when it names a missing group). */
export function resolveRigGroup(node: SceneNode, layer: string, path: string): RigGroupRef | null {
  const seg = path.split('/');
  if (seg[0] !== 'puppet' && seg[0] !== 'skeleton') return null;
  const nf = (): never => fail('notFound', `layer '${layer}' has no group '${path}'`, { layer, path });
  if (seg.length === 1) {
    if (seg[0] === 'puppet' ? !puppetOf(node) : !skeletonOf(node)) nf();
    return { kind: 'rigRoot', layer, root: seg[0] };
  }
  if (seg.length === 3 && seg[0] === 'puppet' && seg[1] === 'pins') {
    const index = withIds(listOf(puppetOf(node), 'pins')).findIndex((p) => p.id === seg[2]);
    if (index < 0) nf();
    return { kind: 'pin', layer, id: seg[2]!, index };
  }
  if (seg.length === 3 && seg[0] === 'skeleton' && (seg[1] === 'bones' || seg[1] === 'controllers')) {
    const list = withIds(listOf(skeletonOf(node), seg[1]));
    const index = list.findIndex((x) => x.id === seg[2]);
    if (index < 0) nf();
    return { kind: seg[1] === 'bones' ? 'bone' : 'controller', layer, id: seg[2]!, index };
  }
  if (seg.length === 4 && seg[0] === 'skeleton' && seg[1] === 'bones' && seg[3] === 'ik') {
    if (!withIds(listOf(skeletonOf(node), 'ikTargets'), 'boneId').some((t) => t.boneId === seg[2])) nf();
    return { kind: 'ik', layer, id: seg[2]! };
  }
  return nf();
}

export function rigGroupPath(r: RigGroupRef): string {
  switch (r.kind) {
    case 'rigRoot': return r.root;
    case 'pin': return `puppet/pins/${r.id}`;
    case 'bone': return `skeleton/bones/${r.id}`;
    case 'controller': return `skeleton/controllers/${r.id}`;
    case 'ik': return `skeleton/bones/${r.id}/ik`;
  }
}

/** The mesh a brand-new rig starts with, by layer kind (puppetCommands `defaultMeshMode`). */
function defaultMeshMode(node: SceneNode): 'grid' | 'silhouette' {
  const kind = readNodeKind(node);
  return kind === 'image' || kind === 'svg' ? 'silhouette' : 'grid';
}

/** Layers a rig can deform: not a camera, light or audio layer. */
function canRig(node: SceneNode): boolean {
  const kind = readNodeKind(node);
  return kind !== 'camera' && kind !== 'light' && kind !== 'audio';
}

/** Rig part ids (pins / bones) of a whole rig. */
function partIds(kind: 'puppet' | 'skeleton', rig: unknown): Set<string> {
  const out = new Set<string>();
  if (!isObj(rig)) return out;
  for (const x of listOf(rig, kind === 'skeleton' ? 'bones' : 'pins')) if (typeof x.id === 'string') out.add(x.id);
  return out;
}

/** `layer/puppet` / `layer/skeleton`: replace the whole rig; removed pins / bones lose their keys. */
function writeWholeRig(layerId: string, node: SceneNode, b: PropBinding, kind: 'puppet' | 'skeleton', value: Value): void {
  if (value.kind !== 'json') typeErr(b, value);
  let v: unknown;
  try {
    v = JSON.parse(value.value) as unknown;
  } catch {
    return fail('invalidArgument', 'invalid json', { path: b.path });
  }
  if (v !== null && !isObj(v)) fail('invalidArgument', `'${b.path}' takes null or a JSON object`, { path: b.path });
  const before = partIds(kind, fxOf(node)?.[kind]);
  const after = partIds(kind, v);
  if (kind === 'puppet') writePuppet(layerId, v === null ? undefined : (v as Obj));
  else writeSkeleton(layerId, v === null ? undefined : (v as Obj));
  const prefixes: string[] = [];
  for (const id of before) if (!after.has(id)) prefixes.push(...trackPrefixes(kind === 'puppet' ? 'pin' : 'bone', id));
  dropTracks(layerId, prefixes);
}

/** Layers a rig can deform (layerFieldSpecs VISUAL). */
function visualOrFail(node: SceneNode, layer: string, parent: string): void {
  const kind = readNodeKind(node);
  if (kind === 'camera' || kind === 'light' || kind === 'audio') {
    fail('invalidArgument', `a ${kind} layer cannot carry a rig`, { layer, path: parent });
  }
}

/** Track prefixes a rig part keys (`x.` = prefix, else exact). */
function trackPrefixes(kind: 'pin' | 'bone' | 'ik', id: string): string[] {
  if (kind === 'pin') return [`puppet.${id}.`];
  const ik = [`ikTarget.${id}.`, `ikPole.${id}.`, `ikMode.${id}`];
  return kind === 'bone' ? [`bone.${id}.`, ...ik] : ik;
}

/** Drop every track / expression / data track matching these prefixes. */
function dropTracks(layer: string, prefixes: readonly string[]): void {
  const snap = defaultAnimation.snapshotNode(layer);
  if (!snap || prefixes.length === 0) return;
  const drop = new Set<string>();
  for (const section of [snap.tracks, snap.expressions, snap.data]) {
    for (const p of Object.keys(section)) if (prefixes.some((x) => (x.endsWith('.') ? p.startsWith(x) : p === x))) drop.add(p);
  }
  dropTrackProps(layer, drop);
}

export interface RigAddPlan {
  /** The group path the add creates. */
  path: string;
  /** Apply it (the init writes included). */
  run: () => void;
}

interface AddInit { path: string; value: Value }

/**
 * Plan `addPropertyGroup` for a rig group (null: not a rig parent / match name).
 * `mint(prefix, taken)` is the engine's group-id allocator.
 */
export function planRigAdd(
  node: SceneNode,
  layer: string,
  parent: string,
  matchName: string,
  index: number | undefined,
  name: string | undefined,
  init: readonly AddInit[],
  mint: (prefix: string, taken: (id: string) => boolean) => string,
  bindingFor: (path: string) => PropBinding,
): RigAddPlan | null {
  const seg = parent.split('/');
  const applyInit = (path: string): void => {
    for (const i of init) {
      const b = bindingFor(`${path}/${i.path}`);
      if (b.special !== 'rig') fail('invalidArgument', `'${path}/${i.path}' cannot be initialised`, { layer, path: `${path}/${i.path}` });
      writeRigStatic(layer, graph.getNode(layer)!, b, i.value, true);
    }
  };
  const checkIndex = (count: number): number => {
    const at = index ?? count;
    if (at > count) fail('outOfRange', `index ${at} is past the ${count} entries of '${parent}'`, { layer, path: parent });
    return at;
  };
  const insert = (list: unknown, at: number, x: Obj): unknown[] => {
    const out = Array.isArray(list) ? list.slice() : [];
    // `at` counts addressable entries; an unaddressable one keeps its slot.
    let real = out.length;
    let seen = 0;
    for (let i = 0; i < out.length; i++) {
      if (!isObj(out[i]) || typeof (out[i] as Obj).id !== 'string') continue;
      if (seen === at) { real = i; break; }
      seen++;
    }
    out.splice(real, 0, x);
    return out;
  };

  if (parent === '' && (matchName === RIG_GROUP_MATCH.puppet || matchName === RIG_GROUP_MATCH.skeleton)) {
    visualOrFail(node, layer, parent);
    const root = matchName === RIG_GROUP_MATCH.puppet ? 'puppet' : 'skeleton';
    if (root === 'puppet' ? puppetOf(node) : skeletonOf(node)) fail('conflict', `layer '${layer}' already has a ${root}`, { layer, path: root });
    return {
      path: root,
      run: () => {
        if (root === 'puppet') {
          writePuppet(layer, { pins: [], meshMode: defaultMeshMode(node), meshExpansion: 0, meshDensity: RIG_MESH_DENSITY_DEFAULT });
        } else {
          const skel: Obj = { bones: [], ikTargets: [] };
          if (defaultMeshMode(node) === 'silhouette') skel.meshMode = 'silhouette';
          writeSkeleton(layer, skel);
        }
        applyInit(root);
      },
    };
  }

  if (parent === 'puppet/pins' && matchName === RIG_GROUP_MATCH.pin) {
    visualOrFail(node, layer, parent);
    const rig = puppetOf(node);
    const pins = withIds(listOf(rig, 'pins'));
    const at = checkIndex(pins.length);
    const id = mint('pin_', (x) => pins.some((p) => p.id === x));
    const kindInit = init.find((i) => i.path === 'kind');
    const kind = kindInit && (kindInit.value.kind === 'choice' || kindInit.value.kind === 'string') ? kindInit.value.value : 'advanced';
    return {
      path: `puppet/pins/${id}`,
      run: () => {
        // puppetCommands `draftPin`: a Starch pin starts at Amount 8, an Overlap pin at In Front 50.
        const pin: Obj = { id, name: name ?? `Pin ${pins.length + 1}`, x: 0, y: 0, kind: 'advanced' };
        if (kind === 'starch') pin.stiffness = 8;
        if (kind === 'overlap') pin.overlap = 50;
        let next: Obj;
        if (!rig) {
          next = { pins: [pin], meshMode: defaultMeshMode(node), meshExpansion: 0, meshDensity: RIG_MESH_DENSITY_DEFAULT };
        } else {
          next = { ...rig, pins: insert(rig.pins, at, pin) };
          // A pinless rig that never chose its mesh gets the first-pin defaults.
          if (pins.length === 0) {
            if (next.meshMode === undefined) next.meshMode = defaultMeshMode(node);
            if (next.meshExpansion === undefined) next.meshExpansion = 0;
            if (next.meshDensity === undefined) next.meshDensity = RIG_MESH_DENSITY_DEFAULT;
          }
        }
        writePuppet(layer, next);
        applyInit(`puppet/pins/${id}`);
      },
    };
  }

  if (parent === 'skeleton/bones' && matchName === RIG_GROUP_MATCH.bone) {
    visualOrFail(node, layer, parent);
    const skel = skeletonOf(node);
    const bones = withIds(listOf(skel, 'bones'));
    const at = checkIndex(bones.length);
    const id = mint('bone_', (x) => bones.some((b) => b.id === x));
    return {
      path: `skeleton/bones/${id}`,
      run: () => {
        const bone: Obj = { id, name: name ?? `Bone ${bones.length + 1}`, parentId: null, length: 100, x: 0, y: 0, rotation: 0 };
        const next: Obj = { ...(skel ?? {}), bones: insert(skel?.bones, at, bone), ikTargets: skel?.ikTargets ?? [] };
        // skeletonCommands `addBone`: only the FIRST bone chooses the outline mesh.
        if (bones.length === 0 && next.meshMode === undefined && defaultMeshMode(node) === 'silhouette') next.meshMode = 'silhouette';
        writeSkeleton(layer, next);
        applyInit(`skeleton/bones/${id}`);
      },
    };
  }

  if (seg.length === 3 && seg[0] === 'skeleton' && seg[1] === 'bones' && matchName === RIG_GROUP_MATCH.ik) {
    const skel = skeletonOf(node);
    const boneId = seg[2]!;
    if (!withIds(listOf(skel, 'bones')).some((b) => b.id === boneId)) fail('notFound', `no bone '${boneId}'`, { layer, path: parent });
    if (withIds(listOf(skel, 'ikTargets'), 'boneId').some((t) => t.boneId === boneId)) {
      fail('conflict', `bone '${boneId}' already has an IK goal`, { layer, path: `${parent}/ik` });
    }
    if (index !== undefined) fail('invalidArgument', 'an IK goal has no index', { layer, path: parent });
    return {
      path: `${parent}/ik`,
      run: () => {
        const s = skeletonOf(graph.getNode(layer)!)!;
        writeSkeleton(layer, { ...s, ikTargets: [...listOf(s, 'ikTargets'), { boneId, x: 0, y: 0 }] });
        applyInit(`${parent}/ik`);
      },
    };
  }

  if (parent === 'skeleton/controllers' && matchName === RIG_GROUP_MATCH.controller) {
    const skel = skeletonOf(node);
    if (!skel) fail('notFound', `layer '${layer}' has no skeleton`, { layer, path: parent });
    const list = withIds(listOf(skel, 'controllers'));
    const at = checkIndex(list.length);
    const id = mint('ctrl_', (x) => list.some((c) => c.id === x));
    return {
      path: `skeleton/controllers/${id}`,
      run: () => {
        const c: Obj = { id, ...(name !== undefined ? { name } : {}), shape: 'circle', side: 'centre', size: 14, link: { kind: 'ikTarget', boneId: '' } };
        writeSkeleton(layer, { ...skel, controllers: insert(skel.controllers, at, c) });
        applyInit(`skeleton/controllers/${id}`);
      },
    };
  }
  return null;
}

/** Remove a rig group with its keys (and, for a bone, its subtree and every reference to it). */
export function removeRigGroup(r: RigGroupRef): void {
  const node = graph.getNode(r.layer)!;
  switch (r.kind) {
    case 'rigRoot':
      if (r.root === 'puppet') {
        writePuppet(r.layer, undefined);
        dropTracks(r.layer, ['puppet.']);
      } else {
        writeSkeleton(r.layer, undefined);
        dropTracks(r.layer, ['bone.', 'ikTarget.', 'ikPole.', 'ikMode.']);
      }
      return;
    case 'pin': {
      const rig = puppetOf(node);
      if (!rig) return;
      writePuppet(r.layer, { ...rig, pins: (rig.pins as unknown[]).filter((p) => !(isObj(p) && p.id === r.id)) });
      dropTracks(r.layer, trackPrefixes('pin', r.id));
      return;
    }
    case 'bone': {
      const skel = skeletonOf(node);
      if (!skel) return;
      const bones = listOf(skel, 'bones');
      // skeletonCommands `deleteBone`: the whole subtree goes.
      const removed = new Set<string>([r.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const b of bones) {
          if (typeof b.parentId === 'string' && removed.has(b.parentId) && typeof b.id === 'string' && !removed.has(b.id)) {
            removed.add(b.id);
            changed = true;
          }
        }
      }
      const gone = (x: unknown, key: string): boolean => isObj(x) && typeof x[key] === 'string' && removed.has(x[key] as string);
      const next: Obj = {
        ...skel,
        bones: (skel.bones as unknown[]).filter((b) => !gone(b, 'id')),
        ikTargets: (Array.isArray(skel.ikTargets) ? skel.ikTargets : []).filter((t: unknown) => !gone(t, 'boneId')),
      };
      if (Array.isArray(skel.controllers)) {
        next.controllers = skel.controllers.filter((c: unknown) => !(isObj(c) && isObj(c.link) && typeof c.link.boneId === 'string' && removed.has(c.link.boneId)));
      }
      if (isObj(skel.weightPaint) && isObj(skel.weightPaint.bones)) {
        const wb: Obj = {};
        for (const [k, v] of Object.entries(skel.weightPaint.bones)) if (!removed.has(k)) wb[k] = v;
        next.weightPaint = { ...skel.weightPaint, bones: wb };
      } else {
        delete next.weightPaint;
      }
      if (Array.isArray(skel.bindPose)) next.bindPose = skel.bindPose.filter((b: unknown) => !gone(b, 'id'));
      writeSkeleton(r.layer, next);
      const prefixes: string[] = [];
      for (const id of removed) prefixes.push(...trackPrefixes('bone', id));
      dropTracks(r.layer, prefixes);
      return;
    }
    case 'ik': {
      const skel = skeletonOf(node);
      if (!skel) return;
      writeSkeleton(r.layer, { ...skel, ikTargets: listOf(skel, 'ikTargets').filter((t) => t.boneId !== r.id) });
      dropTracks(r.layer, trackPrefixes('ik', r.id));
      return;
    }
    case 'controller': {
      const skel = skeletonOf(node);
      if (!skel) return;
      writeSkeleton(r.layer, { ...skel, controllers: (skel.controllers as unknown[]).filter((c) => !(isObj(c) && c.id === r.id)) });
      return;
    }
  }
}

/** Reorder a pin / bone / controller among its addressable siblings. */
export function moveRigGroup(r: RigGroupRef, toIndex: number): void {
  if (r.kind !== 'pin' && r.kind !== 'bone' && r.kind !== 'controller') {
    fail('unsupported', `'${rigGroupPath(r)}' has no order`, { layer: r.layer, path: rigGroupPath(r) });
  }
  const node = graph.getNode(r.layer)!;
  const rig = r.kind === 'pin' ? puppetOf(node)! : skeletonOf(node)!;
  const key = r.kind === 'pin' ? 'pins' : r.kind === 'bone' ? 'bones' : 'controllers';
  const all = rig[key] as unknown[];
  const addressable = all.filter((x) => isObj(x) && typeof x.id === 'string');
  if (toIndex >= addressable.length) fail('outOfRange', 'toIndex past the end', { layer: r.layer, path: rigGroupPath(r) });
  const moved = addressable.slice();
  const [x] = moved.splice(r.index, 1);
  moved.splice(toIndex, 0, x);
  // Unaddressable entries keep their slots; the addressable ones fill the rest in the new order.
  let i = 0;
  const next = all.map((e) => (isObj(e) && typeof e.id === 'string' ? moved[i++] : e));
  const out = { ...rig, [key]: next };
  if (r.kind === 'pin') writePuppet(r.layer, out);
  else writeSkeleton(r.layer, out);
}

/** Rename a pin / bone / controller (an empty name removes it). */
export function renameRigGroup(r: RigGroupRef, name: string): void {
  if (r.kind !== 'pin' && r.kind !== 'bone' && r.kind !== 'controller') {
    fail('unsupported', `'${rigGroupPath(r)}' cannot be renamed`, { layer: r.layer, path: rigGroupPath(r) });
  }
  const node = graph.getNode(r.layer)!;
  const rig = r.kind === 'pin' ? puppetOf(node)! : skeletonOf(node)!;
  const key = r.kind === 'pin' ? 'pins' : r.kind === 'bone' ? 'bones' : 'controllers';
  const trimmed = name.trim() === '';
  const out = replaceIn(rig, key, 'id', r.id, setKey((rig[key] as Obj[]).find((x) => isObj(x) && x.id === r.id)!, 'name', trimmed ? undefined : name));
  if (r.kind === 'pin') writePuppet(r.layer, out);
  else writeSkeleton(r.layer, out);
}

/** The IK goal's switch. */
export function setRigGroupEnabled(r: RigGroupRef, on: boolean): void {
  if (r.kind !== 'ik') fail('unsupported', `'${rigGroupPath(r)}' has no switch`, { layer: r.layer, path: rigGroupPath(r) });
  const skel = skeletonOf(graph.getNode(r.layer)!)!;
  const t = listOf(skel, 'ikTargets').find((x) => x.boneId === r.id)!;
  writeSkeleton(r.layer, replaceIn(skel, 'ikTargets', 'boneId', r.id, setKey(t, 'enabled', on ? undefined : false)));
}

// ── Optional properties (the IK pole) ────────────────────────────────

/** `skeleton/bones/<b>/ik` → the bone id (null: not an IK goal path). */
export function ikParentOf(path: string): string | null {
  const seg = path.split('/');
  return seg.length === 4 && seg[0] === 'skeleton' && seg[1] === 'bones' && seg[3] === 'ik' ? seg[2]! : null;
}

/** Plan `addProperties` on an IK goal (only `pole` is optional). Returns the apply step. */
export function planIkAddProperties(layer: string, parentPath: string, names: readonly string[]): () => void {
  const node = graph.getNode(layer)!;
  const boneId = ikParentOf(parentPath)!;
  const target = withIds(listOf(skeletonOf(node), 'ikTargets'), 'boneId').find((t) => t.boneId === boneId);
  if (!target) fail('notFound', `layer '${layer}' has no group '${parentPath}'`, { layer, path: parentPath });
  for (const n of names) {
    if (n !== 'pole') fail('invalidArgument', `'${n}' is not an optional property of an IK goal`, { layer, path: `${parentPath}/${n}` });
  }
  const present = hasPole(layer, target, boneId);
  return () => {
    if (present) return;
    const skel = skeletonOf(graph.getNode(layer)!)!;
    writeSkeleton(layer, replaceIn(skel, 'ikTargets', 'boneId', boneId, { ...target, pole: { x: 0, y: 0 } }));
  };
}

/** Plan `removeProperties` of an IK pole (null: not an IK path). */
export function planIkRemoveProperty(layer: string, path: string): { key: string; run: () => void } | null {
  const slash = path.lastIndexOf('/');
  const boneId = ikParentOf(path.slice(0, slash));
  if (boneId === null) return null;
  const name = path.slice(slash + 1);
  if (name !== 'pole') fail('invalidArgument', `'${path}' is not an optional property (it cannot be removed)`, { layer, path });
  const node = graph.getNode(layer)!;
  const target = withIds(listOf(skeletonOf(node), 'ikTargets'), 'boneId').find((t) => t.boneId === boneId);
  if (!target || !hasPole(layer, target, boneId)) fail('notFound', `layer '${layer}' has no property '${path}'`, { layer, path });
  return {
    key: `${layer}|${path}`,
    run: () => {
      const skel = skeletonOf(graph.getNode(layer)!)!;
      const t = listOf(skel, 'ikTargets').find((x) => x.boneId === boneId)!;
      writeSkeleton(layer, replaceIn(skel, 'ikTargets', 'boneId', boneId, setKey(t, 'pole', undefined)));
      dropTrackProps(layer, new Set([`ikPole.${boneId}.x`, `ikPole.${boneId}.y`]));
    },
  };
}
