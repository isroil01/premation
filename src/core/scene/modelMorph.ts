/**
 * Morph targets (blend shapes) for imported glTF models.
 *
 * A morphed primitive is base + Σ wₜ · deltaₜ per vertex — the classic facial
 * animation mechanism. The weights are ordinary animatable layer props
 * (`morph0`…`morphN-1` on the mesh layer's Transform), so a file's baked
 * 'weights' clip, a keyframed slider, or the graph editor all drive the same
 * numbers. Blending happens at snapshot time on the CPU, exactly like
 * skinning: the result rides the extrudedMesh carrier under a weight-hashed
 * buffer key, so a held expression uploads nothing and stale blends age out
 * of the renderer's pool by its normal idle GC. Per the glTF spec, morphing
 * applies BEFORE skinning — buildSnapshot feeds the morphed vertices into the
 * skinning pass as its base.
 */

import { MESH_VERTEX_FLOATS } from '@core/geometry/extrudeMesh';
import type { ModelPrimitiveEntry } from './modelMesh';
import type { SceneNode } from '@core/types';

/** Prefix of the animatable weight props on the mesh layer. */
export const MORPH_PROP_PREFIX = 'morph';

/**
 * The layer's current morph weights: animated track ∥ Transform prop ∥ 0.
 * Returns null when every weight is zero — the caller then skips blending.
 */
export function readMorphWeights(
  node: SceneNode,
  animated: { has(p: string): boolean; get(p: string): number | undefined } | null | undefined,
  targetCount: number,
): number[] | null {
  if (targetCount === 0) return null;
  let props: Record<string, unknown> | null = null;
  for (const c of node.components) {
    if (c.type === 'Transform') { props = c.props as Record<string, unknown>; break; }
  }
  const out = new Array<number>(targetCount);
  let any = false;
  for (let i = 0; i < targetCount; i++) {
    const key = `${MORPH_PROP_PREFIX}${i}`;
    const av = animated?.has(key) ? animated.get(key) : undefined;
    const base = typeof props?.[key] === 'number' ? (props[key] as number) : 0;
    const w = av !== undefined ? av : base;
    out[i] = w;
    if (w !== 0) any = true;
  }
  return any ? out : null;
}

/** Blend base vertices with weighted target deltas; renormalize normals. */
export function morphVertices(
  base: Float32Array,
  targets: ModelPrimitiveEntry['morphTargets'],
  weights: number[],
): Float32Array {
  const out = new Float32Array(base);
  const vcount = base.length / MESH_VERTEX_FLOATS;
  for (let t = 0; t < weights.length && t < targets.length; t++) {
    const w = weights[t]!;
    if (w === 0) continue;
    const tg = targets[t]!;
    for (let v = 0; v < vcount; v++) {
      const o = v * MESH_VERTEX_FLOATS;
      const d = v * 3;
      if (tg.positions) {
        out[o] = out[o]! + w * tg.positions[d]!;
        out[o + 1] = out[o + 1]! + w * tg.positions[d + 1]!;
        out[o + 2] = out[o + 2]! + w * tg.positions[d + 2]!;
      }
      if (tg.normals) {
        out[o + 3] = out[o + 3]! + w * tg.normals[d]!;
        out[o + 4] = out[o + 4]! + w * tg.normals[d + 1]!;
        out[o + 5] = out[o + 5]! + w * tg.normals[d + 2]!;
      }
    }
  }
  // One renormalize pass, after all targets have stacked their deltas.
  for (let v = 0; v < vcount; v++) {
    const o = v * MESH_VERTEX_FLOATS;
    const len = Math.hypot(out[o + 3]!, out[o + 4]!, out[o + 5]!);
    if (len > 1e-6) {
      out[o + 3] = out[o + 3]! / len;
      out[o + 4] = out[o + 4]! / len;
      out[o + 5] = out[o + 5]! / len;
    }
  }
  return out;
}

/** Weight-vector hash — the blend's buffer-cache identity (quantized). */
export function morphTag(weights: number[]): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < weights.length; i++) {
    const q = Math.round(weights[i]! * 4096) | 0;
    h = Math.imul(h ^ (q & 0xffff), 0x01000193);
    h = Math.imul(h ^ ((q >> 16) & 0xffff), 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const morphMemo = new Map<string, { tag: string; vertices: Float32Array }>();
const MORPH_MEMO_CAP = 64;

/** TEST SEAM. */
export function clearMorphMemo(): void {
  morphMemo.clear();
}

/**
 * The morphed geometry for a primitive at the layer's current weights, or
 * null when nothing morphs (no targets, all weights zero).
 */
export function morphedMeshFor(
  node: SceneNode,
  entry: ModelPrimitiveEntry,
  animated: { has(p: string): boolean; get(p: string): number | undefined } | null | undefined,
): { key: string; vertices: Float32Array; tag: string } | null {
  if (entry.morphTargets.length === 0) return null;
  const weights = readMorphWeights(node, animated, entry.morphTargets.length);
  if (!weights) return null;
  const tag = morphTag(weights);
  const memoKey = `${entry.key}#${node.id}`;
  const memo = morphMemo.get(memoKey);
  let vertices: Float32Array;
  if (memo && memo.tag === tag) {
    vertices = memo.vertices;
  } else {
    vertices = morphVertices(entry.vertices, entry.morphTargets, weights);
    if (morphMemo.size >= MORPH_MEMO_CAP && !morphMemo.has(memoKey)) {
      const oldest = morphMemo.keys().next().value;
      if (oldest !== undefined) morphMemo.delete(oldest);
    }
    morphMemo.set(memoKey, { tag, vertices });
  }
  return { key: `${entry.key}:mo-${tag}`, vertices, tag };
}
