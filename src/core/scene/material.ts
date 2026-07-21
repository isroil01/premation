/**
 * Per-layer 3D material options (AE's Material Options). The 2.5D compositor has
 * no real lighting model — lights are screen-blended washes and shadows are a
 * projected drop-shadow — so of AE's material set only **Casts Shadows** maps
 * onto what actually renders here. It gates whether this layer contributes to
 * the cast-shadow pass. (Accepts Lights / Accepts Shadows / Ambient / Diffuse /
 * Specular need a genuine shading pass and are out of scope for the 2.5D core.)
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export interface MaterialOptions {
  /** Whether this layer throws a 2.5D cast shadow. Default true. */
  castsShadows: boolean;
}

function transformProps(node: SceneNode): Record<string, unknown> {
  return (node.components.find((c) => c.type === 'Transform')?.props ?? {}) as Record<string, unknown>;
}

export function readNodeMaterial(node: SceneNode): MaterialOptions {
  const p = transformProps(node);
  return { castsShadows: p.castsShadows !== false };
}

export function getNodeCastsShadows(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeMaterial(node).castsShadows : true;
}

export function setNodeCastsShadows(nodeId: string, casts: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  // Store only the non-default 'false' so the common case adds nothing to file.
  defaultSceneGraph.writeProp(nodeId, t.id, 'castsShadows', casts ? undefined : false);
  bumpScene();
}
