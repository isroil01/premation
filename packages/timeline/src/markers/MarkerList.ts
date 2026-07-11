/**
 * MarkerList — an ordered collection of markers kept sorted by frame so lookups
 * ("marker at", "markers in range", "next/previous marker") are O(log n). Shared
 * by the timeline and by each track/layer for their own markers.
 */

import { Marker, type MarkerData } from './Marker';
import { lowerBound, upperBound, insertSorted } from '../utils/search';

const byFrame = (m: Marker): number => m.frame;

export class MarkerList {
  private readonly markers: Marker[] = [];
  private readonly index = new Map<string, Marker>();

  get size(): number {
    return this.markers.length;
  }

  list(): readonly Marker[] {
    return this.markers;
  }

  get(id: string): Marker | undefined {
    return this.index.get(id);
  }

  add(marker: Marker): Marker {
    insertSorted(this.markers, marker, byFrame);
    this.index.set(marker.id, marker);
    return marker;
  }

  remove(id: string): boolean {
    const marker = this.index.get(id);
    if (!marker) return false;
    const idx = this.markers.indexOf(marker);
    if (idx >= 0) this.markers.splice(idx, 1);
    this.index.delete(id);
    return true;
  }

  clear(): void {
    this.markers.length = 0;
    this.index.clear();
  }

  /** Re-sort after a marker's frame was mutated in place. */
  reindex(): void {
    this.markers.sort((a, b) => a.frame - b.frame);
  }

  /** The marker exactly at (or spanning) a frame, nearest one first. */
  at(frame: number): Marker | undefined {
    for (const m of this.markers) {
      if (frame >= m.frame && frame <= m.end) return m;
    }
    return undefined;
  }

  /** Markers whose point/span intersects [from, to]. */
  inRange(from: number, to: number): Marker[] {
    const out: Marker[] = [];
    for (const m of this.markers) {
      if (m.frame <= to && m.end >= from) out.push(m);
    }
    return out;
  }

  /** First marker strictly after `frame`, or null. */
  next(frame: number): Marker | null {
    const idx = upperBound(this.markers, frame, byFrame);
    return this.markers[idx] ?? null;
  }

  /** Last marker strictly before `frame`, or null. */
  previous(frame: number): Marker | null {
    const idx = lowerBound(this.markers, frame, byFrame) - 1;
    return idx >= 0 ? this.markers[idx]! : null;
  }

  toJSON(): MarkerData[] {
    return this.markers.map((m) => m.toJSON());
  }

  static fromJSON(data: MarkerData[]): MarkerList {
    const list = new MarkerList();
    for (const d of data) list.add(Marker.fromJSON(d));
    return list;
  }
}
