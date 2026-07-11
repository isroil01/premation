/**
 * TimelineSelection — what the user has selected in the timeline: any mix of
 * tracks, layers, and markers, plus an optional time range (rubber-band / work
 * selection). The Timeline owns selection truth and wires `onChange` to its
 * event bus. Pure sets; no UI.
 */

import type { TimeRange } from '../utils/TimeRange';

export interface SelectionSnapshot {
  tracks: string[];
  layers: string[];
  markers: string[];
  range: TimeRange | null;
}

type Kind = 'tracks' | 'layers' | 'markers';

export class TimelineSelection {
  private readonly sets: Record<Kind, Set<string>> = {
    tracks: new Set(),
    layers: new Set(),
    markers: new Set(),
  };
  private timeRange: TimeRange | null = null;

  /** Fired after any change with the new snapshot. */
  onChange: ((snapshot: SelectionSnapshot) => void) | null = null;

  // ── Queries ──────────────────────────────────────────────────────
  get tracks(): string[] {
    return [...this.sets.tracks];
  }
  get layers(): string[] {
    return [...this.sets.layers];
  }
  get markers(): string[] {
    return [...this.sets.markers];
  }
  get range(): TimeRange | null {
    return this.timeRange ? { ...this.timeRange } : null;
  }
  has(kind: Kind, id: string): boolean {
    return this.sets[kind].has(id);
  }
  isEmpty(): boolean {
    return (
      this.sets.tracks.size === 0 &&
      this.sets.layers.size === 0 &&
      this.sets.markers.size === 0 &&
      this.timeRange === null
    );
  }

  snapshot(): SelectionSnapshot {
    return { tracks: this.tracks, layers: this.layers, markers: this.markers, range: this.range };
  }

  // ── Mutations ────────────────────────────────────────────────────
  set(kind: Kind, ids: Iterable<string>): void {
    this.sets[kind].clear();
    for (const id of ids) this.sets[kind].add(id);
    this.commit();
  }

  add(kind: Kind, id: string): void {
    if (this.sets[kind].has(id)) return;
    this.sets[kind].add(id);
    this.commit();
  }

  remove(kind: Kind, id: string): void {
    if (this.sets[kind].delete(id)) this.commit();
  }

  toggle(kind: Kind, id: string): void {
    if (this.sets[kind].has(id)) this.sets[kind].delete(id);
    else this.sets[kind].add(id);
    this.commit();
  }

  setRange(range: TimeRange | null): void {
    this.timeRange = range ? { ...range } : null;
    this.commit();
  }

  /** Clear everything (or just one kind / the range). */
  clear(kind?: Kind | 'range'): void {
    if (!kind) {
      this.sets.tracks.clear();
      this.sets.layers.clear();
      this.sets.markers.clear();
      this.timeRange = null;
    } else if (kind === 'range') {
      this.timeRange = null;
    } else {
      this.sets[kind].clear();
    }
    this.commit();
  }

  /** Drop an id from every set (used when an entity is deleted). */
  forget(id: string): void {
    let changed = false;
    for (const k of ['tracks', 'layers', 'markers'] as Kind[]) {
      if (this.sets[k].delete(id)) changed = true;
    }
    if (changed) this.commit();
  }

  private commit(): void {
    this.onChange?.(this.snapshot());
  }
}
