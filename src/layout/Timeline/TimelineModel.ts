/**
 * Timeline data shapes.
 *
 * The Timeline component itself is purely a UI renderer. It consumes a
 * `TimelineModel` prop whose values are produced by the future Timeline
 * Engine. This file documents the *contract* between the engine and the UI.
 *
 * A TimelineModel is:
 *   - tracks:         vertical lanes (left-to-right of the timeline area)
 *   - markers:        named bookmarks at times
 *   - duration:       total length in seconds
 *   - frameRate:      frames per second
 *   - currentTime:    the playhead time in seconds
 *   - pixelsPerSecond: horizontal zoom factor
 *
 * The engine is responsible for:
 *   - Computing the visible window given scroll + zoom.
 *   - Dispatching TimelineFocused / TimeChanged / PlayStateChanged.
 *   - Resolving keyframe positions (the UI just renders "clips" of
 *     pre-computed geometry).
 *
 * The UI is responsible for:
 *   - Rendering the ruler, track headers, and lanes.
 *   - Hosting the playhead and drag-to-scrub interactions (UI only).
 *   - Virtualizing track rows for thousands of tracks.
 */

import type { TrackId, KeyId, NodeId } from '@app-types/common';
import type { ReactNode } from 'react';

export interface TimelineKeyframeRef {
  id: KeyId;
  nodeId: NodeId;
  time: number;
}

/**
 * One animatable property of a track (e.g. "x", "opacity"). Rendered as a
 * sub-row when the track is expanded (AE `U` reveal / disclosure chevron).
 */
export interface TimelinePropertyTrack {
  prop: string;
  label: string;
  keyframes: ReadonlyArray<TimelineKeyframeRef>;
}

/** A cached time range (rendered frames) shown on the cache bar. */
export interface TimelineCacheRange {
  start: number;
  end: number;
}

export interface TimelineClip {
  id: string;
  trackId: TrackId;
  nodeId: NodeId;
  /** Clip start time (seconds). */
  start: number;
  /** Clip duration (seconds). */
  duration: number;
  label?: string;
  color?: string;
}

export interface TimelineTrack {
  id: TrackId;
  name: string;
  /** Optional subtitle / kind label. */
  kind?: string;
  /** Icon glyph name (from the shared Icon set) shown left of the name. */
  icon?: string;
  /** Locked tracks don't allow edits. */
  locked?: boolean;
  /** Muted / solo state. */
  muted?: boolean;
  solo?: boolean;
  /** Per-track color stripe on the header. */
  color?: string;
  /** Ghosted (dimmed) because it's outside the current Focus Mode context. */
  ghosted?: boolean;
  /** Pre-computed keyframe markers (visual only). */
  keyframes?: ReadonlyArray<TimelineKeyframeRef>;
  /** Clips to render on this lane. */
  clips?: ReadonlyArray<TimelineClip>;
  /** Animatable properties, revealed as sub-rows when the track is expanded. */
  properties?: ReadonlyArray<TimelinePropertyTrack>;
  /** Optional custom header content (icons, etc.). */
  headerContent?: ReactNode;
}

export interface TimelineMarker {
  id: string;
  time: number;
  label: string;
  color?: string;
}

export interface TimelineModel {
  tracks: ReadonlyArray<TimelineTrack>;
  markers: ReadonlyArray<TimelineMarker>;
  duration: number;
  frameRate: number;
  currentTime: number;
  /** Horizontal zoom factor. 1 = default. */
  pixelsPerSecond: number;
  /**
   * Cached (rendered) time ranges shown on the cache bar under the ruler.
   * Cached regions render in Success green at 40% opacity; the rest stays
   * transparent — preserving AE muscle memory.
   */
  cachedRanges?: ReadonlyArray<TimelineCacheRange>;
  /** Loop region. */
  loop?: { start: number; end: number };
  /** Work area (in/out region, seconds). Playback loops within it; a band is
   *  drawn on the ruler + a faint tint over the lanes. */
  workArea?: { start: number; end: number };
  /** Snap to grid (UI hint; engine may ignore). */
  snapToGrid?: boolean;
  /** Total height of the track header column. */
  trackHeaderWidth?: number;
  /** Height of a single track row. */
  trackHeight?: number;
  /** Height of the ruler row. */
  rulerHeight?: number;
}
