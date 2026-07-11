/**
 * Layer — a named entity on a track that occupies a span of time (its
 * {@link Clip}) and usually references a Scene Graph node via `sourceId`. Layers
 * are the timeline's primary editable unit: they trim, split, move between
 * tracks, and carry their own markers and metadata. This class is pure data +
 * geometry; structural changes (adding to a track, undo) are orchestrated by the
 * Timeline.
 */

import { Clip, type ClipData } from '../clips/Clip';
import { MarkerList } from '../markers/MarkerList';
import { Marker, type MarkerData } from '../markers/Marker';
import { uid } from '../utils/id';

export interface LayerData {
  id: string;
  name: string;
  trackId: string;
  clip: ClipData;
  enabled: boolean;
  locked: boolean;
  /** Scene Graph node this layer animates, if any. */
  sourceId: string | null;
  markers: MarkerData[];
  metadata: Record<string, unknown>;
}

export interface LayerInit {
  name?: string;
  trackId: string;
  clip?: Clip | Partial<ClipData>;
  enabled?: boolean;
  locked?: boolean;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  id?: string;
}

export class Layer {
  readonly id: string;
  name: string;
  trackId: string;
  clip: Clip;
  enabled: boolean;
  locked: boolean;
  sourceId: string | null;
  readonly markers = new MarkerList();
  metadata: Record<string, unknown>;

  constructor(init: LayerInit) {
    this.id = init.id ?? uid('layer');
    this.name = init.name ?? 'Layer';
    this.trackId = init.trackId;
    this.clip = init.clip instanceof Clip ? init.clip : new Clip(init.clip ?? {});
    this.enabled = init.enabled ?? true;
    this.locked = init.locked ?? false;
    this.sourceId = init.sourceId ?? null;
    this.metadata = init.metadata ?? {};
  }

  get start(): number {
    return this.clip.start;
  }
  get end(): number {
    return this.clip.end;
  }
  get duration(): number {
    return this.clip.duration;
  }

  contains(frame: number): boolean {
    return this.clip.contains(frame);
  }

  /** True when this layer contributes at `frame` (active + enabled). */
  isActiveAt(frame: number): boolean {
    return this.enabled && this.clip.contains(frame);
  }

  /**
   * Split this layer at a timeline frame. Mutates this layer to be the left part
   * and returns a fresh right-hand Layer (new id), or null if not splittable.
   */
  split(frame: number): Layer | null {
    if (this.locked) return null;
    const rightClip = this.clip.split(frame);
    if (!rightClip) return null;
    return new Layer({
      name: this.name,
      trackId: this.trackId,
      clip: new Clip(rightClip),
      enabled: this.enabled,
      locked: this.locked,
      sourceId: this.sourceId,
      metadata: { ...this.metadata },
    });
  }

  /** Deep clone with a fresh id (for duplicate). Markers get fresh ids too. */
  clone(): Layer {
    const copy = new Layer({
      name: this.name,
      trackId: this.trackId,
      clip: this.clip.clone(),
      enabled: this.enabled,
      locked: this.locked,
      sourceId: this.sourceId,
      metadata: { ...this.metadata },
    });
    for (const m of this.markers.list()) {
      copy.markers.add(
        new Marker({
          frame: m.frame,
          duration: m.duration,
          name: m.name,
          color: m.color,
          comment: m.comment,
          scope: m.scope,
          ownerId: copy.id,
        }),
      );
    }
    return copy;
  }

  toJSON(): LayerData {
    return {
      id: this.id,
      name: this.name,
      trackId: this.trackId,
      clip: this.clip.toJSON(),
      enabled: this.enabled,
      locked: this.locked,
      sourceId: this.sourceId,
      markers: this.markers.toJSON(),
      metadata: this.metadata,
    };
  }

  static fromJSON(data: LayerData): Layer {
    const layer = new Layer({
      id: data.id,
      name: data.name,
      trackId: data.trackId,
      clip: Clip.fromJSON(data.clip),
      enabled: data.enabled,
      locked: data.locked,
      sourceId: data.sourceId,
      metadata: data.metadata,
    });
    for (const m of MarkerList.fromJSON(data.markers).list()) layer.markers.add(m);
    return layer;
  }
}
