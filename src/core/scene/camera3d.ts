/**
 * Composition 3D camera — resolved from the scene.
 *
 * If the comp contains a Camera layer, its Transform props drive the view
 * (position x/y, depth z, and focalLength); otherwise a sensible default camera
 * framed to the comp is used. The renderer (buildSnapshot) projects 3D layers
 * through whatever this returns, so adding a Camera and animating it pans /
 * dollies the whole 3D scene — exactly like After Effects.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { Project3D, type Camera3D } from '@motion/scene';

/** Default focal length (px) for a comp of the given width. */
export function defaultFocalLength(width: number): number {
  return Project3D.defaultCamera(width, 1).focalLength;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Read x/y/z/focalLength off a camera node's components. */
function cameraFromNode(node: SceneNode, width: number, height: number): Camera3D {
  const def = Project3D.defaultCamera(width, height);
  let x: number | undefined, y: number | undefined, z: number | undefined, focal: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    x = num(p.x) ?? x;
    y = num(p.y) ?? y;
    z = num(p.z) ?? z;
    focal = num(p.focalLength) ?? focal;
  }
  const focalLength = focal ?? def.focalLength;
  return {
    focalLength,
    // A camera with no explicit z sits pulled back by its focal length (so the
    // comp plane renders 1:1), matching the default camera.
    position: { x: x ?? def.position.x, y: y ?? def.position.y, z: z ?? -focalLength },
  };
}

/**
 * The active camera for a composition: the first Camera layer if present,
 * otherwise the default camera framed to the comp.
 */
export function readSceneCamera(graph: SceneGraph, width: number, height: number): Camera3D {
  for (const node of flattenScene(graph)) {
    if (readNodeKind(node) === 'camera') return cameraFromNode(node, width, height);
  }
  return Project3D.defaultCamera(width, height);
}
