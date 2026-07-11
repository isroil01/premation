/**
 * The timeline event map. Every temporal or structural change emits a typed
 * event so the renderer, panels, animation engine, and app command system can
 * react without polling. The engine never calls those systems directly — it
 * only emits.
 */

import type { FrameRate } from '../time/FrameRate';
import type { Track } from '../tracks/Track';
import type { Layer } from '../layers/Layer';
import type { Marker } from '../markers/Marker';
import type { SelectionSnapshot } from '../selection/TimelineSelection';
import type { TimeRange } from '../utils/TimeRange';
import type { RangeKind } from '../core/ranges';

export interface TimelineEventMap {
  TimelineCreated: { id: string };
  TimelineDestroyed: { id: string };

  TrackAdded: { track: Track; index: number };
  TrackRemoved: { trackId: string; index: number };
  TrackMoved: { trackId: string; from: number; to: number };
  TrackFlagsChanged: { track: Track };
  TrackUpdated: { track: Track; changed: string };

  LayerAdded: { layer: Layer; trackId: string; index: number };
  LayerRemoved: { layerId: string; trackId: string };
  LayerMoved: { layer: Layer; fromTrackId: string; toTrackId: string; index: number };
  LayerTrimmed: { layer: Layer };
  LayerSplit: { original: Layer; right: Layer; frame: number };
  LayerUpdated: { layer: Layer; changed: string };

  PlayheadMoved: { frame: number; previous: number };
  CurrentTimeChanged: { frame: number; seconds: number };
  PlayStateChanged: { playing: boolean };

  DurationChanged: { duration: number; previous: number };
  FrameRateChanged: { frameRate: FrameRate; previous: FrameRate };

  TimelineZoomChanged: { zoom: number; previous: number };
  TimelineScrollChanged: { scrollX: number; scrollY: number };

  TimelineSelectionChanged: { selection: SelectionSnapshot };

  MarkerAdded: { marker: Marker };
  MarkerRemoved: { markerId: string };
  MarkerUpdated: { marker: Marker };

  RangeChanged: { kind: RangeKind; range: TimeRange | null };
}

export type TimelineEventName = keyof TimelineEventMap;
