/**
 * Per-layer 3D material options (AE's Material Options).
 *   • **Casts Shadows** gates whether this layer contributes to the 2.5D
 *     cast-shadow pass (a silhouette drop-shadow thrown away from the first
 *     shadow-casting light).
 *   • **Accepts Lights** opts a 3D layer into the real shading pass: per-quad
 *     Lambert on the CPU-affine fallback, per-FRAGMENT Lambert + Blinn-Phong
 *     specular on the depth-tested GPU path (see lightShading.ts and the
 *     solid3d/textured3d shaders).
 *   • **Specular / Shininess** shape the Blinn-Phong highlight on that GPU
 *     path; specular 0 (the default) reduces to plain Lambert.
 *   • **Accepts Shadows** remains reserved: cast shadows render as a filter on
 *     the CASTER, so per-receiver gating is not expressible in this
 *     architecture — the flag is read/persisted for AE-parity but unconsumed.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export interface MaterialOptions {
  /** Whether this layer throws a 2.5D cast shadow. Default true. */
  castsShadows: boolean;
  /**
   * Whether this 3D layer responds to scene lights (per-quad Lambert shading
   * on the GPU 3D path). Default FALSE so every existing scene renders
   * byte-identically — lights keep behaving as screen-blended washes unless a
   * layer opts in.
   */
  acceptsLights: boolean;
  /**
   * Whether this 3D layer RECEIVES cast shadows from layers in front of it.
   *
   * No longer reserved: buildSnapshot now projects each shadow-casting layer
   * onto the plane of every accepting 3D layer behind it, so a shadow lands on
   * real geometry and moves with Z. Defaults TRUE — a receiver that silently
   * ignored shadows was the reason 3D scenes read as flat cut-outs.
   */
  acceptsShadows: boolean;
  /**
   * Blinn-Phong specular intensity, 0–100 (AE's Specular Intensity). Only
   * meaningful when acceptsLights is on and the layer renders through the
   * depth-tested GPU path. Default 0 = plain Lambert (no visual change).
   */
  specular: number;
  /** Blinn-Phong exponent (AE's Shininess, higher = tighter highlight). */
  shininess: number;
}

function transformProps(node: SceneNode): Record<string, unknown> {
  return (node.components.find((c) => c.type === 'Transform')?.props ?? {}) as Record<string, unknown>;
}

export function readNodeMaterial(node: SceneNode): MaterialOptions {
  const p = transformProps(node);
  return {
    castsShadows: p.castsShadows !== false,
    acceptsLights: p.acceptsLights === true,
    acceptsShadows: p.acceptsShadows !== false,
    specular: typeof p.specular === 'number' ? Math.max(0, Math.min(100, p.specular)) : 0,
    shininess: typeof p.shininess === 'number' ? Math.max(1, p.shininess) : 32,
  };
}

export function setNodeSpecular(nodeId: string, specular: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(0, Math.min(100, specular));
  // Store only non-default values so the common case adds nothing to file.
  defaultSceneGraph.writeProp(nodeId, t.id, 'specular', v > 0 ? v : undefined);
  bumpScene();
}

export function setNodeShininess(nodeId: string, shininess: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  const v = Math.max(1, shininess);
  defaultSceneGraph.writeProp(nodeId, t.id, 'shininess', v !== 32 ? v : undefined);
  bumpScene();
}

export function setNodeAcceptsLights(nodeId: string, accepts: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (!t) return;
  // Store only the non-default 'true' so the common case adds nothing to file.
  defaultSceneGraph.writeProp(nodeId, t.id, 'acceptsLights', accepts ? true : undefined);
  bumpScene();
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
