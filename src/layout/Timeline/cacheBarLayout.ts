/** Time span in seconds (timeline cache-bar coordinates). */
export type CacheTimeRange = { start: number; end: number };

/** Pixel layout for one cache-bar segment under the ruler. */
export type CacheBarSegment = { left: number; width: number };

/**
 * Merge nearby cached spans for display.
 *
 * When playback outruns rendering, the RAM cache holds every-other (or
 * similarly gapped) frames — accurate, but at timeline zoom each 1-frame span
 * becomes a green dot. Bridging small gaps keeps the bar readable without
 * hiding real multi-frame holes from scrubbing.
 */
export function coalesceCacheBarRanges(
  ranges: ReadonlyArray<CacheTimeRange>,
  fps: number,
  pixelsPerSecond: number,
  maxGapFrames = 2,
): CacheTimeRange[] {
  if (ranges.length <= 1) return ranges.length ? [...ranges] : [];
  const maxGapSec = maxGapFrames / Math.max(fps, 1);
  const out: CacheTimeRange[] = [];
  let cur = { start: ranges[0]!.start, end: ranges[0]!.end };
  for (let i = 1; i < ranges.length; i++) {
    const next = ranges[i]!;
    const gapSec = next.start - cur.end;
    const gapPx = gapSec * pixelsPerSecond;
    if (gapSec <= maxGapSec + 1e-9 || gapPx <= 1.5) {
      cur.end = Math.max(cur.end, next.end);
    } else {
      out.push(cur);
      cur = { start: next.start, end: next.end };
    }
  }
  out.push(cur);
  return out;
}

/**
 * Convert cached time spans into pixel-snapped bar segments.
 *
 * Sub-pixel `left`/`width` math leaves hairline gaps between consecutive
 * spans at some zoom levels; rounding + a 1px bridge keeps the bar reading
 * as one continuous strip when the underlying cache is contiguous.
 */
export function layoutCacheBarSegments(
  ranges: ReadonlyArray<CacheTimeRange>,
  pixelsPerSecond: number,
  leftOffset: number,
): CacheBarSegment[] {
  if (ranges.length === 0 || pixelsPerSecond <= 0) return [];

  const raw = ranges.map((r) => ({
    left: leftOffset + r.start * pixelsPerSecond,
    right: leftOffset + r.end * pixelsPerSecond,
  }));

  const out: CacheBarSegment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i]!;
    let left = Math.floor(cur.left);
    let right = Math.ceil(cur.right);
    if (i + 1 < raw.length) {
      const nextLeft = Math.floor(raw[i + 1]!.left);
      if (nextLeft > right && nextLeft - right <= 1) right = nextLeft;
    }
    out.push({ left, width: Math.max(1, right - left) });
  }
  return out;
}
