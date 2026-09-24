/**
 * rigEdits — the Puppet / Bones panels' writes as engine-API commands (B3z),
 * on the rig paths B3z WS-R designed (docs/ENGINE_API.md §15.9 "Rigging";
 * bindings src/core/engine/rigProps.ts ⇄ native rig.cpp; path spelling
 * src/core/engine/rigPaths.ts):
 *
 *   puppet/mesh/<field>                     mesh density / expansion / mode / solver / rotation refinement
 *   puppet/pins/<pin>/<prop>                a pin's rotation, scale (%), stiffness, overlap, extent, kind
 *   skeleton/mesh/<field>, skeleton/weightPaint
 *   skeleton/bones/<bone>/<prop>            length, influenceRadius; rotation / scale (the pose) and
 *                                           restRotation / restScale (the bind pose)
 *   skeleton/bones/<bone>/ik[/<prop>]       the IK goal (group), target, pole (optional), mode, chainLength
 *   skeleton/controllers/<ctrl>/<prop>      shape, side, size, offset, drives, bone
 *   layer/skeleton                          the whole rig (Auto-Rig presets: `applyRigPresetEdit`, rigPaths.ts)
 *
 * Group operations are the generic ones (addPropertyGroup, removePropertyGroups,
 * renamePropertyGroup, setGroupEnabled, addProperties / removeProperties). Every
 * builder returns the commands of ONE user action; the caller sends them as one
 * `edit` (or into a scrub gesture). Times are composition time (flicks): the
 * engine converts to the layer's keyframe axis.
 *
 * The skeleton builders take the rig state they decide from as arguments (the
 * panel reads it from the document mirror); "is it keyframed" is the mirror's
 * keyframe index. Only the puppet mesh builder still reads the scene graph.
 */

import type { Command, PropertyInit, Value } from '@motion/engine-api';
import { isLayer } from '@core/engine/doc';
import { compTime, values } from '@core/engine/propRefs';
import { rigMatch, rigPaths } from '@core/engine/rigPaths';
import type { IKTarget } from '@core/rig/skeletonCommands';
import type { Bone } from '@core/rig/skeleton';
import { planChainSwitch, type ChainMode } from '@core/rig/ikfk';
import type { IkTargetResolved } from '@core/rig/rigDeform';
import type { RigController } from '@core/rig/controllers';
import { documentMirror } from '@stores/documentMirror';

const DEG = 180 / Math.PI;

function set(layer: string, path: string, value: Value, seconds?: number): Command {
  return { type: 'setProperty', prop: { layer, path }, value, ...(seconds !== undefined ? { time: compTime(seconds) } : {}) };
}

/** Is the rig property at `path` keyframed? (The mirror holds every animated property's keys.) */
export function isRigAnimated(nodeId: string, path: string): boolean {
  return documentMirror().keyframes(nodeId, path).length > 0;
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
  const m = documentMirror();
  if (!m.layer(nodeId) || !isLayer(nodeId)) return [];
  const out: Command[] = [];
  // The rig's `puppet` group exists exactly when the layer has a puppet (rigProps.ts `rigGroupPaths`).
  if (!m.tree(nodeId)?.nodes.has(rigPaths.puppet)) out.push({ type: 'addPropertyGroup', layer: nodeId, parent: '', matchName: rigMatch.puppet, init: [] });
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

/** The painted weight map (null / undefined = none): ONE write, as a brush stroke on release is. */
export function weightPaintCommands(nodeId: string, map: unknown): Command[] {
  return [set(nodeId, rigPaths.weightPaint, values.json(map ?? null))];
}

/** Rename a bone; an empty (or blank) name removes it, so the bone reads as its id again. */
export function renameBoneCommands(nodeId: string, boneId: string, name: string): Command[] {
  return [{ type: 'renamePropertyGroup', group: { layer: nodeId, path: rigPaths.bone(boneId) }, name }];
}

/** Delete a bone: the engine removes its subtree, their IK goals, controllers, weights and keys. */
export function deleteBoneCommands(nodeId: string, boneId: string): Command[] {
  return [{ type: 'removePropertyGroups', groups: [{ layer: nodeId, path: rigPaths.bone(boneId) }] }];
}

/** Rest Length / Falloff: the bone's structure (read live, never from the bind pose). Falloff 0 = unlimited (cleared). */
export function boneFieldCommands(nodeId: string, boneId: string, prop: 'length' | 'influenceRadius', value: number): Command[] {
  return [set(nodeId, rigPaths.boneProp(boneId, prop), values.scalar(value))];
}

/**
 * A RIG-mode edit of a bone's rotation (DEGREES) or scale (multipliers): the
 * bind pose (`restRotation` / `restScale`) and — while the pose property is not
 * keyframed — its static value too, so the skin and the bone agree (what the
 * legacy `updateBone` did to `bones` and `bindPose` together). The static pose
 * write comes first: it pins the bind pose to the current bones when there is
 * none, and the rest write then moves this bone's entry.
 */
export function boneRestCommands(nodeId: string, boneId: string, prop: 'rotation' | 'scale', value: number | { x: number; y: number }): Command[] {
  const v: Value = typeof value === 'number'
    ? values.scalar(value)
    : values.vec2(value.x * 100, value.y * 100);
  const out: Command[] = [];
  if (!isRigAnimated(nodeId, rigPaths.boneProp(boneId, prop))) out.push(set(nodeId, rigPaths.boneProp(boneId, prop), v));
  out.push(set(nodeId, rigPaths.boneProp(boneId, prop === 'rotation' ? 'restRotation' : 'restScale'), v));
  return out;
}

/**
 * The bone's IK button, given the bone's current goal (`current`, from the
 * rig): a disabled goal is switched back on; an active one is removed with its
 * keys (the legacy `setIKTarget(enabled: false)` dropped it from the rig); no
 * goal = a new one at `at` (the chain's effector).
 */
export function ikToggleCommands(nodeId: string, boneId: string, current: IKTarget | undefined, at: { x: number; y: number }): Command[] {
  const group = { layer: nodeId, path: rigPaths.ik(boneId) };
  if (current && current.enabled === false) return [{ type: 'setGroupEnabled', groups: [group], enabled: true }];
  if (current) return [{ type: 'removePropertyGroups', groups: [group] }];
  const init: PropertyInit[] = [{ path: 'target', value: values.vec2(at.x, at.y) }];
  return [{ type: 'addPropertyGroup', layer: nodeId, parent: rigPaths.bone(boneId), matchName: rigMatch.ik, init }];
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

/** Remove the pole with its keys. */
export function removePoleCommands(nodeId: string, boneId: string): Command[] {
  return [{ type: 'removeProperties', props: [{ layer: nodeId, path: rigPaths.ikProp(boneId, 'pole') }] }];
}

/** The live pose a chain switch preserves: the bones and active IK goals as the solver sees them this frame. */
export interface LiveChainPose {
  bones: readonly Bone[];
  targets: readonly IkTargetResolved[];
  chainLength?: number;
}

/**
 * IK ⇄ FK as ONE action (a client macro over `planChainSwitch`, ikfk.ts): the
 * chain's mode, plus the pose that keeps the limb where it is — IK → FK writes
 * the solved rotations, FK → IK the goal at the effector. Keyed at the playhead
 * when `keyframe` (auto-keyframe on, or the mode already keyframed), else
 * static; a property that is already keyframed always takes a key there.
 * `seconds` is composition time; `live` is the pose sampled at the playhead.
 */
export function chainSwitchCommands(
  nodeId: string,
  boneId: string,
  to: ChainMode,
  seconds: number,
  keyframe: boolean,
  live: LiveChainPose,
): Command[] {
  const plan = planChainSwitch(live.bones, live.targets, boneId, to, live.chainLength);
  const out: Command[] = [];
  const modePath = rigPaths.ikProp(boneId, 'mode');
  const modeValue = values.scalar(to === 'fk' ? 0 : 1);
  const modeAnimated = isRigAnimated(nodeId, modePath);
  // The static mode always follows (the chain's value with no track); a key too when keyframing.
  if (!modeAnimated) out.push(set(nodeId, modePath, modeValue));
  if (keyframe || modeAnimated) out.push(...rigValueCommands(nodeId, modePath, modeValue, seconds, true));
  for (const [id, rad] of plan.rotations) {
    out.push(...rigValueCommands(nodeId, rigPaths.boneProp(id, 'rotation'), values.scalar(rad * DEG), seconds, keyframe));
  }
  if (plan.target) out.push(...rigValueCommands(nodeId, rigPaths.ikProp(boneId, 'target'), values.vec2(plan.target.x, plan.target.y), seconds, keyframe));
  return out;
}

// ── Controllers ──────────────────────────────────────────────────────

/** A new controller (the engine mints its id); `c.id` is ignored. */
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
    type: 'addPropertyGroup', layer: nodeId, parent: rigPaths.controllers, matchName: rigMatch.controller, init,
    ...(c.name ? { name: c.name } : {}),
  }];
}

export function controllerFieldCommands(nodeId: string, ctrlId: string, prop: 'shape' | 'side' | 'size', value: string | number): Command[] {
  return [set(nodeId, rigPaths.controllerProp(ctrlId, prop), typeof value === 'number' ? values.scalar(value) : values.choice(value))];
}

export function deleteControllerCommands(nodeId: string, ctrlId: string): Command[] {
  return [{ type: 'removePropertyGroups', groups: [{ layer: nodeId, path: rigPaths.controller(ctrlId) }] }];
}
