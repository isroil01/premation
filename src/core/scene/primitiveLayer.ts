/**
 * Parametric 3D primitives as ordinary MESH layers.
 *
 * A layer carrying a `Primitive` component is a real triangle mesh — the same
 * thing an imported glTF primitive is, by construction: this module hands
 * buildSnapshot a {@link ModelPrimitiveEntry}, so a sphere depth-sorts,
 * lights per fragment, takes Material Options, keyframes and gizmos through
 * exactly the code an imported model already goes through. Nothing new lands
 * in the renderer.
 *
 * WHY A COMPONENT, NOT GEOMETRY IN THE DOCUMENT. The mesh is a pure function
 * of a handful of numbers, so the document stores the numbers (type, radii,
 * height, segment counts) and this module generates — and caches — the mesh
 * per distinct parameter set. Changing a parameter mints a different cache
 * key, which is also the GPU-buffer key, so the buffers re-upload exactly when
 * the geometry actually changed and never otherwise. There is no hydration
 * step: unlike an imported .glb there is nothing to re-parse on open.
 *
 * BACKWARD COMPATIBILITY. Before real curved meshes existed, `insert3DPrimitive`
 * faked a sphere as an extruded ELLIPSE (a capsule) and a cylinder as 20 flat
 * strips. Those layers have no `Primitive` component, so they keep resolving
 * through the extrusion path and open exactly as they were saved. Only layers
 * created from now on — and only the curved kinds — are meshes.
 *
 * Cube and Plane deliberately stay on their existing paths: an extruded rect
 * is already a genuine box WITH bevels and per-face materials, which a plain
 * box mesh would lose, and a plane is a quad that can carry an image. `box`
 * exists here as a mesh type the Primitive section can switch to.
 */

import {
  sphereMesh,
  cylinderMesh,
  torusMesh,
  boxMesh,
  capsuleMesh,
  type PrimitiveGeometry,
} from '@core/geometry/primitiveMesh';
import { MESH_VERTEX_FLOATS } from '@core/geometry/extrudeMesh';
import type { ModelPrimitiveEntry } from './modelMesh';
import defaultSceneGraph from './DefaultSceneGraph';
import { writeTransformProps } from './transformWrite';
import { bumpScene } from '@stores/sceneStore';
import type { SceneNode } from '@core/types';

/** Component type carried by parametric-primitive layers. */
export const PRIMITIVE_COMPONENT = 'Primitive';

/** The kinds that resolve to a generated mesh. */
export const PRIMITIVE_MESH_TYPES = ['sphere', 'cylinder', 'cone', 'torus', 'capsule', 'box'] as const;
export type PrimitiveMeshType = (typeof PRIMITIVE_MESH_TYPES)[number];

/** Menu labels — the union above stays the source of truth. */
export const PRIMITIVE_LABELS: Record<PrimitiveMeshType, string> = {
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  torus: 'Torus',
  capsule: 'Capsule',
  box: 'Box',
};

export function isPrimitiveMeshType(v: unknown): v is PrimitiveMeshType {
  return typeof v === 'string' && (PRIMITIVE_MESH_TYPES as readonly string[]).includes(v);
}

/**
 * Every parameter, resolved. One flat shape rather than a per-type union: the
 * inspector shows the subset a type uses, and switching type keeps the values
 * the other type also has (a sphere→capsule swap keeps the radius) instead of
 * resetting the object.
 */
export interface PrimitiveSpec {
  type: PrimitiveMeshType;
  /** Sphere / capsule radius, cylinder + cone BOTTOM radius, torus ring radius. */
  radius: number;
  /** Cylinder TOP radius (a cone is a cylinder whose top radius is 0). */
  radiusTop: number;
  /** Cylinder + cone height; capsule TOTAL height (caps included); box height. */
  height: number;
  /** Box width. */
  width: number;
  /** Box depth. */
  depth: number;
  /** Torus tube radius. */
  tube: number;
  /** Segments AROUND the axis: sphere/cylinder/cone/capsule columns, torus ring. */
  radialSegments: number;
  /** Segments ALONG: sphere rows, capsule rows per cap, torus tube cross-section. */
  heightSegments: number;
  /** Cylinder / cone end caps. */
  capped: boolean;
}

/** Which fields a type actually consumes — drives the inspector's rows. */
export const PRIMITIVE_FIELDS: Record<PrimitiveMeshType, ReadonlyArray<keyof PrimitiveSpec>> = {
  sphere: ['radius', 'radialSegments', 'heightSegments'],
  cylinder: ['radius', 'radiusTop', 'height', 'radialSegments', 'capped'],
  cone: ['radius', 'height', 'radialSegments', 'capped'],
  torus: ['radius', 'tube', 'radialSegments', 'heightSegments'],
  capsule: ['radius', 'height', 'radialSegments', 'heightSegments'],
  box: ['width', 'height', 'depth'],
};

/** Defaults for a fresh primitive sized against `s` (the comp-scaled extent). */
export function defaultPrimitiveSpec(type: PrimitiveMeshType, s = 240): PrimitiveSpec {
  const base: PrimitiveSpec = {
    type,
    radius: s / 2,
    radiusTop: s / 2,
    height: s,
    width: s,
    depth: s,
    tube: s / 6,
    radialSegments: 32,
    heightSegments: 16,
    capped: true,
  };
  if (type === 'torus') return { ...base, radialSegments: 48, heightSegments: 16 };
  if (type === 'capsule') return { ...base, radius: s / 4, heightSegments: 8 };
  return base;
}

const clampNum = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;

/**
 * The node's primitive spec, or null when it is not a parametric primitive.
 * Absent props fall back to the type's defaults, so a document written by an
 * older build that only stored `type` still resolves to a whole object.
 */
export function readNodePrimitive(node: SceneNode): PrimitiveSpec | null {
  const c = node.components.find((k) => k.type === PRIMITIVE_COMPONENT);
  if (!c) return null;
  const p = c.props as Record<string, unknown>;
  if (!isPrimitiveMeshType(p.type)) return null;
  const d = defaultPrimitiveSpec(p.type);
  return {
    type: p.type,
    radius: clampNum(p.radius, 0.01, 100000, d.radius),
    radiusTop: clampNum(p.radiusTop, 0, 100000, d.radiusTop),
    height: clampNum(p.height, 0.01, 100000, d.height),
    width: clampNum(p.width, 0.01, 100000, d.width),
    depth: clampNum(p.depth, 0.01, 100000, d.depth),
    tube: clampNum(p.tube, 0.01, 100000, d.tube),
    radialSegments: Math.round(clampNum(p.radialSegments, 3, 256, d.radialSegments)),
    heightSegments: Math.round(clampNum(p.heightSegments, 2, 256, d.heightSegments)),
    capped: p.capped !== false,
  };
}

/** True when the layer's geometry comes from this module (not the extrusion). */
export function isPrimitiveMeshNode(node: SceneNode): boolean {
  return readNodePrimitive(node) !== null;
}

/** Cache identity — also the GPU buffer key, so it must cover every input. */
export function primitiveKey(spec: PrimitiveSpec): string {
  const n = (v: number): string => (Math.round(v * 1000) / 1000).toString();
  switch (spec.type) {
    case 'sphere':
      return `prim:sphere:${n(spec.radius)}:${spec.radialSegments}:${spec.heightSegments}`;
    case 'cylinder':
      return `prim:cyl:${n(spec.radiusTop)}:${n(spec.radius)}:${n(spec.height)}:${spec.radialSegments}:${spec.capped ? 1 : 0}`;
    case 'cone':
      return `prim:cone:${n(spec.radius)}:${n(spec.height)}:${spec.radialSegments}:${spec.capped ? 1 : 0}`;
    case 'torus':
      return `prim:torus:${n(spec.radius)}:${n(spec.tube)}:${spec.heightSegments}:${spec.radialSegments}`;
    case 'capsule':
      return `prim:capsule:${n(spec.radius)}:${n(spec.height)}:${spec.radialSegments}:${spec.heightSegments}`;
    case 'box':
      return `prim:box:${n(spec.width)}:${n(spec.height)}:${n(spec.depth)}`;
  }
}

/** Generate the surface for a spec. Pure. */
export function primitiveGeometry(spec: PrimitiveSpec): PrimitiveGeometry {
  switch (spec.type) {
    case 'sphere':
      return sphereMesh(spec.radius, spec.radialSegments, spec.heightSegments);
    case 'cylinder':
      return cylinderMesh(spec.radiusTop, spec.radius, spec.height, spec.radialSegments, spec.capped);
    case 'cone':
      return cylinderMesh(0, spec.radius, spec.height, spec.radialSegments, spec.capped);
    case 'torus':
      return torusMesh(spec.radius, spec.tube, spec.heightSegments, spec.radialSegments);
    case 'capsule':
      // The generator takes the CYLINDRICAL mid-section; the document stores
      // the total height, which is the number a user is actually setting.
      return capsuleMesh(spec.radius, Math.max(0, spec.height - 2 * spec.radius), spec.radialSegments, spec.heightSegments);
    case 'box':
      return boxMesh(spec.width, spec.height, spec.depth);
  }
}

/** Local-space extents — the layer's width/height are seeded from these. */
export function primitiveBounds(geo: PrimitiveGeometry): ModelPrimitiveEntry['bbox'] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < geo.positions.length; i += 3) {
    const x = geo.positions[i]!, y = geo.positions[i + 1]!, z = geo.positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return Number.isFinite(minX)
    ? { minX, minY, minZ, maxX, maxY, maxZ }
    : { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
}

/**
 * Cache of built meshes. Dragging a segment slider walks through dozens of
 * distinct keys in a second, so it is bounded: oldest-first eviction, which
 * for this access pattern is the same as least-recently-used because a key
 * that is still on screen is re-inserted on every frame it is missing.
 */
const MESH_CACHE_MAX = 64;
const meshCache = new Map<string, { vertices: Float32Array; indices: Uint32Array | Uint16Array; bbox: ModelPrimitiveEntry['bbox'] }>();

/** TEST SEAM: drop the built-mesh cache. */
export function clearPrimitiveMeshCache(): void {
  meshCache.clear();
}

function buildCached(spec: PrimitiveSpec): { vertices: Float32Array; indices: Uint32Array | Uint16Array; bbox: ModelPrimitiveEntry['bbox'] } {
  const key = primitiveKey(spec);
  const hit = meshCache.get(key);
  if (hit) return hit;
  const geo = primitiveGeometry(spec);
  const vcount = geo.positions.length / 3;
  // Interleave into the renderer's 8-float vertex (pos3 / nrm3 / uv2) — the
  // exact layout the extrusion and glTF paths already upload.
  const vertices = new Float32Array(vcount * MESH_VERTEX_FLOATS);
  for (let i = 0; i < vcount; i++) {
    const o = i * MESH_VERTEX_FLOATS;
    vertices[o] = geo.positions[i * 3]!;
    vertices[o + 1] = geo.positions[i * 3 + 1]!;
    vertices[o + 2] = geo.positions[i * 3 + 2]!;
    vertices[o + 3] = geo.normals[i * 3]!;
    vertices[o + 4] = geo.normals[i * 3 + 1]!;
    vertices[o + 5] = geo.normals[i * 3 + 2]!;
    vertices[o + 6] = geo.uvs[i * 2]!;
    vertices[o + 7] = geo.uvs[i * 2 + 1]!;
  }
  const built = {
    vertices,
    // 16-bit indices when they fit — half the upload for every default preset.
    indices: vcount <= 0xffff ? Uint16Array.from(geo.indices) : geo.indices,
    bbox: primitiveBounds(geo),
  };
  if (meshCache.size >= MESH_CACHE_MAX) {
    const oldest = meshCache.keys().next();
    if (!oldest.done) meshCache.delete(oldest.value);
  }
  meshCache.set(key, built);
  return built;
}

/** Default surface colour when the layer carries no fill of its own. */
export const PRIMITIVE_FALLBACK_FILL = '#3b8276';

/**
 * The renderer-ready entry for a primitive layer, or null when the node is not
 * one. Shaped as a {@link ModelPrimitiveEntry} so buildSnapshot's imported-mesh
 * branch consumes it unchanged — no skin, no morph targets, and the fill comes
 * from the LAYER (its colour picker), not from a baked-in material.
 */
export function primitiveEntryFor(node: SceneNode, fill?: string): ModelPrimitiveEntry | null {
  const spec = readNodePrimitive(node);
  if (!spec) return null;
  const built = buildCached(spec);
  // An open tube has an interior you can see, so it lights two-sided; every
  // closed solid stays one-sided (its own far wall is behind the depth test).
  const open = (spec.type === 'cylinder' || spec.type === 'cone') && !spec.capped;
  return {
    vertices: built.vertices,
    indices: built.indices,
    key: primitiveKey(spec),
    bbox: built.bbox,
    fill: fill ?? PRIMITIVE_FALLBACK_FILL,
    textureUrl: null,
    doubleSided: open,
    metallic: 0,
    roughness: 0.5,
    // No textures at all: a generated primitive has no material file behind
    // it, so every map slot is empty and the neutral factors apply. Material
    // Options on the layer is where its look is set.
    maps: { normal: null, metallicRoughness: null, occlusion: null, emissive: null },
    normalScale: 1,
    occlusionStrength: 1,
    emissive: [0, 0, 0],
    uvTransform: null,
    skinData: null,
    morphTargets: [],
    morphDefaults: [],
  };
}

// ── Writers (inspector + insert) ──────────────────────────────────────

/** The node's Primitive component id, or null. */
function primitiveComponentId(node: SceneNode): string | null {
  return node.components.find((c) => c.type === PRIMITIVE_COMPONENT)?.id ?? null;
}

/**
 * Write one parameter. Goes through `writeProp` (the undoable scene-graph
 * path), never a mutation of the components view, and re-seeds the layer box
 * so the gizmo keeps hugging the object it now is.
 */
export function setPrimitiveParam<K extends Exclude<keyof PrimitiveSpec, 'type'>>(
  nodeId: string,
  key: K,
  value: PrimitiveSpec[K],
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const cid = primitiveComponentId(node);
  if (!cid) return;
  defaultSceneGraph.writeProp(nodeId, cid, key, value);
  syncPrimitiveLayerBox(nodeId);
  bumpScene();
}

/** Switch the shape. Shared parameters carry over; the layer box re-fits. */
export function setPrimitiveType(nodeId: string, type: PrimitiveMeshType): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const cid = primitiveComponentId(node);
  if (!cid) return;
  defaultSceneGraph.writeProp(nodeId, cid, 'type', type);
  // `primitiveType` on the Transform is the legacy marker other code and the
  // timeline read; keep the two from disagreeing about what this layer is.
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) defaultSceneGraph.writeProp(nodeId, t.id, 'primitiveType', type);
  syncPrimitiveLayerBox(nodeId);
  bumpScene();
}

/**
 * Re-fit the layer's width/height to the mesh's own bounds.
 *
 * The quad never draws for a mesh layer, but width/height are still the
 * layer's BOX: selection, the anchor, snapping and the 3D gizmo all read it.
 * Leaving it at the size of whatever the primitive used to be put the handles
 * a long way from the object.
 */
export function syncPrimitiveLayerBox(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const spec = readNodePrimitive(node);
  if (!spec) return;
  const b = buildCached(spec).bbox;
  // Through the transform router, not writeProp: width/height are animatable,
  // and a raw write to a tracked property is silently discarded by the
  // renderer (see transformWrite.ts).
  writeTransformProps(nodeId, [
    { prop: 'width', value: Math.max(1, Math.round(b.maxX - b.minX)) },
    { prop: 'height', value: Math.max(1, Math.round(b.maxY - b.minY)) },
  ], 'Primitive size');
}

/** The component to push onto a NEW node (before it enters the graph). */
export function makePrimitiveComponent(nodeId: string, spec: PrimitiveSpec): { id: string; type: string; props: Record<string, unknown> } {
  return {
    id: `${nodeId}_prim`,
    type: PRIMITIVE_COMPONENT,
    props: { ...spec },
  };
}
