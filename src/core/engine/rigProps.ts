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

import type { Value, PropertyKind } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { fail } from './errors';
import {  RIG_GROUP_MATCH,  type RigOwner } from './rigSpecs';

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

// ── Pin position keys (a points data track, API vec2) ────────────────

/** A `puppet.<pin>.position` key value → the API vec2. */
export function pinKeyToApi(v: unknown): Value {
  const p = Array.isArray(v) ? v[0] : undefined;
  return { kind: 'vec2', value: { x: isObj(p) && isNum(p.x) ? p.x : 0, y: isObj(p) && isNum(p.y) ? p.y : 0 } };
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

export interface RigAddPlan {
  /** The group path the add creates. */
  path: string;
  /** Apply it (the init writes included). */
  run: () => void;
}

// ── Optional properties (the IK pole) ────────────────────────────────

/** `skeleton/bones/<b>/ik` → the bone id (null: not an IK goal path). */
export function ikParentOf(path: string): string | null {
  const seg = path.split('/');
  return seg.length === 4 && seg[0] === 'skeleton' && seg[1] === 'bones' && seg[3] === 'ik' ? seg[2]! : null;
}
