/**
 * Timeline zoom — the bounds, the wheel step, and keeping a point of time
 * still while the scale changes.
 *
 * Ctrl+Wheel over the lanes used to just scale `pixelsPerSecond` and leave the
 * scroll position alone. The arithmetic consequence is that the only time that
 * stays under the pointer is t=0: everything else slides away, proportionally
 * to how far into the comp you are. Zooming in on a keyframe at 40 seconds
 * threw it off-screen, so the gesture was "zoom, hunt for it again, zoom,
 * hunt" — which is why fine keyframe work felt bad however deep the zoom went.
 *
 * The graph editor already anchored its own zoom, so the SAME gesture behaved
 * differently in two panels of the same editor. Both now use this.
 *
 * The bounds live here too, because they were separately declared in three
 * files and had to agree: the panel, the graph editor and the status-bar zoom
 * control all clamp whatever they are handed.
 */

/**
 * Zoom floor and ceiling in pixels per second.
 *
 * The ceiling used to be 800, which at 30fps is 27px per frame — enough to
 * place a key ON a frame and nothing finer. Keyframe times are continuous
 * (the engine compares them at 1e-9), and audio-synced work routinely needs
 * to land between frames, so the ceiling is now high enough that a millisecond
 * is a few pixels wide and a sub-frame drag is a real gesture rather than a
 * fight with the pixel grid.
 *
 * 4000 px/s is about 4px per millisecond, and 133px per frame at 30fps. Even a
 * ten-minute comp is 2.4M px of scroller at that zoom, which is an order of
 * magnitude inside what a browser will lay out.
 */
export const TIMELINE_PPS_MIN = 4;
export const TIMELINE_PPS_MAX = 4000;

/** One wheel notch. Multiplicative, so a notch costs the same at every zoom. */
export const ZOOM_WHEEL_FACTOR = 1.15;

export function clampPps(pps: number): number {
  if (!Number.isFinite(pps)) return TIMELINE_PPS_MIN;
  return Math.min(TIMELINE_PPS_MAX, Math.max(TIMELINE_PPS_MIN, pps));
}

/**
 * The zoom one wheel notch reaches from `pps`. `deltaY < 0` (wheel away /
 * pinch out) zooms IN, which is the direction every other timeline uses.
 */
export function zoomStep(pps: number, deltaY: number, factor = ZOOM_WHEEL_FACTOR): number {
  return clampPps(pps * (deltaY < 0 ? factor : 1 / factor));
}

export interface AnchoredZoom {
  pixelsPerSecond: number;
  /** Where the lanes must be scrolled to for the anchor to hold. Never < 0. */
  scrollLeft: number;
}

export interface ZoomAroundTimeArgs {
  /** Zoom before the gesture. */
  pps: number;
  /** Zoom after it — the caller has already clamped or stepped it. */
  nextPps: number;
  /** The time to hold still, in seconds. */
  time: number;
  /** Where that time sits in the VIEWPORT, in px from the lanes' left edge. */
  viewportX: number;
  /** Content inset the lanes draw t=0 at. */
  leftOffset?: number;
}

/**
 * The scroll position that leaves `time` at `viewportX` after the zoom.
 *
 * Content x for a time is `t * pps + leftOffset`; the viewport shows content
 * from `scrollLeft`. Holding `t` at `viewportX` therefore means
 * `t * nextPps + leftOffset - scrollLeft = viewportX`, and the only unknown is
 * the scroll.
 *
 * The clamp at 0 is why the result is returned as a pair rather than as a
 * scroll delta: near the head of the comp the anchor CANNOT hold — there is no
 * negative scroll to give it — and a caller applying a delta blind would drift
 * a little further out of true on every notch.
 */
export function zoomAroundTime(args: ZoomAroundTimeArgs): AnchoredZoom {
  const { time, viewportX, nextPps } = args;
  const leftOffset = args.leftOffset ?? 0;
  const pixelsPerSecond = clampPps(nextPps);
  const scrollLeft = Math.max(0, time * pixelsPerSecond + leftOffset - viewportX);
  return { pixelsPerSecond, scrollLeft };
}

export interface ZoomAroundPointerArgs {
  pps: number;
  nextPps: number;
  /** Pointer position in CLIENT px. */
  pointerX: number;
  /** The lanes' left edge in client px (`getBoundingClientRect().left`). */
  laneLeft: number;
  /** The lanes' scroll position at the moment of the gesture. */
  scrollLeft: number;
  leftOffset?: number;
}

/**
 * Zoom about whatever time is under the pointer — the wheel gesture.
 *
 * A pointer left of t=0 (over the content inset) resolves to a negative time;
 * that is left alone rather than clamped, because clamping it would make the
 * first few pixels of the lanes zoom about t=0 while the rest zoom about the
 * pointer, and the seam is visible.
 */
export function zoomAroundPointer(args: ZoomAroundPointerArgs): AnchoredZoom {
  const { pps, nextPps, pointerX, laneLeft, scrollLeft } = args;
  const leftOffset = args.leftOffset ?? 0;
  const viewportX = pointerX - laneLeft;
  // Guard a zero/negative current zoom: it would put the anchor at infinity.
  const time = pps > 0 ? (viewportX + scrollLeft - leftOffset) / pps : 0;
  return zoomAroundTime({ pps, nextPps, time, viewportX, leftOffset });
}

/**
 * Zoom about a time already on screen — the keyboard gesture and the zoom
 * slider, which have no pointer to anchor to and should hold the PLAYHEAD.
 *
 * Falls back to holding the viewport's centre when the playhead is off-screen:
 * anchoring to something the user cannot see reads as the view jumping.
 */
export function zoomAroundPlayhead(args: {
  pps: number;
  nextPps: number;
  playheadTime: number;
  scrollLeft: number;
  viewportWidth: number;
  leftOffset?: number;
}): AnchoredZoom {
  const { pps, nextPps, playheadTime, scrollLeft, viewportWidth } = args;
  const leftOffset = args.leftOffset ?? 0;
  const playheadX = playheadTime * pps + leftOffset - scrollLeft;
  const onScreen = playheadX >= 0 && playheadX <= viewportWidth;
  if (onScreen) {
    return zoomAroundTime({ pps, nextPps, time: playheadTime, viewportX: playheadX, leftOffset });
  }
  const centreX = viewportWidth / 2;
  const centreTime = pps > 0 ? (centreX + scrollLeft - leftOffset) / pps : 0;
  return zoomAroundTime({ pps, nextPps, time: centreTime, viewportX: centreX, leftOffset });
}
