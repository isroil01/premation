/**
 * Marker — a named, colored point (or span) in time. Markers exist at three
 * scopes: on the whole timeline/composition, on a track, or on a layer (where
 * the time is relative to the layer's start). Comments make them useful for
 * review notes and chapter points.
 */

import { uid } from '../utils/id';

export type MarkerScope = 'timeline' | 'composition' | 'track' | 'layer';

export interface MarkerData {
  id: string;
  /** Frame position (layer-relative for layer markers). */
  frame: number;
  /** Optional span length in frames (0 = point marker). */
  duration: number;
  name: string;
  color: string | null;
  comment: string;
  scope: MarkerScope;
  /** Owning track/layer id for scoped markers; null for timeline/composition. */
  ownerId: string | null;
  /** AE marker extras (engine API `Marker`), written only when set. */
  chapter?: string;
  url?: string;
  cuePoint?: string;
  protectedRegion?: boolean;
}

export interface MarkerInit {
  frame: number;
  duration?: number;
  name?: string;
  color?: string | null;
  comment?: string;
  scope?: MarkerScope;
  ownerId?: string | null;
  id?: string;
  chapter?: string;
  url?: string;
  cuePoint?: string;
  protectedRegion?: boolean;
}

export class Marker {
  readonly id: string;
  frame: number;
  duration: number;
  name: string;
  color: string | null;
  comment: string;
  scope: MarkerScope;
  ownerId: string | null;
  chapter: string;
  url: string;
  cuePoint: string;
  protectedRegion: boolean;

  constructor(init: MarkerInit) {
    this.id = init.id ?? uid('marker');
    this.frame = init.frame;
    this.duration = Math.max(0, init.duration ?? 0);
    this.name = init.name ?? '';
    this.color = init.color ?? null;
    this.comment = init.comment ?? '';
    this.scope = init.scope ?? 'timeline';
    this.ownerId = init.ownerId ?? null;
    this.chapter = init.chapter ?? '';
    this.url = init.url ?? '';
    this.cuePoint = init.cuePoint ?? '';
    this.protectedRegion = init.protectedRegion === true;
  }

  get end(): number {
    return this.frame + this.duration;
  }

  toJSON(): MarkerData {
    return {
      id: this.id,
      frame: this.frame,
      duration: this.duration,
      name: this.name,
      color: this.color,
      comment: this.comment,
      scope: this.scope,
      ownerId: this.ownerId,
      // Absent when unset, so every marker written before these existed (and
      // every one that never uses them) serializes exactly as before.
      ...(this.chapter ? { chapter: this.chapter } : {}),
      ...(this.url ? { url: this.url } : {}),
      ...(this.cuePoint ? { cuePoint: this.cuePoint } : {}),
      ...(this.protectedRegion ? { protectedRegion: true } : {}),
    };
  }

  static fromJSON(data: MarkerData): Marker {
    return new Marker(data);
  }
}
