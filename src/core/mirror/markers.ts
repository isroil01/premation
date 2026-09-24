/**
 * Composition and layer MARKERS over the document MIRROR (B4) — the twin of
 * `TimelineController.getMarkerById` and the lookups the marker edits need.
 * Pure: it takes a mirror reader and never touches the engine.
 *
 * A comp marker's `time` is comp time; a LAYER marker's is LAYER time, anchored
 * at the layer's in point (the lanes draw it at `inPoint + time` — see
 * `timelineTracks.ts` `markerView`). Both are flicks.
 */

import { flicksToSeconds, type LayerInfo, type Marker } from '@motion/engine-api';

/** What the lookup reads. `DocumentMirror` is one. */
export interface MirrorMarkerRead {
  comp(id: string): { readonly layers: readonly string[]; readonly markers: readonly Marker[] } | undefined;
  layer(id: string): LayerInfo | undefined;
}

export interface FoundMarker {
  marker: Marker;
  /** The layer owning it (a layer marker), undefined for a comp marker. */
  layer?: LayerInfo;
}

/** A marker of composition `compId` (its own, or one of its layers') by id. */
export function mirrorMarkerById(m: MirrorMarkerRead, compId: string | undefined, id: string): FoundMarker | undefined {
  const comp = compId ? m.comp(compId) : undefined;
  if (!comp) return undefined;
  const own = comp.markers.find((mk) => mk.id === id);
  if (own) return { marker: own };
  for (const lid of comp.layers) {
    const layer = m.layer(lid);
    const mk = layer?.markers.find((x) => x.id === id);
    if (mk && layer) return { marker: mk, layer };
  }
  return undefined;
}

/** A marker as the marker editor shows it (seconds; comp time for a layer marker too — the twin of `TimelineMarkerView`). */
export interface MarkerView {
  id: string;
  time: number;
  label: string;
  color: string | null;
  comment: string;
  duration: number;
  scope: 'comp' | 'layer';
}

export function markerViewOf(found: FoundMarker): MarkerView {
  const { marker, layer } = found;
  const offset = layer ? layer.timing.inPoint : 0;
  return {
    id: marker.id,
    time: flicksToSeconds(marker.time + offset),
    label: marker.name || 'Marker',
    color: marker.color || null,
    comment: marker.comment,
    duration: flicksToSeconds(marker.duration),
    scope: layer ? 'layer' : 'comp',
  };
}
