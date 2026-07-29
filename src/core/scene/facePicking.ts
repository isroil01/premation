/**
 * Face picking for extruded 3D layers — which SIDE of an object is under the
 * pointer.
 *
 * Extrusion faces are synthetic: `buildSnapshot` derives them per frame and they
 * are not scene nodes, so the workspace hit-tester (which walks the scene graph)
 * cannot see them. Picking one therefore means re-deriving the same geometry and
 * testing it in screen space, which is what this module does — using the SAME
 * `extrusionFaces` + world matrix + projector the renderer uses, so what you
 * click is what you see.
 *
 * Pure: it takes a projector rather than reading the view itself, so it is
 * testable without a camera or a canvas.
 */

import { extrusionFaces, clampBevel } from '@core/scene/extrusion';
import { faceKindOf, type FaceKind } from '@core/scene/faceMaterials';
import { readNode3D } from '@core/scene/threeD';
import { Matrix4Math, type Matrix4 } from '@motion/scene';
import { readGeometry } from '@core/workspace/geometry';
import { nodeWorld3d } from '@core/scene/nodeMatrix';
import { currentViewProjector } from '@core/workspace/viewProjection';
import type { SceneNode } from '@core/types';

export interface PickedFace {
  /** Which material group the face belongs to (what the inspector edits). */
  kind: FaceKind;
  /** Renderer face suffix (`r`, `w7`, `cfr`, `back`) — 'front' for the cap. */
  suffix: string;
  /** Projected quad in comp space, for highlighting. */
  quad: Array<{ x: number; y: number }>;
  /** View depth of the face centre; smaller = nearer the camera. */
  depth: number;
  /**
   * Projected area in comp px². A face seen edge-on collapses to ~0 and must not
   * be pickable: turn a cube 90° and its front cap becomes a line sitting at the
   * NEAREST depth, so nearest-wins alone would hand every click on the visible
   * side wall to a face the user cannot see.
   */
  area: number;
}

/** Below this projected area a face is edge-on and effectively invisible. */
const MIN_PICKABLE_AREA = 4;

/** Absolute polygon area (shoelace). */
function polygonArea(q: ReadonlyArray<Pt>): number {
  let a = 0;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    a += q[j]!.x * q[i]!.y - q[i]!.x * q[j]!.y;
  }
  return Math.abs(a) / 2;
}

interface Pt {
  x: number;
  y: number;
}

function pointInQuad(p: Pt, q: ReadonlyArray<Pt>): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!;
    const b = q[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Every drawable face of an extruded layer, projected to comp space.
 *
 * `world3d` is the layer's model matrix (the same one buildSnapshot composes);
 * `layerW/H` its plane size. Returns an empty list for a layer with no extrusion,
 * which has only the front face and is already pickable as the layer itself.
 */
export function projectedFaces(
  node: SceneNode,
  world3d: Matrix4,
  layerW: number,
  layerH: number,
  project: (p: { x: number; y: number; z: number }) => { x: number; y: number; depth: number },
  isEllipse = false,
): PickedFace[] {
  const d3 = readNode3D(node);
  const depth = d3.extrusionDepth;
  if (!(depth > 0) || !(layerW > 0) || !(layerH > 0)) return [];

  const shape = isEllipse ? 'ellipse' : 'rect';
  const bevel = shape === 'rect' ? clampBevel(layerW, layerH, depth, d3.bevelDepth) : 0;
  const out: PickedFace[] = [];

  const quadOf = (m: Matrix4, w: number, h: number): { quad: Pt[]; depth: number; area: number } => {
    const hw = w / 2;
    const hh = h / 2;
    const corners = [
      { x: -hw, y: -hh, z: 0 }, { x: hw, y: -hh, z: 0 },
      { x: hw, y: hh, z: 0 }, { x: -hw, y: hh, z: 0 },
    ];
    const quad: Pt[] = [];
    let dSum = 0;
    for (const c of corners) {
      const p = project(Matrix4Math.transformPoint(m, c));
      quad.push({ x: p.x, y: p.y });
      dSum += p.depth;
    }
    return { quad, depth: dSum / 4, area: polygonArea(quad) };
  };

  for (const f of extrusionFaces(layerW, layerH, depth, shape, undefined, { bevel: d3.bevelDepth, bevelStyle: d3.bevelStyle })) {
    const m = Matrix4Math.multiply(world3d, f.m);
    const { quad, depth: d, area } = quadOf(m, f.w, f.h);
    out.push({ kind: faceKindOf(f.role, f.suffix), suffix: f.suffix, quad, depth: d, area });
  }

  // The front cap is the layer's own plane, inset by the bevel exactly as the
  // renderer insets it.
  const frontInset = bevel;
  const { quad, depth: d, area } = quadOf(world3d, layerW - 2 * frontInset, layerH - 2 * frontInset);
  out.push({ kind: 'front', suffix: 'front', quad, depth: d, area });

  return out;
}

/**
 * The face under `point` (comp space), or null.
 *
 * Nearest wins: faces overlap in screen space by construction, and the one the
 * user sees is the one closest to the camera.
 */
export function pickFace(faces: ReadonlyArray<PickedFace>, point: Pt): PickedFace | null {
  let best: PickedFace | null = null;
  for (const f of faces) {
    if (f.area < MIN_PICKABLE_AREA) continue;
    if (!pointInQuad(point, f.quad)) continue;
    if (!best || f.depth < best.depth) best = f;
  }
  return best;
}

/**
 * Faces of a live scene node in the CURRENT view, at `time` (raw comp time).
 *
 * The viewport wrapper over the two pure functions above — it resolves the
 * node's matrix and the view's projector, both from their single sources.
 */
export function facesOfNode(node: SceneNode, time: number, compW: number, compH: number): PickedFace[] {
  const g = readGeometry(node);
  if (!g) return [];
  const world = nodeWorld3d(node, time);
  if (!world) return [];
  const project = currentViewProjector(compW, compH, time);
  return projectedFaces(node, world, g.width, g.height, project, g.ellipse);
}
