/**
 * Face picking for extruded 3D layers — which SIDE of an object is under the
 * pointer.
 *
 * Extrusion faces are synthetic: `buildSnapshot` derives them per frame and they
 * are not scene nodes, so the workspace hit-tester (which walks the scene graph)
 * cannot see them. Picking one therefore means re-deriving the same geometry and
 * testing it in screen space, which is what this module does — using the SAME
 * mesh (`extrusionMesh.ts`) + world matrix + projector the renderer uses, so
 * what you click is what you see.
 *
 * Two geometry sources, in order:
 *   • the extrusion MESH — the traced glyphs of a text layer, the flattened
 *     runs of a path shape, the rounded-rect / ellipse ring of a primitive.
 *     Every triangle becomes one `PickedFace` (a 3-point `quad`), tagged with
 *     its range role, so a click on a glyph's wall hits that wall and a click
 *     in the layer box beside the glyph hits nothing — exactly what is drawn;
 *   • the flat quads of `extrusion.ts` — the FALLBACK when no outline can be
 *     produced (headless, text before the canvas is ready), which is also the
 *     renderer's fallback.
 *
 * Pure: it takes a projector rather than reading the view itself, so it is
 * testable without a camera or a canvas.
 */

import { extrusionFaces, clampBevel } from '@core/scene/extrusion';
import { faceKindOf, type FaceKind } from '@core/scene/faceMaterials';
import { readNode3D } from '@core/scene/threeD';
import { readNodeKind } from '@core/scene/sceneDerive';
import { extrusionOutlineFor, extrusionMeshFor } from '@core/scene/extrusionMesh';
import { textPaintSpecFromNode } from '@core/scene/shapesFromText';
import { resolveCornerRadii, clampCornerRadii, type CornerRadiiProps } from '@core/scene/cornerRadii';
import { MESH_VERTEX_FLOATS } from '@core/geometry/extrudeMesh';
import { Matrix4Math, type Matrix4 } from '@motion/scene';
import { readGeometry } from '@core/workspace/geometry';
import { nodeWorld3d } from '@core/scene/nodeMatrix';
import { currentViewProjector } from '@core/workspace/viewProjection';
import type { RenderLayer } from '@core/rendering/RenderBackend';
import type { SceneNode } from '@core/types';

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

// ── The renderer's mesh, for a scene node ────────────────────────────────────

/**
 * The minimal RENDER LAYER `extrusionOutlineFor` needs to outline this node —
 * the same fields buildSnapshot fills, read from the same places, so the mesh
 * is the renderer's own (and comes out of its cache). Returns the box the
 * outline is framed in too: text is outlined in its MEASURED render box, which
 * is what the renderer extrudes, rather than the workspace's selection box.
 */
function pickingLayerFor(
  node: SceneNode,
  layerW: number,
  layerH: number,
  isEllipse: boolean,
): { layer: RenderLayer; w: number; h: number } | null {
  const kind = readNodeKind(node);
  if (kind === 'text') {
    const spec = textPaintSpecFromNode(node);
    if (!spec) return null;
    const { width, height, color: _color, ...fields } = spec;
    return {
      layer: { id: node.id, kind: 'text', ...fields } as unknown as RenderLayer,
      w: width,
      h: height,
    };
  }
  if (kind === 'shape') {
    const geom = node.components.find((c) => c.type === 'Geometry');
    const points = geom?.props.points as RenderLayer['pathPoints'] | undefined;
    const subpaths = geom?.props.subpaths as Array<{ points: NonNullable<RenderLayer['pathPoints']>; open?: boolean }> | undefined;
    if ((points && points.length > 0) || (subpaths && subpaths.length > 0)) {
      // Mirrors buildSnapshot: stored runs beat the single-run shorthand only
      // when there are several; a lone run is the shorthand.
      const runs = subpaths && subpaths.length > 1
        ? { subpaths: subpaths.map((r) => ({ points: r.points, open: r.open === true })) }
        : { pathPoints: points ?? subpaths?.[0]?.points, pathOpen: geom?.props.open === true || undefined };
      return { layer: { id: node.id, kind: 'shape', primitive: 'path', ...runs } as unknown as RenderLayer, w: layerW, h: layerH };
    }
    if (isEllipse) {
      return { layer: { id: node.id, kind: 'shape', primitive: 'ellipse' } as unknown as RenderLayer, w: layerW, h: layerH };
    }
    const corner: CornerRadiiProps = {};
    for (const c of node.components) {
      const p = c.props as Record<string, unknown>;
      for (const k of ['cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBR', 'cornerRadiusBL'] as const) {
        if (typeof p[k] === 'number' && Number.isFinite(p[k])) corner[k] = p[k] as number;
      }
    }
    const radii = clampCornerRadii(layerW, layerH, resolveCornerRadii(corner));
    const cornerRadius = radii.every((r) => r === radii[0]) ? radii[0] : undefined;
    return {
      layer: { id: node.id, kind: 'shape', primitive: 'rect', cornerRadius, cornerRadii: radii } as unknown as RenderLayer,
      w: layerW,
      h: layerH,
    };
  }
  // Rect-shaped content (image, video, precomp, …): the layer box.
  return { layer: { id: node.id, kind: 'image' } as unknown as RenderLayer, w: layerW, h: layerH };
}

/**
 * Every visible triangle of the renderer's extrusion mesh for `node`, projected
 * — or null when the mesh cannot be built (the caller falls back to the quads).
 */
function projectedMeshFaces(
  node: SceneNode,
  world3d: Matrix4,
  layerW: number,
  layerH: number,
  project: Projector,
  isEllipse: boolean,
  depth: number,
  bevel: number,
  bevelStyle: 'angular' | 'concave' | 'convex',
): PickedFace[] | null {
  const src = pickingLayerFor(node, layerW, layerH, isEllipse);
  if (!src) return null;
  const outline = extrusionOutlineFor(src.layer, node, src.w, src.h);
  if (!outline) return null;
  // `frontCap` is always requested: the renderer lets the layer's own quad
  // draw the front when it can, but for picking the cap must be the OUTLINE
  // (inset by the mesh's actual bevel), not the layer box — a click beside a
  // glyph on its front must miss. Same outline, depth and bevel as the drawn
  // mesh, so the caps and walls coincide with the pixels.
  const built = extrusionMeshFor(outline, src.w, src.h, { depth, bevel, bevelStyle, frontCap: true });
  if (!built) return null;
  const { mesh } = built;

  // Project every vertex once.
  const n = mesh.vertexCount;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pd = new Float64Array(n);
  const clipped = new Uint8Array(n);
  const v = mesh.vertices;
  for (let i = 0; i < n; i++) {
    const o = i * MESH_VERTEX_FLOATS;
    const p = project(Matrix4Math.transformPoint(world3d, { x: v[o]!, y: v[o + 1]!, z: v[o + 2]! }));
    px[i] = p.x;
    py[i] = p.y;
    pd[i] = p.depth;
    if (p.clipped) clipped[i] = 1;
  }

  const out: PickedFace[] = [];
  const idx = mesh.indices;
  for (const r of mesh.ranges) {
    const kind: FaceKind = r.role;
    for (let i = r.first; i < r.first + r.count; i += 3) {
      const a = idx[i]!;
      const b = idx[i + 1]!;
      const c = idx[i + 2]!;
      if (clipped[a] || clipped[b] || clipped[c]) continue;
      const quad = [{ x: px[a]!, y: py[a]! }, { x: px[b]!, y: py[b]! }, { x: px[c]!, y: py[c]! }];
      out.push({
        kind,
        suffix: r.role,
        quad,
        depth: (pd[a]! + pd[b]! + pd[c]!) / 3,
        area: signedPolygonArea(quad),
        verts: [a, b, c],
      });
    }
  }
  if (out.length === 0) return null;

  /*
    Back-face cull. The builder winds every triangle to agree with its
    outward normal, so after projection every camera-facing triangle has the
    SAME sign of signed area — which sign depends on the projector's
    handedness and any mirroring in the world matrix. Rather than reason
    about those, the rule is calibrated from the caps: whichever cap is
    nearer the camera is the one being looked at, and its winding is the
    "facing" one. Both caps edge-on (the object turned 90°) leaves nothing
    to calibrate from, and then nearest-wins alone is enough — the near wall
    is in front of the far one.
  */
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
    if (facing !== 0 && Math.sign(f.area) === -facing) continue;
    f.area = Math.abs(f.area);
    visible.push(f);
  }
  return visible;
}

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
 * The engine's world-space faces through a view's projector — the projection
 * half of `projectedFaces`, with the same back-face cull for mesh triangles
 * (calibrated from the caps) and the same edge-on rule for quads.
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
  // The mesh path's cull (projectedMeshFaces): the nearer cap's winding is the facing one.
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
  project: Projector,
  isEllipse = false,
): PickedFace[] {
  const d3 = readNode3D(node);
  const depth = d3.extrusionDepth;
  if (!(depth > 0) || !(layerW > 0) || !(layerH > 0)) return [];

  // The renderer's mesh, when it can be built (same request as buildSnapshot:
  // the node's bevel un-clamped — the mesh clamps it itself — and its style).
  const meshFaces = projectedMeshFaces(
    node, world3d, layerW, layerH, project, isEllipse,
    depth, Math.max(0, d3.bevelDepth), d3.bevelStyle,
  );
  if (meshFaces) return meshFaces;

  // Fallback: the flat quads of extrusion.ts — what the renderer draws when
  // it, too, has no outline.
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
