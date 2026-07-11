/**
 * Track — an ordered lane of {@link Layer}s. Tracks carry the visibility/lock/
 * mute/solo flags editors expect, an optional group membership, a kind tag
 * (video/audio/shape/…), and free-form metadata. Layer order within a track is
 * its stacking order; the array index is the order.
 *
 * Structural edits that must stay undoable (add/remove/move layers across
 * tracks) are driven by the Timeline; this class owns only its own contents.
 */

import { Layer, type LayerData } from '../layers/Layer';
import { MarkerList } from '../markers/MarkerList';
import type { MarkerData } from '../markers/Marker';
import { uid } from '../utils/id';

export type TrackKind = 'video' | 'audio' | 'shape' | 'text' | 'group' | 'adjustment' | 'generic';

export interface TrackFlags {
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  solo: boolean;
}

export interface TrackData {
  id: string;
  name: string;
  kind: TrackKind;
  layers: LayerData[];
  flags: TrackFlags;
  /** Height hint for the UI (px); pure metadata to the engine. */
  height: number;
  /** Group this track belongs to, or null. */
  groupId: string | null;
  markers: MarkerData[];
  metadata: Record<string, unknown>;
}

export interface TrackInit {
  name?: string;
  kind?: TrackKind;
  flags?: Partial<TrackFlags>;
  height?: number;
  groupId?: string | null;
  metadata?: Record<string, unknown>;
  id?: string;
}

export class Track {
  readonly id: string;
  name: string;
  kind: TrackKind;
  readonly layers: Layer[] = [];
  flags: TrackFlags;
  height: number;
  groupId: string | null;
  readonly markers = new MarkerList();
  metadata: Record<string, unknown>;

  constructor(init: TrackInit = {}) {
    this.id = init.id ?? uid('track');
    this.name = init.name ?? 'Track';
    this.kind = init.kind ?? 'generic';
    this.flags = {
      locked: init.flags?.locked ?? false,
      hidden: init.flags?.hidden ?? false,
      muted: init.flags?.muted ?? false,
      solo: init.flags?.solo ?? false,
    };
    this.height = init.height ?? 28;
    this.groupId = init.groupId ?? null;
    this.metadata = init.metadata ?? {};
  }

  get layerCount(): number {
    return this.layers.length;
  }

  indexOfLayer(id: string): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  getLayer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  /** Insert a layer at `index` (default: end). */
  insertLayer(layer: Layer, index = this.layers.length): void {
    layer.trackId = this.id;
    const at = Math.max(0, Math.min(index, this.layers.length));
    this.layers.splice(at, 0, layer);
  }

  removeLayer(id: string): Layer | null {
    const idx = this.indexOfLayer(id);
    if (idx < 0) return null;
    return this.layers.splice(idx, 1)[0] ?? null;
  }

  /** Reorder a layer within this track. Returns false if not found. */
  reorderLayer(id: string, toIndex: number): boolean {
    const from = this.indexOfLayer(id);
    if (from < 0) return false;
    const [layer] = this.layers.splice(from, 1);
    const at = Math.max(0, Math.min(toIndex, this.layers.length));
    this.layers.splice(at, 0, layer!);
    return true;
  }

  /** Enabled + unmuted + within-span layers at a frame (respects hidden). */
  layersAt(frame: number): Layer[] {
    if (this.flags.hidden || this.flags.muted) return [];
    return this.layers.filter((l) => l.isActiveAt(frame));
  }

  /** The furthest frame reached by any layer on this track. */
  contentEnd(): number {
    let max = 0;
    for (const l of this.layers) max = Math.max(max, l.end);
    return max;
  }

  toJSON(): TrackData {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      layers: this.layers.map((l) => l.toJSON()),
      flags: { ...this.flags },
      height: this.height,
      groupId: this.groupId,
      markers: this.markers.toJSON(),
      metadata: this.metadata,
    };
  }

  static fromJSON(data: TrackData): Track {
    const track = new Track({
      id: data.id,
      name: data.name,
      kind: data.kind,
      flags: data.flags,
      height: data.height,
      groupId: data.groupId,
      metadata: data.metadata,
    });
    for (const l of data.layers) track.layers.push(Layer.fromJSON(l));
    for (const m of MarkerList.fromJSON(data.markers).list()) track.markers.add(m);
    return track;
  }
}
