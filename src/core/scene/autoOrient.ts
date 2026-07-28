/**
 * Auto-orient — a layer's rotation is DERIVED rather than authored.
 *
 * After Effects offers three modes:
 *   • Off                   — the layer keeps its own rotation.
 *   • Orient Along Path     — face the direction of travel on the motion path
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
import { bumpScene } from '@stores/sceneStore';

export type AutoOrientMode = 'off' | 'path' | 'camera';

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
