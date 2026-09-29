/**
 * Face picking's geometry from the ENGINE (B4 round 8): `getLayerFaces` answers
 * an extruded 3D layer's faces — the renderer's own extrusion mesh (front cap
 * included) or its flat-quad fallback — in world px; the viewport projects them
 * through the view it shows (`projectWorldFaces`, the view camera of the push).
 *
 *   • `layerFacesNow(layer, time)` — this mirror revision's answer for the
 *     frame, else undefined (and the fetch starts); `onLayerFaces` hears it land.
 *   • `fetchLayerFaces(layer, time)` — a callback's exact answer.
 *
 * The view (which camera, a custom / axis view) is editor state and stays in
 * the UI; the geometry is the document's and comes from the engine.
 */

import { secondsToFlicks, type LayerFace } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { projectWorldFaces, type PickedFace, type WorldFace } from '@core/scene/facePicking';
import type { FaceKind } from '@core/scene/faceMaterials';
import { projectorOf, viewCameraOf } from '@core/mirror/viewGeometry';
import { documentMirror } from '@stores/documentMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { MAIN_VIEWPORT, overlayView } from '@stores/overlayGeometry';

interface Entry {
  key: string;
  faces: readonly WorldFace[];
}

const entries = new Map<string, Entry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

const keyOf = (layer: string, at: number): string => `${layer}@${at}@${documentMirror().revision}`;

function toWorld(f: LayerFace): WorldFace {
  return {
    kind: f.kind as FaceKind,
    suffix: f.suffix,
    points: f.points,
    ...(f.verts.length === 3 ? { verts: [f.verts[0]!, f.verts[1]!, f.verts[2]!] as const } : {}),
  };
}

/** The layer's world faces at comp `time` (seconds), asked of the engine now. Empty for a layer with none. */
export async function fetchLayerFaces(layer: string, time: number): Promise<readonly WorldFace[]> {
  const at = secondsToFlicks(time);
  const key = keyOf(layer, at);
  const hit = entries.get(layer);
  if (hit?.key === key) return hit.faces;
  const res = await engine().query({ type: 'getLayerFaces', layer, time: at });
  const faces = res.ok ? res.value.faces.map(toWorld) : [];
  if (entries.size > 64) entries.clear();
  entries.set(layer, { key, faces });
  for (const l of listeners) l();
  return faces;
}

/** This revision's faces of `layer` at `time`, or undefined while the answer is in flight. */
export function layerFacesNow(layer: string, time: number): readonly WorldFace[] | undefined {
  const key = keyOf(layer, secondsToFlicks(time));
  const hit = entries.get(layer);
  if (hit?.key === key) return hit.faces;
  if (!inFlight.has(key)) {
    inFlight.add(key);
    void fetchLayerFaces(layer, time).finally(() => inFlight.delete(key));
  }
  return undefined;
}

/** Hear an answer land (the overlay repaints). */
export function onLayerFaces(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** World faces through the main viewport's view (its camera as the push resolved it, or a custom / axis view). */
export function projectFacesForView(faces: readonly WorldFace[], time: number, compW: number, compH: number): PickedFace[] {
  if (faces.length === 0) return [];
  const g = useGuidesStore.getState();
  const mode = g.camera3dMode;
  const camera = viewCameraOf(mode, overlayView(MAIN_VIEWPORT, 'active', secondsToFlicks(time)), g.customViews, compW, compH);
  return projectWorldFaces(faces, projectorOf(mode, camera, compW, compH));
}
