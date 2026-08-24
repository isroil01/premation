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
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNodeKind } from '@core/scene/sceneDerive';
import { defaultAnimation } from '@motion/animation';
import { getRemappedTime } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';

interface Pt { x: number; y: number }

/** The shape's anchor points in LAYER space at `time` — the animated path if there is one. */
export function pathVertices(node: SceneNode, time: number): Pt[] {
  const live = defaultAnimation.sampleData(node.id, 'path.points', getRemappedTime(node.id, time));
  if (Array.isArray(live) && live.length > 0 && typeof live[0] === 'object' && live[0] !== null && 'x' in (live[0] as object)) {
    return (live as Pt[]).map((p) => ({ x: p.x, y: p.y }));
  }
  const geom = node.components.find((c) => c.type === 'Geometry');
  const pts = geom?.props.points;
  if (Array.isArray(pts) && pts.length > 0) return (pts as Pt[]).map((p) => ({ x: p.x, y: p.y }));
  return [];
}

let seq = 0;

/**
 * Create the nulls. Returns their ids, in vertex order, and selects them so
 * the next gesture — parent something, add keyframes — acts on the set.
 */
export function createNullsFromPath(
  shapeId: string,
  time: number,
  opts: { pointsFollowNulls?: boolean } = {},
): string[] {
  const node = defaultSceneGraph.getNode(shapeId);
  if (!node || readNodeKind(node) !== 'shape') return [];
  const verts = pathVertices(node, time);
  if (verts.length === 0) return [];

  // A Geometry vertex is already in the shape's LOCAL space — the same space
  // a child's position is expressed in. So the null is born as a child at the
  // vertex's own coordinates and sits on it by construction; no world-space
  // round trip, nothing to drift. The world position is only needed to pin
  // the claim in tests (`world2DAt(null) === world2DAt(shape) · vertex`).
  const baseName = node.name ?? 'Path';
  const ids: string[] = [];

  verts.forEach((v, i) => {
    const id = `null_${baseName.replace(/\s+/g, '_').toLowerCase()}_${i + 1}_${(seq += 1)}`;
    const nullNode: SceneNode = {
      id,
      name: `${baseName} · Point ${i + 1}`,
      parent: shapeId,
      children: [],
      transform: { position: { x: v.x, y: v.y }, rotation: 0, scale: { x: 1, y: 1 } },
      visible: true,
      locked: false,
      components: [
        { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'null', x: v.x, y: v.y, rotation: 0 } },
      ],
    };
    defaultSceneGraph.addChild(shapeId, nullNode);
    ids.push(id);
  });

  if (opts.pointsFollowNulls) {
    // Bind each vertex to its null. Written through the graph's prop writer,
    // not onto the component view, which is a throwaway (see assetRebind).
    const geom = node.components.find((c) => c.type === 'Geometry');
    if (geom) {
      const bindings = ids.map((nullId, index) => ({ index, nullId }));
      defaultSceneGraph.writeProp(shapeId, geom.id, 'pointBindings', bindings);
    }
  }

  useSelectionStore.getState().set(ids);
  bumpScene();
  return ids;
}

/** Drop every point binding on a shape; the path keeps its current vertices. */
export function clearPointBindings(shapeId: string): void {
  const node = defaultSceneGraph.getNode(shapeId);
  const geom = node?.components.find((c) => c.type === 'Geometry');
  if (!node || !geom) return;
  defaultSceneGraph.writeProp(shapeId, geom.id, 'pointBindings', undefined);
  bumpScene();
}
