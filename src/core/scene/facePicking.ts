/**
 * Face picking for extruded 3D layers — which SIDE of an object is under the
 * pointer.
 *
 * Extrusion faces are synthetic: the engine derives them per frame and they are
 * not layers, so the workspace hit-tester cannot see them. The GEOMETRY is the
 * engine's — `getLayerFaces` (native/engine/src/scene/layer_faces.cpp) answers
 * the renderer's own extrusion mesh with its front cap, or its flat-quad
 * fallback, in world px (layout/Workspace/layerFaces.ts asks). This module is
 * the view half, which is editor state: project those faces through the view
 * the pane shows, pick the one under the pointer, group them for the highlight.
 *
 * Two face shapes arrive:
 *   • mesh TRIANGLES (`verts` set) — the traced glyphs of a text layer, the
 *     runs of a path shape, a rounded rect / ellipse ring — so a click on a
 *     glyph's wall hits that wall and a click in the layer box beside the glyph
 *     hits nothing;
 *   • flat QUADS — the fallback when the engine has no outline for the layer.
 *
 * Pure: it takes a projector rather than reading the view itself, so it is
 * testable without a camera or a canvas.
 */

import type { FaceKind } from '@core/scene/faceMaterials';

export interface PickedFace {
  /** Which material group the face belongs to (what the inspector edits). */
  kind: FaceKind;
  /**
   * Renderer face suffix (`r`, `w7`, `cfr`, `back`) — 'front' for the cap. A
   * mesh triangle carries its ROLE (`side`, `bevel`, `back`, `front`): the mesh
   * has no per-wall identity, and the material axis is the kind anyway, so
   * every triangle of a kind shares the suffix and highlights as one surface.
   */
  suffix: string;
  /** Projected polygon in comp space, for highlighting (3 points for a mesh triangle). */
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
  /**
   * Mesh vertex indices of a triangle face — lets the highlight find the
   * BOUNDARY of a set of triangles (edges used once) and outline the surface
   * rather than every triangle. Absent on a quad-fallback face.
   */
  verts?: readonly [number, number, number];
}

/** Below this projected area a quad face is edge-on and effectively invisible. */
const MIN_PICKABLE_AREA = 4;
/**
 * Mesh triangles are legitimately tiny (a bevel segment on a glyph corner is
 * well under a pixel), and back-facing ones are already culled, so only a
 * numerically degenerate sliver is rejected.
 */
const MIN_PICKABLE_TRI_AREA = 0.05;

/** Whether a face is large enough on screen to be clicked (or drawn). */
export function isPickableFace(f: PickedFace): boolean {
  return f.area >= (f.verts ? MIN_PICKABLE_TRI_AREA : MIN_PICKABLE_AREA);
}

interface Pt {
  x: number;
  y: number;
}

/** Signed polygon area (shoelace); the sign is the winding on screen. */
function signedPolygonArea(q: ReadonlyArray<Pt>): number {
  let a = 0;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    a += q[j]!.x * q[i]!.y - q[i]!.x * q[j]!.y;
  }
  return a / 2;
}

function polygonArea(q: ReadonlyArray<Pt>): number {
  return Math.abs(signedPolygonArea(q));
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

type Projector = (p: { x: number; y: number; z: number }) => { x: number; y: number; depth: number; clipped?: boolean };

/**
 * One face as the engine answers `getLayerFaces` (B4 round 8): its polygon in
 * WORLD px (the layer's model matrix applied), a mesh triangle carrying its
 * vertex indices.
 */
export interface WorldFace {
  kind: FaceKind;
  suffix: string;
  points: ReadonlyArray<{ x: number; y: number; z: number }>;
  verts?: readonly [number, number, number];
}

/**
 * The engine's world-space faces through a view's projector.
 *
 * Mesh triangles are back-face culled. The engine winds every triangle to agree
 * with its outward normal, so after projection every camera-facing triangle has
 * the SAME sign of signed area — which sign depends on the projector's
 * handedness and any mirroring in the layer's matrix. Rather than reason about
 * those, the rule is calibrated from the caps: whichever cap is nearer the
 * camera is the one being looked at, and its winding is the "facing" one. Both
 * caps edge-on (the object turned 90°) leaves nothing to calibrate from, and
 * then nearest-wins alone is enough — the near wall is in front of the far one.
 *
 * Quads are not culled; an edge-on one is simply too small to pick
 * (`isPickableFace`).
 */
export function projectWorldFaces(faces: ReadonlyArray<WorldFace>, project: Projector): PickedFace[] {
  const out: PickedFace[] = [];
  let mesh = false;
  for (const f of faces) {
    const quad: Pt[] = [];
    let depth = 0;
    let clipped = false;
    for (const p of f.points) {
      const s = project(p);
      if (s.clipped) clipped = true;
      quad.push({ x: s.x, y: s.y });
      depth += s.depth;
    }
    if (clipped || quad.length < 3) continue;
    depth /= quad.length;
    if (f.verts) {
      mesh = true;
      out.push({ kind: f.kind, suffix: f.suffix, quad, depth, area: signedPolygonArea(quad), verts: f.verts });
    } else {
      out.push({ kind: f.kind, suffix: f.suffix, quad, depth, area: polygonArea(quad) });
    }
  }
  if (!mesh) return out;
  // The nearer cap's winding is the facing one.
  let frontArea = 0, frontDepth = 0, frontN = 0;
  let backArea = 0, backDepth = 0, backN = 0;
  for (const f of out) {
    if (f.kind === 'front') { frontArea += f.area; frontDepth += f.depth; frontN++; }
    else if (f.kind === 'back') { backArea += f.area; backDepth += f.depth; backN++; }
  }
  const capOk = (area: number) => Math.abs(area) >= MIN_PICKABLE_AREA;
  let facing = 0;
  if (frontN && backN && capOk(frontArea) && capOk(backArea)) {
    facing = frontDepth / frontN <= backDepth / backN ? Math.sign(frontArea) : Math.sign(backArea);
  } else if (frontN && capOk(frontArea)) facing = Math.sign(frontArea);
  else if (backN && capOk(backArea)) facing = Math.sign(backArea);
  const visible: PickedFace[] = [];
  for (const f of out) {
    if (f.verts && facing !== 0 && Math.sign(f.area) === -facing) continue;
    visible.push({ ...f, area: Math.abs(f.area) });
  }
  return visible;
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
    if (!isPickableFace(f)) continue;
    if (!pointInQuad(point, f.quad)) continue;
    if (!best || f.depth < best.depth) best = f;
  }
  return best;
}

// ── Highlight grouping ───────────────────────────────────────────────────────

/** One selectable SURFACE for the overlay: its fill polygons and its outline. */
export interface FaceHighlightGroup {
  kind: FaceKind;
  suffix: string;
  /** Mean depth of the members — the overlay paints far surfaces first. */
  depth: number;
  /** Polygons to fill (the quad, or every visible triangle of the surface). */
  polygons: Array<ReadonlyArray<Pt>>;
  /** Edges to stroke: the boundary of the surface, not every triangle. */
  outline: Array<readonly [Pt, Pt]>;
}

/**
 * Faces grouped into the surfaces the overlay draws — one per quad on the
 * fallback path, one per KIND on the mesh path (every triangle of a kind is
 * one material, and highlights as one surface). A mesh surface's outline is
 * the edges its visible triangles use exactly once, i.e. its silhouette on
 * screen, so a glyph's walls read as walls rather than as a wireframe.
 */
export function faceHighlightGroups(faces: ReadonlyArray<PickedFace>): FaceHighlightGroup[] {
  const groups = new Map<string, FaceHighlightGroup & { n: number; edges: Map<string, { e: readonly [Pt, Pt]; n: number }> }>();
  let quadSerial = 0;
  for (const f of faces) {
    if (!isPickableFace(f)) continue;
    const key = f.verts ? `mesh:${f.suffix}` : `quad:${f.suffix}:${quadSerial++}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind: f.kind, suffix: f.suffix, depth: 0, polygons: [], outline: [], n: 0, edges: new Map() };
      groups.set(key, g);
    }
    g.depth += f.depth;
    g.n++;
    g.polygons.push(f.quad);
    const ids = f.verts;
    for (let i = 0; i < f.quad.length; i++) {
      const j = (i + 1) % f.quad.length;
      const a = f.quad[i]!;
      const b = f.quad[j]!;
      // Undirected edge identity by vertex index (mesh) or by position (quad).
      const ek = ids
        ? (ids[i]! < ids[j]! ? `${ids[i]}-${ids[j]}` : `${ids[j]}-${ids[i]}`)
        : `${i}`;
      const hit = g.edges.get(ek);
      if (hit) hit.n++;
      else g.edges.set(ek, { e: [a, b], n: 1 });
    }
  }
  const out: FaceHighlightGroup[] = [];
  for (const g of groups.values()) {
    for (const { e, n } of g.edges.values()) if (n === 1) g.outline.push(e);
    out.push({ kind: g.kind, suffix: g.suffix, depth: g.depth / Math.max(1, g.n), polygons: g.polygons, outline: g.outline });
  }
  return out;
}
