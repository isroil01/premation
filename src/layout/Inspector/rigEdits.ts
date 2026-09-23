/**
 * rigEdits — the Puppet / Bones panels' writes as engine-API commands (B3z),
 * on the rig paths B3z WS-R designed (docs/ENGINE_API.md §15.9 "Rigging";
 * bindings src/core/engine/rigProps.ts ⇄ native rig.cpp):
 *
 *   puppet/mesh/<field>                     mesh density / expansion / mode / solver / rotation refinement
 *   puppet/pins/<pin>/<prop>                a pin's rotation, scale (%), stiffness, overlap, extent, kind
 *   skeleton/mesh/<field>, skeleton/weightPaint
 *   skeleton/bones/<bone>/<prop>            length, influenceRadius; rotation / scale (the pose) and
 *                                           restRotation / restScale (the bind pose)
 *   skeleton/bones/<bone>/ik[/<prop>]       the IK goal (group), target, pole (optional), mode, chainLength
 *   skeleton/controllers/<ctrl>/<prop>      shape, side, size, offset, drives, bone
 *   layer/skeleton                          the whole rig (Auto-Rig presets)
 *
 * Group operations are the generic ones (addPropertyGroup, removePropertyGroups,
 * renamePropertyGroup, setGroupEnabled, addProperties / removeProperties). Every
 * builder returns the commands of ONE user action; the caller sends them as one
 * `edit` (or into a scrub gesture). Times are composition time (flicks): the
 * engine converts to the layer's keyframe axis.
 *
 * Reads the live document only to decide what to send.
 */

import type { Command, PropertyInit, Value } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { catalogFor } from '@core/engine/props';
import { isLayer } from '@core/engine/doc';
import { compTime, values } from '@core/engine/propRefs';
import { readNodePuppet } from '@core/rig/puppet';
import { readNodeSkeleton, type SkeletonRig } from '@core/rig/skeletonCommands';
import { planChainSwitch, type ChainMode } from '@core/rig/ikfk';
import { resolveActiveIkTargets } from '@core/rig/liveIkTargets';
import type { RigController } from '@core/rig/controllers';

const DEG = 180 / Math.PI;

export const rigPaths = {
  puppetMesh: (field: 'density' | 'expansion' | 'mode' | 'solver' | 'rotationRefinement'): string => `puppet/mesh/${field}`,
  pin: (pinId: string): string => `puppet/pins/${pinId}`,
  pinProp: (pinId: string, p: string): string => `puppet/pins/${pinId}/${p}`,
  skeletonMesh: (field: 'density' | 'expansion' | 'mode'): string => `skeleton/mesh/${field}`,
  weightPaint: (): string => 'skeleton/weightPaint',
  bone: (boneId: string): string => `skeleton/bones/${boneId}`,
  boneProp: (boneId: string, p: string): string => `skeleton/bones/${boneId}/${p}`,
  ik: (boneId: string): string => `skeleton/bones/${boneId}/ik`,
  ikProp: (boneId: string, p: string): string => `skeleton/bones/${boneId}/ik/${p}`,
  controller: (ctrlId: string): string => `skeleton/controllers/${ctrlId}`,
  controllerProp: (ctrlId: string, p: string): string => `skeleton/controllers/${ctrlId}/${p}`,
} as const;

function set(layer: string, path: string, value: Value, seconds?: number): Command {
  return { type: 'setProperty', prop: { layer, path }, value, ...(seconds !== undefined ? { time: compTime(seconds) } : {}) };
}

/** Is the rig property at `path` keyframed (any of its tracks)? */
export function isRigAnimated(nodeId: string, path: string): boolean {
  if (!isLayer(nodeId)) return false;
  const b = catalogFor(nodeId).byPath.get(path);
  if (!b) return false;
  if (b.dataTrack && defaultAnimation.isDataAnimated(nodeId, b.dataTrack)) return true;
  return b.members.some((m) => defaultAnimation.isAnimated(nodeId, m));
}

/**
 * Set a keyframeable rig property at the playhead: a key when it is animated
 * (After Effects' setValueAtTime) or when `autoKey` asks for its first key,
 * else the static value.
 */
export function rigValueCommands(nodeId: string, path: string, value: Value, seconds: number, autoKey = false): Command[] {
  if (autoKey && !isRigAnimated(nodeId, path)) {
    return [{ type: 'addKeyframes', keys: [{ prop: { layer: nodeId, path }, time: compTime(seconds), value, spatialIn: [], spatialOut: [] }] }];
  }
  return [set(nodeId, path, value, seconds)];
}

// ── Puppet ───────────────────────────────────────────────────────────

export interface PuppetMeshPatch {
  density?: number;
  expansion?: number;
  mode?: 'grid' | 'silhouette';
  solver?: 'arap' | 'lbs';
  /** 0 = unlimited. */
  rotationRefinement?: number;
}

/** Mesh settings as ONE action; creates the (empty) rig first when the layer has none, as the legacy writer did. */
export function puppetMeshCommands(nodeId: string, patch: PuppetMeshPatch): Command[] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !isLayer(nodeId)) return [];
  const out: Command[] = [];
  if (!readNodePuppet(node)) out.push({ type: 'addPropertyGroup', layer: nodeId, parent: '', matchName: 'ADBE FreePin3', init: [] });
  if (patch.density !== undefined) out.push(set(nodeId, rigPaths.puppetMesh('density'), values.scalar(patch.density)));
  if (patch.expansion !== undefined) out.push(set(nodeId, rigPaths.puppetMesh('expansion'), values.scalar(patch.expansion)));
  if (patch.mode !== undefined) out.push(set(nodeId, rigPaths.puppetMesh('mode'), values.choice(patch.mode)));
  if (patch.solver !== undefined) out.push(set(nodeId, rigPaths.puppetMesh('solver'), values.choice(patch.solver)));
  if (patch.rotationRefinement !== undefined) out.push(set(nodeId, rigPaths.puppetMesh('rotationRefinement'), values.scalar(Math.max(0, patch.rotationRefinement))));
  return out;
}

/** One pin property at the playhead (a key when it is animated). `scale` is a multiplier here, percent in the API. */
export function pinPropCommands(
  nodeId: string,
  pinId: string,
  prop: 'rotation' | 'scale' | 'stiffness' | 'overlap' | 'overlapExtent',
  value: number,
  seconds: number,
): Command[] {
  const api = prop === 'scale' ? value * 100 : value;
  const path = rigPaths.pinProp(pinId, prop);
  return prop === 'overlapExtent' ? [set(nodeId, path, values.scalar(api))] : rigValueCommands(nodeId, path, values.scalar(api), seconds);
}

export function pinKindCommands(nodeId: string, pinId: string, kind: string): Command[] {
  return [set(nodeId, rigPaths.pinProp(pinId, 'kind'), values.choice(kind))];
}

export function deletePinCommands(nodeId: string, pinId: string): Command[] {
  return [{ type: 'removePropertyGroups', groups: [{ layer: nodeId, path: rigPaths.pin(pinId) }] }];
}

// ── Skeleton ─────────────────────────────────────────────────────────

export function skeletonMeshCommands(nodeId: string, patch: { density?: number; expansion?: number; mode?: 'grid' | 'silhouette' }): Command[] {
  const out: Command[] = [];
  if (patch.density !== undefined) out.push(set(nodeId, rigPaths.skeletonMesh('density'), values.scalar(patch.density)));
  if (patch.expansion !== undefined) out.push(set(nodeId, rigPaths.skeletonMesh('expansion'), values.scalar(patch.expansion)));
  if (patch.mode !== undefined) out.push(set(nodeId, rigPaths.skeletonMesh('mode'), values.choice(patch.mode)));
  return out;
}

/** The painted weight map (null = none): ONE write, as a brush stroke on release is. */
export function weightPaintCommands(nodeId: string, map: unknown): Command[] {
  return [set(nodeId, rigPaths.weightPaint(), values.json(map ?? null))];
}

export function renameBoneCommands(nodeId: string, boneId: string, name: string): Command[] {
  return [{ type: 'renamePropertyGroup', group: { layer: nodeId, path: rigPaths.bone(boneId) }, name }];
}

export function deleteBoneCommands(nodeId: string, boneId: string): Command[] {
  return [{ type: 'removePropertyGroups', groups: [{ layer: nodeId, path: rigPaths.bone(boneId) }] }];
}

/** Rest Length / Falloff: the bone's structure (read live, never from the bind pose). */
export function boneFieldCommands(nodeId: string, boneId: string, prop: 'length' | 'influenceRadius', value: number): Command[] {
  return [set(nodeId, rigPaths.boneProp(boneId, prop), values.scalar(value))];
}

/**
 * A RIG-mode edit of a bone's rotation (degrees) or scale (multipliers): the
 * bind pose (`restRotation` / `restScale`) and — while the pose property is not
 * keyframed — its static value too, so the skin and the bone agree (what the
 * legacy `updateBone` did to `bones` and `bindPose` together). The static pose
 * write comes first: it pins the bind pose to the current bones when there is
 * none, and the rest write then moves this bone's entry.
 */
export function boneRestCommands(nodeId: string, boneId: string, prop: 'rotation' | 'scale', value: number | { x: number; y: number }): Command[] {
  const v: Value = prop === 'rotation'
    ? values.scalar(value as number)
    : values.vec2((value as { x: number }).x * 100, (value as { y: number }).y * 100);
  const out: Command[] = [];
  if (!isRigAnimated(nodeId, rigPaths.boneProp(boneId, prop))) out.push(set(nodeId, rigPaths.boneProp(boneId, prop), v));
  out.push(set(nodeId, rigPaths.boneProp(boneId, prop === 'rotation' ? 'restRotation' : 'restScale'), v));
  return out;
}

/**
 * The bone's IK button: on = a new IK goal at `target` (or the existing one's
 * switch back on); off = the goal removed with its keys — the legacy
 * `setIKTarget(enabled: false)` dropped it from the rig.
 */
export function ikToggleCommands(nodeId: string, boneId: string, target: { x: number; y: number }): Command[] {
  const skel = skelOf(nodeId);
  const ik = skel?.ikTargets?.find((t) => t.boneId === boneId);
  if (ik && ik.enabled === false) return [{ type: 'setGroupEnabled', groups: [{ layer: nodeId, path: rigPaths.ik(boneId) }], enabled: true }];
  if (ik) return [{ type: 'removePropertyGroups', groups: [{ layer: nodeId, path: rigPaths.ik(boneId) }] }];
  const init: PropertyInit[] = [{ path: 'target', value: values.vec2(target.x, target.y) }];
  return [{ type: 'addPropertyGroup', layer: nodeId, parent: rigPaths.bone(boneId), matchName: 'Premation IK Goal', init }];
}

export function ikChainLengthCommands(nodeId: string, boneId: string, n: number): Command[] {
  return [set(nodeId, rigPaths.ikProp(boneId, 'chainLength'), values.scalar(Math.max(1, Math.min(8, Math.round(n)))))];
}

/** The goal's position at the playhead (a key when it is keyframed). */
export function ikTargetCommands(nodeId: string, boneId: string, target: { x: number; y: number }, seconds: number): Command[] {
  return rigValueCommands(nodeId, rigPaths.ikProp(boneId, 'target'), values.vec2(target.x, target.y), seconds);
}

/** Add Pole: the optional property, set to `pole` — one action. */
export function addPoleCommands(nodeId: string, boneId: string, pole: { x: number; y: number }): Command[] {
  return [
    { type: 'addProperties', parent: { layer: nodeId, path: rigPaths.ik(boneId) }, names: ['pole'] },
    set(nodeId, rigPaths.ikProp(boneId, 'pole'), values.vec2(pole.x, pole.y)),
  ];
}

export function removePoleCommands(nodeId: string, boneId: string): Command[] {
  return [{ type: 'removeProperties', props: [{ layer: nodeId, path: rigPaths.ikProp(boneId, 'pole') }] }];
}

/**
 * IK ⇄ FK as ONE action (a client macro over `planChainSwitch`, ikfk.ts): the
 * chain's mode, plus the pose that keeps the limb where it is — IK → FK writes
 * the solved rotations, FK → IK the goal at the effector. Keyed at the playhead
 * when `keyframe` (auto-keyframe on, or the mode already keyframed), else
 * static; a property that is already keyframed always takes a key there.
 * `layerT` is the DISPLAY sampling time of the live pose (keyAxisTimeForDisplay).
 */
export function chainSwitchCommands(
  nodeId: string,
  boneId: string,
  to: ChainMode,
  seconds: number,
  layerT: number,
  keyframe: boolean,
): Command[] {
  const skel = skelOf(nodeId);
  const target = skel?.ikTargets?.find((t) => t.boneId === boneId);
  if (!skel || !target) return [];
  const liveBones = (skel.bones ?? []).map((b) => {
    const r = defaultAnimation.sample(nodeId, `bone.${b.id}.rotation`, layerT);
    return typeof r === 'number' ? { ...b, rotation: r } : { ...b };
  });
  const plan = planChainSwitch(liveBones, resolveActiveIkTargets(skel, nodeId, layerT), boneId, to, target.chainLength);
  const out: Command[] = [];
  const modePath = rigPaths.ikProp(boneId, 'mode');
  const modeValue = values.scalar(to === 'fk' ? 0 : 1);
  // The static mode always follows (the chain's value with no track); a key too when keyframing.
  if (!isRigAnimated(nodeId, modePath)) out.push(set(nodeId, modePath, modeValue));
  if (keyframe || isRigAnimated(nodeId, modePath)) out.push(...rigValueCommands(nodeId, modePath, modeValue, seconds, true));
  for (const [id, rad] of plan.rotations) {
    out.push(...rigValueCommands(nodeId, rigPaths.boneProp(id, 'rotation'), values.scalar(rad * DEG), seconds, keyframe));
  }
  if (plan.target) out.push(...rigValueCommands(nodeId, rigPaths.ikProp(boneId, 'target'), values.vec2(plan.target.x, plan.target.y), seconds, keyframe));
  return out;
}

// ── Controllers ──────────────────────────────────────────────────────

export function addControllerCommands(nodeId: string, c: RigController): Command[] {
  const init: PropertyInit[] = [
    { path: 'drives', value: values.choice(c.link.kind) },
    { path: 'bone', value: values.string(c.link.boneId) },
    { path: 'shape', value: values.choice(c.shape) },
    { path: 'side', value: values.choice(c.side) },
    { path: 'size', value: values.scalar(c.size) },
  ];
  if (c.offsetX !== undefined || c.offsetY !== undefined) init.push({ path: 'offset', value: values.vec2(c.offsetX ?? 0, c.offsetY ?? 0) });
  return [{
    type: 'addPropertyGroup', layer: nodeId, parent: 'skeleton/controllers', matchName: 'Premation Rig Controller', init,
    ...(c.name ? { name: c.name } : {}),
  }];
}

export function controllerFieldCommands(nodeId: string, ctrlId: string, prop: 'shape' | 'side' | 'size', value: string | number): Command[] {
  return [set(nodeId, rigPaths.controllerProp(ctrlId, prop), typeof value === 'number' ? values.scalar(value) : values.choice(value))];
}

export function deleteControllerCommands(nodeId: string, ctrlId: string): Command[] {
  return [{ type: 'removePropertyGroups', groups: [{ layer: nodeId, path: rigPaths.controller(ctrlId) }] }];
}

// ── Whole rig (Auto-Rig) ─────────────────────────────────────────────

/**
 * A rig preset REPLACES the skeleton (`layer/skeleton`, one write): the bones
 * the old rig had lose their keys. A brand-new rig on an image / SVG layer is
 * skinned to the outline mesh, as drawing the first bone does.
 */
export function rigPresetCommands(nodeId: string, preset: SkeletonRig): Command[] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return [];
  let rig = preset;
  const kind = readNodeKind(node);
  if (rig.meshMode === undefined && (kind === 'image' || kind === 'svg')) rig = { ...rig, meshMode: 'silhouette' };
  return [set(nodeId, 'layer/skeleton', values.json(rig))];
}

function skelOf(nodeId: string): SkeletonRig | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeSkeleton(node) : undefined;
}
