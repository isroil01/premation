/**
 * The timeline's TRANSPORT and VIEW state — the playhead, play / pause, loop,
 * the ruler's zoom and scroll — as UI code reaches it (B4, docs/B4_MIRROR.md).
 *
 * None of this is the document: transport is engine-owned control state
 * (ENGINE_API.md §6: play / pause / seek / step / setLoop are `[control]`
 * commands that never touch the document or history), and zoom / scroll are
 * editor view state (CLAUDE.md: editor state never enters the document). Today
 * the TypeScript `TimelineController` holds both, so this module forwards to
 * it; when the clock moves into the engine (phase C/D) these become engine
 * transport commands and the ruler's view moves to a view store — the callers
 * do not change.
 *
 * Document facts the controller also knows (frame rate, duration, the work
 * area, markers, bars) are NOT here: read them from the document mirror
 * (`useActiveMirrorComp()?.settings`, `comp.markers`, `layer.timing`).
 *
 * Listed in the B4 read rule's SEAM_MODULES (scripts/lint/engineReadsRule.mjs)
 * like `transportController`: using it is not a document read.
 */

import { getTimelineController } from './TimelineController';

// ── Playhead ─────────────────────────────────────────────────────────

/** The active composition's playhead, seconds. */
export function playheadSeconds(): number {
  return getTimelineController().currentSeconds;
}

/** Move the active composition's playhead (seconds). */
export function seekPlayhead(seconds: number): void {
  getTimelineController().seekSeconds(seconds);
}

export function goToStart(): void {
  getTimelineController().goToStart();
}

export function goToEnd(): void {
  getTimelineController().goToEnd();
}

export function stepForward(): void {
  getTimelineController().nextFrame();
}

export function stepBackward(): void {
  getTimelineController().previousFrame();
}

/** Seek to the next keyframe after the playhead (selected layers, or all). */
export function goToNextKeyframe(): void {
  getTimelineController().goToNextKeyframe();
}

/** Seek to the previous keyframe before the playhead (selected layers, or all). */
export function goToPrevKeyframe(): void {
  getTimelineController().goToPrevKeyframe();
}

/** Seek to the next comp marker after the playhead. */
export function goToNextMarker(): void {
  getTimelineController().goToNextMarker();
}

/** Seek to the previous comp marker before the playhead. */
export function goToPrevMarker(): void {
  getTimelineController().goToPrevMarker();
}

/** Seek to the Nth comp marker (1-based, time order); false when there is none. */
export function goToMarkerIndex(n: number): boolean {
  return getTimelineController().goToMarkerIndex(n);
}

// ── Play state ───────────────────────────────────────────────────────

export function isTransportPlaying(): boolean {
  return getTimelineController().isPlaying;
}

export function playTransport(): void {
  getTimelineController().play();
}

export function pauseTransport(): void {
  getTimelineController().pause();
}

export function togglePlayTransport(): void {
  getTimelineController().togglePlay();
}

/** Stop every composition's transport except the active one (tab switch mid-playback). */
export function pauseInactiveComps(): void {
  getTimelineController().pauseInactiveComps();
}

/** Loop playback of the active composition (AE's loop toggle; follows the work area). */
export function isTransportLooping(): boolean {
  return getTimelineController().isLooping();
}

export function setTransportLooping(on: boolean): void {
  getTimelineController().setLooping(on);
}

// ── Ruler view (editor state) ────────────────────────────────────────

/** The ruler's zoom, pixels per second. */
export function timelinePixelsPerSecond(): number {
  return getTimelineController().getPixelsPerSecond();
}

/** Set the ruler's zoom, optionally keeping `anchorSeconds` under the pointer. */
export function setTimelinePixelsPerSecond(pps: number, anchorSeconds?: number): void {
  getTimelineController().setPixelsPerSecond(pps, anchorSeconds);
}

/** Fit the whole composition into `viewportWidthPx`. */
export function fitTimelineZoom(viewportWidthPx: number): void {
  getTimelineController().fitZoom(viewportWidthPx);
}

/** Mirror the timeline's horizontal scroll (px) into the ruler view. */
export function setTimelineScrollPixels(scrollLeftPx: number): void {
  getTimelineController().setScrollPixels(scrollLeftPx);
}

/**
 * Call `listener` whenever the ACTIVE composition's ruler zoom changes. Bound
 * to the timeline of the comp active when called — re-subscribe on a tab switch.
 */
export function onTimelineZoomChanged(listener: () => void): () => void {
  const sub = getTimelineController().timeline.events.on('TimelineZoomChanged', listener);
  return () => sub.dispose();
}
