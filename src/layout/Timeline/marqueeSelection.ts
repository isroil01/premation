/**
 * Marquee (rubber-band) keyframe selection — pure geometry.
 *
 * The Timeline draws keyframe diamonds at (time * pixelsPerSecond) px within
 * uniform-height rows stacked at rowIndex * trackHeight. A marquee drag over
 * the lanes produces a rectangle in that same content coordinate space
 * (x: px from t=0, y: px from the top of the first row). This module answers
 * "which keyframes does the rectangle touch?" with no DOM or React involved,
 * so the hit math is unit-testable in isolation.
 */

/** Normalized rectangle in lane content coordinates (left <= right, top <= bottom). */
export interface MarqueeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The minimal keyframe shape the hit test needs. */
export interface MarqueeKeyframe {
  id: string;
  /** Keyframe time in seconds. */
  time: number;
}

/**
 * One visible timeline row, in render order (index = vertical position).
 * Collapsed track summary rows pass their flat keyframe union; expanded track
 * summary rows pass an empty list (their property sub-rows carry the
 * keyframes); property sub-rows pass their own keyframes.
 */
export interface MarqueeRow {
  keyframes: ReadonlyArray<MarqueeKeyframe>;
}

/** Drag must travel further than this (px, euclidean) to count as a marquee. */
export const MARQUEE_DRAG_THRESHOLD_PX = 3;

/**
 * Half the rendered width of a keyframe diamond (8px square rotated 45° ≈
 * 11.3px wide → ~6px half-width). A rect that merely grazes a diamond's edge
 * still selects it, matching AE's "touch to select" feel.
 */
export const KEYFRAME_HALF_WIDTH_PX = 6;

/** True when pointer travel exceeds the click-vs-drag threshold. */
export function exceedsDragThreshold(
  dx: number,
  dy: number,
  threshold: number = MARQUEE_DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/** Order two drag corners into a normalized rect. */
export function normalizeMarqueeRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): MarqueeRect {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}

export interface MarqueeHitOptions {
  /** Horizontal zoom — px per second (keyframe x = time * pixelsPerSecond). */
  pixelsPerSecond: number;
  /** Uniform row height in px. */
  trackHeight: number;
  /** Horizontal grab tolerance around a diamond's center. */
  keyframeHalfWidthPx?: number;
}

/**
 * All keyframe ids whose diamond intersects the rect.
 *
 * A row is hit when its vertical band [i*h, (i+1)*h] touches the rect
 * (inclusive, so a zero-height horizontal drag inside a row still selects).
 * Within a hit row, a keyframe is selected when its diamond — center at
 * time*pps, half-width tolerance either side — overlaps [left, right].
 */
export function marqueeHitKeyframeIds(
  rows: ReadonlyArray<MarqueeRow>,
  rect: MarqueeRect,
  opts: MarqueeHitOptions,
): Set<string> {
  const { pixelsPerSecond, trackHeight } = opts;
  const half = opts.keyframeHalfWidthPx ?? KEYFRAME_HALF_WIDTH_PX;
  const hits = new Set<string>();
  if (trackHeight <= 0) return hits;

  const firstRow = Math.max(0, Math.floor(rect.top / trackHeight));
  const lastRow = Math.min(rows.length - 1, Math.floor(rect.bottom / trackHeight));

  for (let i = firstRow; i <= lastRow; i++) {
    const row = rows[i];
    if (!row) continue;
    for (const kf of row.keyframes) {
      const x = kf.time * pixelsPerSecond;
      if (x + half >= rect.left && x - half <= rect.right) {
        hits.add(kf.id);
      }
    }
  }
  return hits;
}

/**
 * Final selection for a marquee update: additive (Shift held at drag start)
 * unions the hits with the pre-drag selection; plain replaces it.
 */
export function combineMarqueeSelection(
  base: ReadonlySet<string>,
  hits: ReadonlySet<string>,
  additive: boolean,
): Set<string> {
  if (!additive) return new Set(hits);
  const out = new Set(base);
  for (const id of hits) out.add(id);
  return out;
}
