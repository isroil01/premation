/**
 * TimelineView — the horizontal/vertical navigation state of the timeline
 * (zoom in pixels-per-frame, scroll offsets, viewport width). This is view state
 * the engine tracks so navigation commands (zoom to fit, center playhead) are
 * computed consistently; the renderer reads it but the engine owns it.
 */

export interface TimelineViewState {
  /** Horizontal scale in pixels per frame. */
  pixelsPerFrame: number;
  /** Horizontal scroll offset in frames (leftmost visible frame). */
  scrollX: number;
  /** Vertical scroll offset in pixels (for the track stack). */
  scrollY: number;
  /** Visible width of the timeline in pixels (0 until the host reports it). */
  viewportWidth: number;
}

export const MIN_PPF = 0.01;
export const MAX_PPF = 200;

export function clampPixelsPerFrame(ppf: number): number {
  return Math.min(MAX_PPF, Math.max(MIN_PPF, ppf));
}

export function defaultView(): TimelineViewState {
  return { pixelsPerFrame: 10, scrollX: 0, scrollY: 0, viewportWidth: 0 };
}
