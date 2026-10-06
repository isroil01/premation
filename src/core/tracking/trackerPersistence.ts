/**
 * Trackers saved on their layer (AE parity 3.6; AE keeps a layer's Motion
 * Trackers in the project). The engine stores them (`setLayerTrackers`,
 * `getLayerTrackers`, the layer's `fx.trackers`); this maps the Tracker
 * panel's state to and from that record. One tracker per layer for now —
 * the panel's current one.
 */

import { flicksToSeconds, secondsToFlicks, type EngineClient, type TrackerData, type TrackKind } from '@motion/engine-api';
import type { TrackerMode, TrackerResult } from '@stores/trackerStore';

export interface SavedTracker {
  mode: TrackerMode;
  points: Array<{ x: number; y: number }>;
  attach: Array<{ x: number; y: number }>;
  featureHalf: number;
  searchHalf: number;
  result: TrackerResult | null;
}

const MODES: readonly TrackerMode[] = ['follow', 'transform', 'stabilize', 'smooth', 'corner', 'mask'];

function kindOf(mode: TrackerMode, points: number): TrackKind {
  if (mode === 'transform' || (mode === 'stabilize' && points >= 2)) return 'positionRotationScale';
  if (mode === 'corner') return 'perspectiveCorner';
  if (mode === 'mask') return 'mask';
  return 'position';
}

/** The panel's state as the engine's record. Pure. */
export function trackerDataOf(s: SavedTracker): TrackerData {
  const size = (h: number): number => 2 * h + 1;
  return {
    name: 'Tracker 1',
    mode: s.mode,
    kind: kindOf(s.mode, s.points.length),
    sourceWidth: s.result?.sourceWidth ?? 0,
    sourceHeight: s.result?.sourceHeight ?? 0,
    points: s.points.map((p, i) => ({
      feature: { x: p.x, y: p.y, width: size(s.featureHalf), height: size(s.featureHalf) },
      search: { x: p.x, y: p.y, width: size(s.searchHalf), height: size(s.searchHalf) },
      attach: s.attach[i] ?? { x: 0, y: 0 },
      samples: (s.result?.tracks[i] ?? []).map((smp) => ({
        time: secondsToFlicks(smp.compTime), x: smp.x, y: smp.y, confidence: smp.confidence, coasted: smp.coasted,
      })),
    })),
  };
}

/** The engine's record as the panel's state; null when it is not one the panel can hold. Pure. */
export function savedTrackerOf(d: TrackerData): SavedTracker | null {
  const mode = MODES.find((m) => m === d.mode);
  if (!mode || d.points.length === 0) return null;
  const half = (n: number): number => Math.max(3, Math.round((n - 1) / 2));
  const first = d.points[0]!;
  const tracks = d.points.map((p) => p.samples.map((smp) => ({
    compTime: flicksToSeconds(smp.time), x: smp.x, y: smp.y, confidence: smp.confidence, coasted: smp.coasted,
  })));
  const hasResult = tracks.some((t) => t.length > 1) && d.sourceWidth > 0 && d.sourceHeight > 0;
  return {
    mode,
    points: d.points.map((p) => ({ x: p.feature.x, y: p.feature.y })),
    attach: d.points.map((p) => ({ x: p.attach.x, y: p.attach.y })),
    featureHalf: half(Math.max(first.feature.width, first.feature.height)),
    searchHalf: half(Math.max(first.search.width, first.search.height)),
    result: hasResult ? { tracks, sourceWidth: d.sourceWidth, sourceHeight: d.sourceHeight, status: 'completed' } : null,
  };
}

/** The layer's saved tracker, or null (none, or the engine cannot answer). */
export async function loadTracker(client: Pick<EngineClient, 'query'>, layer: string): Promise<SavedTracker | null> {
  try {
    const res = await client.query({ type: 'getLayerTrackers', layer });
    if (!res.ok) return null;
    const first = res.value.trackers[0];
    return first ? savedTrackerOf(first) : null;
  } catch {
    return null;
  }
}
