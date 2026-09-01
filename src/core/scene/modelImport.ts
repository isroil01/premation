/**
 * glTF import → scene layers.
 *
 * The mapping is deliberately boring: every glTF NODE becomes a 3D null
 * carrying that node's TRS (converted to compositor space), and every mesh
 * PRIMITIVE becomes a leaf layer under its node's null — a shape layer whose
 * fill is the material's base colour, or an image layer whose `src` is the
 * base colour texture. Leafs carry a `Model` component ({ modelKey, mesh,
 * prim }) that buildSnapshot resolves through the session mesh registry.
 * Boring is the point: the imported model is ORDINARY layers — parentable,
 * keyframeable with the existing gizmo (rotationX/rotationY/rotation), listed
 * in the timeline — rather than a special object with its own rules.
 *
 * Persistence: the source .glb rides as a data: URL on the imported ROOT's
 * Model component, inside the scene document itself. That is deliberately the
 * one storage every edition already saves and restores (cloud autosave, local
 * bundle, CLI render) — no new asset-registry kind, no new IO path. The cost
 * is document weight (~1.33× the .glb), which is why imports above the soft
 * cap warn. Geometry never lives in the document; it re-parses on open
 * (modelHydrate) into the session registry.
 *
 * Fit: models arrive in metres (a 2 m character would paint 2 px). The root
 * is scaled so the model's largest extent spans ~60% of the comp's short
 * side, positioned at the comp centre with the anchor on the bounding-box
 * centre — so the root's scale/rotation pivot is the model's own middle.
 */

import { parseGltf, type ParsedGltf } from '@core/media/gltf';
import {
  MODEL_COMPONENT,
  modelKeyForBytes,
  registerModel,
  modelPrimitiveFor,
  gltfRotationToEulerDeg,
  gltfTranslationToLocal,
} from './modelMesh';
import defaultSceneGraph from './DefaultSceneGraph';
import { activeCompRootId } from './activeComp';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { Matrix4Math, type Matrix4 } from '@motion/scene';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import type { SceneNode } from '@core/types';

/** Above this the data-URL document weight gets noticeable — warn, don't block. */
export const MODEL_SOFT_CAP_BYTES = 20 * 1024 * 1024;

const DEG = Math.PI / 180;
let seq = 0;
const freshId = (kind: string): string => `${kind}_model_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;

/** One layer to create. `parent` indexes into the same list (-1 = the root). */
export interface ModelLayerSpec {
  parent: number;
  name: string;
  kind: 'null' | 'shape' | 'image';
  /** Transform component props (kind marker included). */
  props: Record<string, unknown>;
  /** Style props (leafs only). */
  style?: Record<string, unknown>;
  /** Model reference (leafs only). */
  model?: { mesh: number; prim: number };
}

export interface ModelLayout {
  /** Root transform: fit scale + comp-centre placement, anchor on bbox centre. */
  rootProps: Record<string, unknown>;
  specs: ModelLayerSpec[];
  fitScale: number;
}

/** Compose a glTF node's CONVERTED local matrix (radians for compose). */
function localMatrixOf(node: { t: [number, number, number]; r: [number, number, number, number]; s: [number, number, number] }): Matrix4 {
  const t = gltfTranslationToLocal(node.t);
  const e = gltfRotationToEulerDeg(node.r);
  return Matrix4Math.compose({
    position: { x: t.x, y: t.y, z: t.z },
    rotation: { x: e.x * DEG, y: e.y * DEG, z: e.z * DEG },
    scale: { x: node.s[0], y: node.s[1], z: node.s[2] },
    anchor: { x: 0, y: 0, z: 0 },
  });
}

/**
 * Build the layer tree + fit transform for a parsed model. Pure — the glue
 * below feeds it to the scene graph; tests feed it fixtures.
 */
export function buildModelLayout(
  parsed: ParsedGltf,
  modelKey: string,
  comp: { width: number; height: number },
): ModelLayout {
  const specs: ModelLayerSpec[] = [];

  // World bbox of every primitive, in converted model space (for the fit).
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const growWorldBox = (world: Matrix4, ref: { mesh: number; prim: number }): void => {
    const entry = modelPrimitiveFor({ modelKey, mesh: ref.mesh, prim: ref.prim });
    if (!entry) return;
    const b = entry.bbox;
    for (const cx of [b.minX, b.maxX]) for (const cy of [b.minY, b.maxY]) for (const cz of [b.minZ, b.maxZ]) {
      const p = Matrix4Math.transformPoint(world, { x: cx, y: cy, z: cz });
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
  };

  const visit = (nodeIndex: number, parentSpec: number, parentWorld: Matrix4, depth: number): void => {
    if (depth > 64) return; // cycles are invalid glTF; refuse to hang on one
    const n = parsed.nodes[nodeIndex];
    if (!n) return;
    const t = gltfTranslationToLocal(n.t);
    const e = gltfRotationToEulerDeg(n.r);
    const world = Matrix4Math.multiply(parentWorld, localMatrixOf(n));
    const nodeSpec: ModelLayerSpec = {
      parent: parentSpec,
      name: n.name,
      kind: 'null',
      props: {
        [SCENE_KIND_PROP]: 'null',
        x: t.x,
        y: t.y,
        z: t.z,
        rotationX: e.x,
        rotationY: e.y,
        rotation: e.z,
        scaleX: n.s[0],
        scaleY: n.s[1],
        scaleZ: n.s[2],
        anchorX: 0,
        anchorY: 0,
        width: 20,
        height: 20,
      },
    };
    specs.push(nodeSpec);
    const mySpec = specs.length - 1;

    if (n.mesh !== null) {
      const mesh = parsed.meshes[n.mesh];
      mesh?.primitives.forEach((_p, pi) => {
        const ref = { mesh: n.mesh!, prim: pi };
        const entry = modelPrimitiveFor({ modelKey, ...ref });
        growWorldBox(world, ref);
        const b = entry?.bbox;
        specs.push({
          parent: mySpec,
          name: mesh.primitives.length > 1 ? `${mesh.name} ${pi + 1}` : mesh.name,
          kind: entry?.textureUrl ? 'image' : 'shape',
          props: {
            [SCENE_KIND_PROP]: entry?.textureUrl ? 'image' : 'shape',
            x: 0,
            y: 0,
            z: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            anchorX: 0,
            anchorY: 0,
            width: b ? Math.max(1, b.maxX - b.minX) : 100,
            height: b ? Math.max(1, b.maxY - b.minY) : 100,
            ...(entry?.textureUrl ? { src: entry.textureUrl } : {}),
          },
          style: { opacity: 100, ...(entry && !entry.textureUrl ? { fill: entry.fill } : {}) },
          model: ref,
        });
      });
    }
    for (const c of n.children) visit(c, mySpec, world, depth + 1);
  };

  for (const r of parsed.roots) visit(r, -1, Matrix4Math.identity(), 0);

  const spanX = Number.isFinite(minX) ? maxX - minX : 0;
  const spanY = Number.isFinite(minY) ? maxY - minY : 0;
  const spanZ = Number.isFinite(minZ) ? maxZ - minZ : 0;
  const largest = Math.max(spanX, spanY, spanZ);
  const shortSide = Math.min(comp.width, comp.height);
  const fitScale = largest > 1e-6 ? (0.6 * shortSide) / largest : 1;
  const center = Number.isFinite(minX)
    ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }
    : { x: 0, y: 0, z: 0 };

  const rootProps: Record<string, unknown> = {
    [SCENE_KIND_PROP]: 'null',
    // Centre by POSITION, not by anchor: anchor x/y deliberately never enter
    // the 3D matrix chain (affineAt composes only anchorZ; x/y are a
    // quad-draw-time offset the MESH path never applies), so an anchor-based
    // centring left the model floating a bbox-half away from its own gizmo —
    // seen live on the first import. Offsetting the position is consumed by
    // every path identically.
    x: comp.width / 2 - center.x * fitScale,
    y: comp.height / 2 - center.y * fitScale,
    z: -center.z * fitScale,
    rotationX: 0,
    rotationY: 0,
    rotation: 0,
    scaleX: fitScale,
    scaleY: fitScale,
    scaleZ: fitScale,
    anchorX: 0,
    anchorY: 0,
    width: 20,
    height: 20,
  };

  return { rootProps, specs, fitScale };
}

/** Chunked base64 — String.fromCharCode(...bigArray) blows the call stack. */
export function bytesToDataUrl(bytes: Uint8Array, mime = 'model/gltf-binary'): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

export interface ModelImportResult {
  rootId: string;
  layerCount: number;
  warning: string | null;
}

/**
 * Import a .glb/.gltf into the ACTIVE composition. Registers meshes, creates
 * the layer tree, selects the root. Throws with an actionable message on a
 * file the parser refuses (external .bin, glTF 1.0, …).
 */
export function importGltfModel(bytes: ArrayBuffer, fileName: string): ModelImportResult {
  const u8 = new Uint8Array(bytes);
  const modelKey = modelKeyForBytes(u8);
  registerModel(modelKey, bytes);
  const parsed: ParsedGltf = parseGltf(bytes);

  const comp = useCompositionStore.getState();
  const layout = buildModelLayout(parsed, modelKey, { width: comp.width, height: comp.height });

  const rootId = freshId('null');
  const baseName = fileName.replace(/\.(glb|gltf)$/i, '') || '3D Model';
  const root: SceneNode = {
    id: rootId,
    name: baseName,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: comp.width / 2, y: comp.height / 2 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${rootId}_t`, type: 'Transform', props: layout.rootProps },
      {
        id: `${rootId}_model`,
        type: MODEL_COMPONENT,
        props: { modelKey, glbData: bytesToDataUrl(u8) },
      },
    ],
  } as unknown as SceneNode;
  defaultSceneGraph.addChild(activeCompRootId(), root);

  const idsBySpec: string[] = [];
  layout.specs.forEach((spec) => {
    const id = freshId(spec.kind);
    const components: SceneNode['components'] = [
      { id: `${id}_t`, type: 'Transform', props: { ...spec.props } },
    ];
    if (spec.style) components.push({ id: `${id}_s`, type: 'Style', props: { ...spec.style } });
    if (spec.model) {
      components.push({
        id: `${id}_model`,
        type: MODEL_COMPONENT,
        props: { modelKey, mesh: spec.model.mesh, prim: spec.model.prim },
      });
    }
    const node: SceneNode = {
      id,
      name: spec.name,
      parent: null,
      children: [],
      visible: true,
      locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components,
    } as unknown as SceneNode;
    const parentId = spec.parent === -1 ? rootId : idsBySpec[spec.parent]!;
    defaultSceneGraph.addChild(parentId, node);
    idsBySpec.push(id);
  });

  useSelectionStore.getState().set([rootId]);
  bumpScene();

  return {
    rootId,
    layerCount: layout.specs.length + 1,
    warning: u8.length > MODEL_SOFT_CAP_BYTES
      ? `“${fileName}” is ${(u8.length / (1024 * 1024)).toFixed(1)} MB — it is stored inside the project, so saves and autosaves will be heavier.`
      : null,
  };
}
