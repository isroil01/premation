/**
 * @motion/timeline — the framework-independent Timeline Engine.
 *
 * The data engine that manages all temporal data in the editor: tracks, layers,
 * clips, markers, the playhead, time ranges, selection, and navigation. It
 * stores, organizes, queries, and mutates time-based data. No React, no DOM, no
 * rendering, no timers — an external clock drives playback via `tick(dtMs)`.
 *
 * Canonical unit: frames. Use the time helpers for ms/seconds/timecode.
 */

// ── Core ──────────────────────────────────────────────────────────
export { Timeline, type TimelineInit, type TrackGroup } from './core/Timeline';
export type { TimelineState } from './core/TimelineState';
export { type RangeKind, type TimelineRanges, emptyRanges } from './core/ranges';
export {
  type TimelineViewState,
  defaultView,
  clampPixelsPerFrame,
  MIN_PPF,
  MAX_PPF,
} from './core/navigation';

// ── Time system ───────────────────────────────────────────────────
export * from './time';

// ── Entities ──────────────────────────────────────────────────────
export { Track, type TrackData, type TrackInit, type TrackFlags, type TrackKind } from './tracks/Track';
export { Layer, type LayerData, type LayerInit } from './layers/Layer';
export { Clip, type ClipData } from './clips/Clip';
export { Marker, type MarkerData, type MarkerInit, type MarkerScope } from './markers/Marker';
export { MarkerList } from './markers/MarkerList';

// ── Playhead / selection ──────────────────────────────────────────
export { Playhead } from './playhead/Playhead';
export { TimelineSelection, type SelectionSnapshot } from './selection/TimelineSelection';

// ── History ───────────────────────────────────────────────────────
export { History, type Command, type HistoryOptions } from './history/History';

// ── Events ────────────────────────────────────────────────────────
export { TypedEmitter, type Disposable, type Handler } from './events/Emitter';
export type { TimelineEventMap, TimelineEventName } from './events/TimelineEvents';

// ── Time ranges / search utils ────────────────────────────────────
export * as TimeRange from './utils/TimeRange';
export type { TimeRange as TimeRangeType } from './utils/TimeRange';
export { lowerBound, upperBound, insertSorted } from './utils/search';
export { uid } from './utils/id';

// ── Serialization ─────────────────────────────────────────────────
export {
  TIMELINE_FORMAT_VERSION,
  type SerializedTimeline,
  type Migration,
  serializeTimeline,
  deserializeTimeline,
  applySerializedTimeline,
  registerMigration,
  migrate,
} from './serialization/Serializer';

// ── Integration ports ─────────────────────────────────────────────
export type {
  SourceResolver,
  TimelineCommandSink,
  TimeConsumer,
  TimelineEventForwarder,
} from './ports';

// ── Graft serialize()/deserialize() onto Timeline (documented API) ──
import { Timeline as TimelineClass } from './core/Timeline';
import { serializeTimeline as _ser, deserializeTimeline as _deser } from './serialization/Serializer';
import type { SerializedTimeline as _ST } from './serialization/Serializer';

declare module './core/Timeline' {
  interface Timeline {
    /** Serialize to a versioned, JSON-safe document. */
    serialize(): _ST;
    /** Serialize (alias). */
    toJSON(): _ST;
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Timeline {
    /** Rebuild a Timeline from a serialized document. */
    function deserialize(doc: _ST | Record<string, unknown>): Timeline;
  }
}

TimelineClass.prototype.serialize = function serialize(this: TimelineClass): _ST {
  return _ser(this);
};
TimelineClass.prototype.toJSON = function toJSON(this: TimelineClass): _ST {
  return _ser(this);
};
(TimelineClass as unknown as { deserialize: typeof _deser }).deserialize = _deser;
