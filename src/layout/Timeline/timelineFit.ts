/**
 * "Fit composition" / "Fit work area" — the two timeline zoom actions that need
 * to know how wide the panel is.
 *
 * Kept out of the button that triggers them because they are also commands
 * (menu, shortcut, palette), and a status-bar widget is the wrong owner for
 * behaviour the keyboard can invoke while that widget is not even on screen.
 *
 * Both do the same two things: pick the zoom that makes a span exactly fill the
 * lanes, then scroll so the span starts at the left edge. Zooming without the
 * scroll is the half-measure that made the old +/- controls frustrating — you
 * could get the right scale and still be looking at the wrong part of the comp.
 */

import { getTimelineController } from '@core/timeline/TimelineController';
import {
  fitPixelsPerSecond,
  getTimelineViewport,
  scrollTimelineTo,
  FIT_PADDING_PX,
} from './timelineViewport';

/** Matches the wheel-zoom clamp in Timeline.tsx and the status-bar slider. */
export const TIMELINE_ZOOM_MIN = 4;
export const TIMELINE_ZOOM_MAX = 800;

export interface FitResult {
  /** The zoom applied, in pixels per second. */
  pixelsPerSecond: number;
  /** Where the lanes were scrolled to, in pixels. */
  scrollLeft: number;
}

/**
 * Zoom + scroll so `[startSeconds, endSeconds)` fills the visible lanes.
 *
 * Returns `null` — changing nothing — when the span is empty or no timeline is
 * mounted to measure. Silently clamping to the zoom limits in those cases would
 * throw the user's view away in exchange for nothing.
 */
export function fitTimelineToRange(startSeconds: number, endSeconds: number): FitResult | null {
  const span = endSeconds - startSeconds;
  const { width } = getTimelineViewport();
  const pps = fitPixelsPerSecond({
    spanSeconds: span,
    viewportWidth: width,
    paddingPx: FIT_PADDING_PX,
    minPixelsPerSecond: TIMELINE_ZOOM_MIN,
    maxPixelsPerSecond: TIMELINE_ZOOM_MAX,
  });
  if (pps === null) return null;

  const controller = getTimelineController();
  controller.setPixelsPerSecond(pps, startSeconds);
  // Lane content for time t sits at `8 + t·pps` (the lanes' left offset), so
  // this parks `startSeconds` 8px inside the panel edge rather than flush
  // against it — the same gutter time 0 gets at scroll 0.
  const scrollLeft = Math.max(0, startSeconds * pps);
  // After the zoom, not with it: the lane content is only as wide as the CURRENT
  // zoom until React re-renders, and a scrollLeft past that width is clamped
  // away by the browser — which would land "fit work area" back at 0.
  const apply = (): void => scrollTimelineTo(scrollLeft);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
  else apply();
  return { pixelsPerSecond: pps, scrollLeft };
}

/** Fit the whole composition into the visible lanes. */
export function fitTimelineToComposition(): FitResult | null {
  return fitTimelineToRange(0, getTimelineController().durationSeconds);
}

/** Fit the work area into the visible lanes. No work area set → no-op. */
export function fitTimelineToWorkArea(): FitResult | null {
  const wa = getTimelineController().getWorkArea();
  if (!wa) return null;
  return fitTimelineToRange(wa.start, wa.end);
}

/** Whether "Fit work area" has anything to do right now. */
export function hasWorkArea(): boolean {
  return getTimelineController().getWorkArea() !== null;
}
