/**
 * Rig paths and commands for UI code (B3z WS-R, ENGINE_API.md §15.9 "Rigging").
 *
 * Pure builders: the overlays (PuppetOverlay, BoneOverlay), the inspector's
 * rig panels and the rig-preset command build their engine commands from
 * these, so the path spelling lives in one place. Times are COMPOSITION
 * seconds (converted to flicks here); values are API units (degrees, percent).
 */

import type { Command, PropRef, Value } from '@motion/engine-api';
import { RIG_GROUP_MATCH } from './rigSpecs';
import { compTime } from './propRefs';
import { edit } from './uiEdits';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { validateRig, type RigProblem } from '@core/rig/rigPresets';
import type { SkeletonRig } from '@core/rig/skeletonCommands';

export const rigPaths = {
  puppet: 'puppet',
  pins: 'puppet/pins',
  pin: (pinId: string): string => `puppet/pins/${pinId}`,
  pinProp: (pinId: string, prop: 'position' | 'rotation' | 'scale' | 'stiffness' | 'overlap' | 'overlapExtent' | 'kind' | 'restPosition'): string =>
    `puppet/pins/${pinId}/${prop}`,
  puppetMesh: (field: 'density' | 'expansion' | 'mode' | 'solver' | 'rotationRefinement'): string => `puppet/mesh/${field}`,
  skeleton: 'skeleton',
  bones: 'skeleton/bones',
  bone: (boneId: string): string => `skeleton/bones/${boneId}`,
  boneProp: (boneId: string, prop: 'position' | 'rotation' | 'scale' | 'parent' | 'length' | 'influenceRadius' | 'restPosition' | 'restRotation' | 'restScale'): string =>
    `skeleton/bones/${boneId}/${prop}`,
  ik: (boneId: string): string => `skeleton/bones/${boneId}/ik`,
  ikProp: (boneId: string, prop: 'target' | 'pole' | 'mode' | 'chainLength'): string => `skeleton/bones/${boneId}/ik/${prop}`,
  skeletonMesh: (field: 'density' | 'expansion' | 'mode'): string => `skeleton/mesh/${field}`,
  weightPaint: 'skeleton/weightPaint',
  controllers: 'skeleton/controllers',
  controller: (id: string): string => `skeleton/controllers/${id}`,
  controllerProp: (id: string, prop: 'shape' | 'side' | 'size' | 'offset' | 'drives' | 'bone'): string => `skeleton/controllers/${id}/${prop}`,
  wholePuppet: 'layer/puppet',
  wholeSkeleton: 'layer/skeleton',
} as const;

export const rigMatch = RIG_GROUP_MATCH;

const RAD_TO_DEG = 180 / Math.PI;

export const rigValues = {
  vec2: (x: number, y: number): Value => ({ kind: 'vec2', value: { x, y } }),
  scalar: (value: number): Value => ({ kind: 'scalar', value }),
  choice: (value: string): Value => ({ kind: 'choice', value }),
  string: (value: string): Value => ({ kind: 'string', value }),
  json: (v: unknown): Value => ({ kind: 'json', value: JSON.stringify(v ?? null) }),
  /** A bone rotation as stored (radians) → the API value (degrees). */
  radians: (rad: number): Value => ({ kind: 'scalar', value: rad * RAD_TO_DEG }),
};

const ref = (layer: string, path: string): PropRef => ({ layer, path });

/** One key on a rig property at comp time `seconds` (replaces a key there, keeping its id). */
export function rigKey(layer: string, path: string, seconds: number, value: Value, extra: { easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' } = {}): Command {
  return {
    type: 'addKeyframes',
    keys: [{ prop: ref(layer, path), time: compTime(seconds), value, spatialIn: [], spatialOut: [], ...(extra.easing ? { easing: extra.easing } : {}) }],
  };
}

/** A static (un-keyed) write. */
export function rigSet(layer: string, path: string, value: Value): Command {
  return { type: 'setProperty', prop: ref(layer, path), value };
}

/**
 * Apply a rig preset (bones, IK chains, controllers) as ONE undo entry: a
 * whole-rig `layer/skeleton` write. REPLACES the existing skeleton (merging
 * would duplicate bone ids — skeletonCommands `applyRigPreset`); bones the new
 * rig lacks lose their keys. An invalid rig is refused before anything is sent
 * (the problems come back). The first rig on an image / SVG layer gets the
 * outline mesh, as a hand-drawn first bone does.
 */
export async function applyRigPresetEdit(nodeId: string, preset: SkeletonRig, label = 'Auto-Rig'): Promise<RigProblem[]> {
  const problems = validateRig(preset);
  if (problems.length > 0) return problems;
  const node = defaultSceneGraph.getNode(nodeId);
  const kind = node ? readNodeKind(node) : '';
  const rig = preset.meshMode === undefined && (kind === 'image' || kind === 'svg') ? { ...preset, meshMode: 'silhouette' as const } : preset;
  await edit(label, rigSet(nodeId, rigPaths.wholeSkeleton, rigValues.json(rig)));
  return [];
}

/** Remove rig groups (pins, bones with their subtree, IK goals, controllers, whole rigs). */
export function rigRemove(layer: string, groupPaths: readonly string[]): Command {
  return { type: 'removePropertyGroups', groups: groupPaths.map((p) => ref(layer, p)) };
}
