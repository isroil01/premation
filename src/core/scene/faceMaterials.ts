/**
 * Per-face materials for extruded 3D layers.
 *
 * Extruded geometry used to take ONE colour for everything: the walls and back
 * cap were the layer's own fill scaled by two hardcoded constants
 * (EXTRUSION_WALL_GAIN 0.72 / EXTRUSION_BACK_GAIN 0.55), so extruded text always
 * had flat same-coloured sides and there was no way to give an object, say, a
 * white face with gold edges.
 *
 * The axis is FACE KIND, not individual face — which is both what After Effects'
 * Cinema 4D renderer exposes (Front / Side / Bevel material) and the only usable
 * UI: a segmented cylinder emits twenty wall quads, and twenty colour pickers
 * would be unusable. `faceKindOf` maps the renderer's face suffixes onto the four
 * kinds.
 *
 * Defaults reproduce the previous output EXACTLY (same gains, same derived fill),
 * so an existing scene renders byte-identically until a face is given its own
 * colour.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import type { SceneNode } from '@core/types';
import { EXTRUSION_WALL_GAIN, EXTRUSION_BACK_GAIN } from '@core/scene/extrusion';

/** The four addressable surfaces of an extruded object. */
export type FaceKind = 'front' | 'side' | 'bevel' | 'back';

export interface FaceMaterial {
  /** Explicit colour. Absent = derive from the layer fill × `gain` (as before). */
  fill?: string;
  /**
   * Brightness multiplier applied when no explicit fill is set, and when the
   * layer does not accept lights. This is the knob the old hardcoded constants
   * were; exposing it lets you deepen or flatten the sides without picking a
   * colour that then stops tracking the layer's own.
   */
  gain?: number;
}

/** Only the non-front kinds are stored — the front face IS the layer's own fill. */
export type FaceMaterials = Partial<Record<Exclude<FaceKind, 'front'>, FaceMaterial>>;

/** Default gain per kind — the constants the renderer used to hardcode. */
export const DEFAULT_FACE_GAIN: Record<Exclude<FaceKind, 'front'>, number> = {
  side: EXTRUSION_WALL_GAIN,
  bevel: EXTRUSION_WALL_GAIN,
  back: EXTRUSION_BACK_GAIN,
};

/**
 * Which surface a renderer face belongs to.
 *
 * Bevel chamfers are emitted with role 'wall' and a suffix starting `c`
 * (`cfr`/`cfl`/… front ring, `cbr`/… back ring), so the suffix — not the role —
 * is what separates a bevel from a side wall.
 */
export function faceKindOf(role: 'back' | 'wall', suffix: string): Exclude<FaceKind, 'front'> {
  if (role === 'back') return 'back';
  return suffix.startsWith('c') ? 'bevel' : 'side';
}

function transformProps(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === 'Transform') as
    | { id: string; props: Record<string, unknown> }
    | undefined;
}

export function readNodeFaceMaterials(node: SceneNode): FaceMaterials {
  const t = transformProps(node);
  const raw = t?.props.faceMaterials;
  if (!raw || typeof raw !== 'object') return {};
  return raw as FaceMaterials;
}

export function getNodeFaceMaterials(nodeId: string): FaceMaterials {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeFaceMaterials(node) : {};
}

/**
 * The colour and gain a given face should draw with.
 *
 * `layerFill` is the layer's own fill (the front face colour). With no explicit
 * per-face fill the result is the previous behaviour: the layer colour, dimmed by
 * the kind's gain.
 */
export function resolveFaceMaterial(
  materials: FaceMaterials,
  kind: Exclude<FaceKind, 'front'>,
  layerFill: string,
): { fill: string; gain: number } {
  const m = materials[kind];
  const gain = typeof m?.gain === 'number' ? m.gain : DEFAULT_FACE_GAIN[kind];
  return { fill: m?.fill ?? layerFill, gain };
}

/** Patch one face kind. Passing `{}` for a kind clears it back to the default. */
export function setNodeFaceMaterial(
  nodeId: string,
  kind: Exclude<FaceKind, 'front'>,
  patch: FaceMaterial | null,
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformProps(node) : undefined;
  if (!node || !t) return;
  const cur = readNodeFaceMaterials(node);
  const next: FaceMaterials = { ...cur };
  if (patch === null) delete next[kind];
  else next[kind] = { ...cur[kind], ...patch };
  // Store nothing when every kind is default, so an untouched layer adds no
  // bytes to the file and keeps rendering through the original path.
  const empty = Object.keys(next).length === 0;
  defaultSceneGraph.writeProp(nodeId, t.id, 'faceMaterials', empty ? undefined : next);
  bumpScene();
}

/** Drop all per-face overrides (back to one colour for the whole object). */
export function clearNodeFaceMaterials(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformProps(node) : undefined;
  if (!node || !t) return;
  defaultSceneGraph.writeProp(nodeId, t.id, 'faceMaterials', undefined);
  bumpScene();
}
