/**
 * Serialization — versioned, forward-compatible JSON for a Timeline. The
 * timeline serializes independently of the rest of the app so a project file can
 * store it as its own document. A migration registry upgrades older documents to
 * the current schema on load.
 */

import { Timeline } from '../core/Timeline';
import { Track, type TrackData } from '../tracks/Track';
import { Marker, type MarkerData } from '../markers/Marker';
import type { FrameRate } from '../time/FrameRate';
import type { TimelineRanges } from '../core/ranges';
import type { TimelineViewState } from '../core/navigation';
import type { TrackGroup } from '../core/Timeline';

export const TIMELINE_FORMAT_VERSION = 1;

export interface SerializedTimeline {
  version: number;
  id: string;
  name: string;
  frameRate: FrameRate;
  duration: number;
  currentFrame: number;
  tracks: TrackData[];
  groups: TrackGroup[];
  markers: MarkerData[];
  ranges: TimelineRanges;
  view: TimelineViewState;
}

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

const migrations = new Map<number, Migration>();

/** Register a migration from `fromVersion` → `fromVersion + 1`. */
export function registerMigration(fromVersion: number, migration: Migration): void {
  migrations.set(fromVersion, migration);
}

/** Upgrade a raw document to the current version by chaining migrations. */
export function migrate(doc: Record<string, unknown>): SerializedTimeline {
  let current = { ...doc };
  let version = typeof current.version === 'number' ? current.version : 0;
  while (version < TIMELINE_FORMAT_VERSION) {
    const migration = migrations.get(version);
    if (!migration) break;
    current = migration(current);
    version += 1;
    current.version = version;
  }
  return current as unknown as SerializedTimeline;
}

export function serializeTimeline(timeline: Timeline): SerializedTimeline {
  const internal = timeline._internal();
  return {
    version: TIMELINE_FORMAT_VERSION,
    id: timeline.id,
    name: timeline.name,
    frameRate: timeline.getFrameRate(),
    duration: timeline.duration,
    currentFrame: timeline.currentFrame,
    tracks: internal.tracks.map((t) => t.toJSON()),
    groups: [...internal.groups.values()].map((g) => ({ ...g, trackIds: [...g.trackIds] })),
    markers: timeline.markers.toJSON(),
    ranges: { ...internal.ranges },
    view: { ...internal.view },
  };
}

export function deserializeTimeline(doc: SerializedTimeline | Record<string, unknown>): Timeline {
  const data = migrate(doc as Record<string, unknown>);
  const timeline = new Timeline({
    id: data.id,
    name: data.name,
    frameRate: data.frameRate,
    duration: data.duration,
  });
  timeline.history.silently(() => {
    const internal = timeline._internal();
    for (const td of data.tracks) internal.tracks.push(Track.fromJSON(td));
    for (const g of data.groups ?? []) internal.groups.set(g.id, { ...g, trackIds: [...g.trackIds] });
    internal.setRanges(data.ranges);
    internal.setView(data.view);
    internal.reindex();
    for (const m of data.markers ?? []) timeline.markers.add(Marker.fromJSON(m));
    if (typeof data.currentFrame === 'number') timeline.playhead.set(data.currentFrame);
  });
  return timeline;
}
