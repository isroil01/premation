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
import type { EasingKind } from '@motion/animation';
import type { TimelineGroupKey } from '@core/timeline/propertyTree';
import type { ReactNode } from 'react';

export interface TimelineKeyframeRef {
  id: KeyId;
  nodeId: NodeId;
  time: number;
  roving?: boolean;
  isHold?: boolean;
  /**
   * Easing of the segment ARRIVING at this keyframe — i.e. the previous
   * keyframe's `easing`. Undefined on the first keyframe of a track.
   *
   * Carried separately from `easeOut` because the two sides are independent:
   * this is what lets the diamond be drawn as two halves and show "eased in,
   * hold out" as the distinct thing it is.
   */
  easeIn?: EasingKind;
  /** Easing of the segment LEAVING this keyframe (its own `easing`). */
  easeOut?: EasingKind;
  /** True for the first / last keyframe of its track (no segment on that side). */
  isFirst?: boolean;
  isLast?: boolean;
}

/**
 * One animatable property of a track (e.g. "x", "opacity"). Rendered as a
 * sub-row when the track is expanded (AE `U` reveal / disclosure chevron).
 */
export interface TimelinePropertyTrack {
  prop: string;
  label: string;
  keyframes: ReadonlyArray<TimelineKeyframeRef>;
  /**
   * False marks a STATIC placeholder row (AE-style property tree): the
   * property has no keyframe track yet, so its header shows a stopwatch to
   * enable animation instead of the ◀◆▶ keyframe navigator. Omitted/true for
   * real animated rows.
   */
  animated?: boolean;
  /** Engine props this placeholder's stopwatch keys when clicked. */
  stopwatchProps?: ReadonlyArray<string>;
  /**
   * Engine props this row's value fields edit, in display order — Position is
   * `['x','y']`, Opacity is `['opacity']`.
   *
   * AE shows a live, scrubbable value beside every property in the timeline, so
   * you can key AND set values without crossing to the inspector. Without this
   * the timeline could only ever *add* a keyframe: changing what it held meant
   * a round trip to the right-hand panel.
   */
  valueProps?: ReadonlyArray<string>;
  /** Unit suffix for this row's value fields ('px', '%', '°'). */
  valueUnit?: string;
  /**
   * Which section of the layer's tree this row belongs under — AE's Text /
   * Contents / Masks / Effects / Transform / Layer Styles / Material Options /
   * Audio headings.
   *
   * Stated by the model rather than guessed by the view. The timeline used to
   * derive the heading by matching substrings of the label ("blur" → Effects),
   * which put a Gaussian Blur's radius and a text animator's Blur under the
   * same heading and had no way to tell a layer style from the effect it
   * compiles to. Absent → the view falls back to that guess.
   */
  group?: TimelineGroupKey;
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
  /** Media asset behind this clip, for the waveform. Set for audio layers and
   *  for video layers (whose own audio track shares the picture's asset). */
  assetId?: string;
  /** The window this bar shows onto its source, in SOURCE seconds. Trim moves
   *  the edges, slip slides both. The waveform slices to this so it draws the
   *  audible region rather than the whole file scaled to the bar. */
  sourceInSec?: number;
  sourceOutSec?: number;
}

export interface TimelineTrack {
  id: TrackId;
  name: string;
  /** Optional subtitle / kind label. */
  kind?: string;
  /** Icon glyph name (from the shared Icon set) shown left of the name. */
  icon?: string;
  /** This layer's AUDIO is muted. Separate from `muted` (the visibility eye),
   *  which hides the picture. Drives the clip bar's speaker glyph. */
  audioMuted?: boolean;
  /** Locked tracks don't allow edits. */
  locked?: boolean;
  /** Muted / solo state. */
  muted?: boolean;
  solo?: boolean;
  /**
   * A GUIDE layer: drawn in the comp, dropped from every export.
   *
   * Shown on the row because the whole point of the flag is that the layer
   * behaves differently somewhere the user is not looking. An unmarked guide
   * layer is indistinguishable from an ordinary one until the delivered file
   * comes back missing it.
   */
  guide?: boolean;
  /**
   * PRESERVE UNDERLYING TRANSPARENCY: the layer is clipped to the alpha already
   * composited beneath it. Shown on the row for the same reason `guide` is —
   * the layer looks ordinary until something below it changes shape.
   */
  preserveTransparency?: boolean;
  /** Per-track color stripe on the header. */
  color?: string;
  /** Ghosted (dimmed) because it's outside the current Focus Mode context. */
  ghosted?: boolean;
  /** Pre-computed keyframe markers (visual only). */
  keyframes?: ReadonlyArray<TimelineKeyframeRef>;
  /** Clips to render on this lane. */
  clips?: ReadonlyArray<TimelineClip>;
  /**
   * The layer's own markers, already converted to COMP seconds.
   *
   * Stored layer-relative on the engine side so they travel with a trimmed
   * layer; the conversion happens once, in `getLayerMarkers`, so this row can be
   * drawn on the same axis as everything else on it.
   */
  markers?: ReadonlyArray<TimelineMarker>;
  /** Animatable properties, revealed as sub-rows when the track is expanded. */
  properties?: ReadonlyArray<TimelinePropertyTrack>;
  /**
   * This track HAS a property tree, even though `properties` is empty right now.
   *
   * `properties` is only built for expanded tracks (a 10k-layer comp cannot
   * afford the full tree per row), so it cannot be used to decide whether the
   * disclosure chevron is live: a layer with no keyframes yet would report "no
   * properties", the chevron would hide, and the always-there Transform group
   * behind it — the only way to start an animation FROM the timeline — would be
   * unreachable. The model states the capability separately from the payload.
   */
  canExpand?: boolean;
  /** Optional custom header content (icons, etc.). */
  headerContent?: ReactNode;
  /** Blend mode of the layer node. */
  blendMode?: string;
  matteMode?: any;
  /** Parent ID of the layer node. */
  parent?: string | null;
  /** Layout flags */
  shy?: boolean;
  collapse?: boolean;
  fxEnabled?: boolean;
  motionBlur?: boolean;
  adjustment?: boolean;
  threeD?: boolean;
  nodeColor?: string;
  depth?: number;
  isGroup?: boolean;
  expanded?: boolean;
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
  /**
   * Playhead time in seconds. The playhead is a per-frame value, so prefer
   * the host passing it via the separate `playheadTime` prop — that lets the
   * model object keep a stable identity across playback frames. Required
   * because non-realtime consumers (timecode display, GraphEditor) read it
   * from the model; <Timeline> itself falls back to `model.currentTime`
   * when the host doesn't pass `playheadTime` as a separate prop.
   */
  currentTime: number;
  /** Frame the DISPLAYED timecode starts from (comp start timecode). Ruler
   *  labels add it; tick positions stay 0-based. Default 0. */
  startFrame?: number;
  /** Horizontal zoom factor. 1 = default. */
  pixelsPerSecond: number;
  /** Loop region. */
  loop?: { start: number; end: number };
  /** Work area (in/out region, seconds). Playback loops within it; a band is
   *  drawn on the ruler + a faint tint over the lanes. */
  workArea?: { start: number; end: number };
  // NOTE: preview-coverage (RAM green lane / disk blue lane) is deliberately
  // NOT part of this model. It changes on every rendered frame, and carrying it
  // here meant rebuilding the whole model object — and re-rendering the whole
  // timeline — at frame rate, which is exactly what this model is documented to
  // avoid. `Timeline` renders `<CacheBars>`, which subscribes to the frame
  // cache itself and throttles its own refresh.
  /** Snap to grid (UI hint; engine may ignore). */
  snapToGrid?: boolean;
  /** Total height of the track header column. */
  trackHeaderWidth?: number;
  /** Height of a single track row. */
  trackHeight?: number;
  /** Height of the ruler row. */
  rulerHeight?: number;
}
