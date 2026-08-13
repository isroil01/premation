/**
 * Auto-orient — a layer's rotation is DERIVED rather than authored.
 *
 * After Effects offers three modes:
 *   • Off — the layer keeps its own rotation.
 *   • Orient Along Path — face the direction of travel on the motion path
 *                             (see motionPath.autoOrientAngleDeg).
 *   • Orient Towards Camera — a 3D layer always faces the active camera. This
 *                             is AE's per-layer, OPT-IN billboard. A renderer
 *                             that billboards every layer globally is broken,
 *                             not convenient: rotating the view would then
 *                             change nothing and the scene would look
 *                             permanently flat-on.
 *
 * A camera layer's "Orient Towards Point of Interest" is deliberately NOT a
 * mode here: a camera carrying POI props always aims at them already (see
 * camera3d.ts's two-node path), so a switch expressing the same thing would be
 * a second source of truth for one behaviour.
 *
 * Stored on the layer's `fx` component. The legacy boolean `true` reads as
 * `path`, so projects written before the mode existed are unchanged.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { bumpScene } from '@stores/sceneStore';

export type AutoOrientMode = 'off' | 'path' | 'camera';

/**
 * The kinds `buildSnapshot` SKIPS before it ever consults auto-orient.
 *
 * Both readers (`readNodeAutoOrient`, `isAutoOrientedToCamera`) are called from
 * inside the drawn-layer loop, and that loop `continue`s past these four kinds
 * at its top and diverts `light` a few lines later. So on any of them the mode
 * is stored, persisted and displayed — and read by nobody.
 *
 * Kept as data rather than prose because `autoOrientKindParity.test.ts` reads
 * the skip list back out of `buildSnapshot.ts` and fails if the two drift.
 */
export const AUTO_ORIENT_DEAD_KINDS: ReadonlySet<string> = new Set([
  'group', 'null', 'camera', 'audio', 'light',
]);

/**
 * True when auto-orient can actually change pixels for this node.
 *
 * Every auto-orient affordance gates on this ONE predicate, for the same reason
 * `canBe3D` exists in `threeD.ts`: a control must not light up without pixels
 * changing. It was added after the dropdown was found offering "Along Path" on
 * cameras, lights, nulls and groups — five kinds where nothing reads the value.
 *
 * `null` is the one that stings. Auto-orienting a null with children parented
 * to it is a standard AE rig, and the control looked available. Hiding it is
 * honest, not a fix: making it WORK means composing a derived rotation into the
 * null's own transform so children inherit it, which is a change to the parent
 * composition path rather than to this module.
 */
export function canAutoOrient(node: SceneNode): boolean {
  if (!node.components.some((c) => c.type === 'Transform')) return false;
  return !AUTO_ORIENT_DEAD_KINDS.has(readNodeKind(node));
}

function fxProps(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

/** A layer's auto-orient mode (legacy `true` ⇒ `path`). */
export function readAutoOrientMode(node: SceneNode): AutoOrientMode {
  const v = fxProps(node)?.autoOrient;
  if (v === 'camera') return 'camera';
  if (v === 'path' || v === true) return 'path';
  return 'off';
}

/** True when the layer auto-orients along its motion path. */
export function isAutoOriented(node: SceneNode): boolean {
  return readAutoOrientMode(node) === 'path';
}

/** Read a node's along-path auto-orient flag by id (buildSnapshot convenience). */
export function readNodeAutoOrient(node: SceneNode): boolean {
  return isAutoOriented(node);
}

/** True when the layer should face the active camera (AE's opt-in billboard). */
export function isAutoOrientedToCamera(node: SceneNode): boolean {
  return readAutoOrientMode(node) === 'camera';
}

/** Turn along-path auto-orient on/off for a layer (legacy boolean API). */
export function setAutoOriented(nodeId: string, on: boolean): void {
  setAutoOrientMode(nodeId, on ? 'path' : 'off');
}

export function setAutoOrientMode(nodeId: string, mode: AutoOrientMode): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  if (mode === 'off') {
    defaultSceneGraph.setAutoOrient(nodeId, undefined);
  } else {
    // `path` persists as the legacy boolean, so a project round-trips
    // identically through readers written before this mode existed.
    defaultSceneGraph.setAutoOrient(nodeId, true);
    if (mode === 'camera') {
      const fx = defaultSceneGraph.getNode(nodeId)?.components.find((c) => c.type === 'fx');
      if (fx) defaultSceneGraph.writeProp(nodeId, fx.id, 'autoOrient', 'camera');
    }
  }
  bumpScene();
}
