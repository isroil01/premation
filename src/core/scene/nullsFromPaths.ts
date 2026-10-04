/**
 * Create Nulls From Paths — one null object per vertex of a shape's outline.
 *
 * After Effects' script of the same name is how a drawn path gets rigged by
 * hand: you get a handle on every point, parent things to them, animate them.
 * The nulls land at each vertex's WORLD position and are then parented to the
 * shape, so the whole constellation travels with the layer's transform while
 * each null stays an independently positionable handle.
 *
 * Two directions, as in AE:
 *   • Nulls Follow Points — a one-time placement; the nulls are handles you
 *     then parent things to or keyframe on their own.
 *   • Points Follow Nulls — the path is REBUILT every frame from the nulls.
 *     Done as a render-time binding (`Geometry.pointBindings`, resolved in
 *     buildSnapshot) rather than an expression: the expression language has no
 *     data-track form, and a binding the renderer resolves is live through any
 *     parenting or keyframing of the null, which is exactly what the feature
 *     is for.
 *
 * The engine's document, not the page replica: the vertices are the shape's
 * Path (`layer/path.points`) off the mirror, its value at the time asked of
 * the engine when keyed; the nulls are laid into a fragment
 * (layout/Scene/layerCreateEdits.ts pastes it under the shape).
 */

import type { Value } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { uiKindOf } from '@core/mirror/layerKinds';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';
import type { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { documentMirror } from '@stores/documentMirror';

export interface Pt { x: number; y: number }

const PATH = 'layer/path.points';

/** The anchor points of a Path value (layer space), [] for anything else. */
export function pathValueVertices(v: Value | undefined): Pt[] {
  if (v?.kind !== 'path') return [];
  const flat = v.value.vertices;
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i]!, y: flat[i + 1]! });
  return out;
}

/**
 * A shape layer's anchor points in LAYER space at comp `seconds` — the animated
 * path's value at that time when it is keyed. [] for a layer that is not a
 * shape or has no drawn outline (a primitive).
 */
export async function pathVertices(shapeId: string, seconds: number): Promise<Pt[]> {
  const m = documentMirror();
  if (uiKindOf(m.layer(shapeId)) !== 'shape') return [];
  await m.loadTree(shapeId);
  const info = m.property(shapeId, PATH);
  if (!info) return [];
  if (!info.animated) return pathValueVertices(info.value);
  const res = await engine().query({ type: 'getPropertyValues', props: [{ layer: shapeId, path: PATH }], time: compTime(seconds), evaluated: true });
  return pathValueVertices(res.ok ? res.value.values[0]?.value : info.value);
}

/**
 * Lay one null per vertex into `b`, in vertex order (the scratch ids). A
 * Geometry vertex is already in the shape's LOCAL space — the space a child's
 * position is expressed in — so each null, pasted UNDER the shape, is born at
 * the vertex's own coordinates and sits on it by construction: no world-space
 * round trip, nothing to drift.
 */
export function buildNullsFromPath(b: FragmentBuilder, shapeName: string, verts: readonly Pt[]): string[] {
  const baseName = shapeName || 'Path';
  return verts.map((v, i) => b.layer({
    name: `${baseName} · Point ${i + 1}`,
    components: [{ id: '', type: 'Transform', props: { [SCENE_KIND_PROP]: 'null', x: v.x, y: v.y, rotation: 0 } }],
  }));
}
