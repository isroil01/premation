/**
 * Trim Paths — reveal only a portion of a shape's
 * outline, animatable to draw the stroke on/off. Start/End/Offset are percents
 * of the path length; Offset rotates the visible window around the path (and
 * wraps). Keyframe Offset for a snake-around-the-shape; keyframe End 0→100 to
 * "write on" the stroke.
 *
 * PURE GEOMETRY ONLY. Trim's scene integration used to live here — `fx.trim`,
 * `trim.<param>` keyframe paths, `setTrim`/`updateTrim`. It moved into
 * `pathOps.ts` in document version 1.4.0, where trim is an ordinary entry in
 * the ordered `fx.pathOps` chain and its keyframes are id-scoped like every
 * other operator's. That is what makes its position in the stack meaningful:
 * trimming before or after a deform gives different geometry.
 *
 * {@link trimSegments} turns the percents into 0..2 normalized arcs, and
 * {@link trimPolyline} slices a polyline by those arcs. Both are consumed by
 * `applyPathOpChain`.
 */

export interface Pt {
  x: number;
  y: number;
}

// ── Pure geometry (tested) ───────────────────────────────────────────

/**
 * Normalized visible arcs [lo,hi] (each in [0,1]) for a start/end/offset in
 * percent. Returns [] when the window is empty, one arc normally, or two when
 * the offset makes it wrap past the end of the path. Pure.
 */
export function trimSegments(startPct: number, endPct: number, offsetPct: number): Array<[number, number]> {
  const s = startPct / 100;
  const e = endPct / 100;
  const o = offsetPct / 100;
  const len = e - s;
  if (len <= 0) return [];
  if (len >= 1) return [[0, 1]];
  const a = (((s + o) % 1) + 1) % 1; // window start, wrapped into [0,1)
  const b = a + len;
  if (b <= 1) return [[a, b]];
  return [
    [a, 1],
    [0, b - 1],
  ];
}

function segLengths(pts: readonly Pt[], closed: boolean): { lens: number[]; total: number } {
  const n = pts.length;
  const count = closed ? n : n - 1;
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    lens.push(d);
    total += d;
  }
  return { lens, total };
}

/** Point at arc-length `len` along the polyline (clamped to the ends). */
export function pointAtLength(pts: readonly Pt[], closed: boolean, len: number): Pt {
  const n = pts.length;
  const count = closed ? n : n - 1;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + d >= len) {
      const t = d > 0 ? (len - acc) / d : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += d;
  }
  return pts[closed ? 0 : n - 1]!;
}

/**
 * A polyline's cumulative arc lengths, built once and sampled many times.
 *
 * `pointAtLength` walks from the start on every call, which is fine for trim
 * (a few lookups per frame) and quadratic for text on a path (one lookup per
 * glyph per frame). This trades a small allocation for a binary search.
 */
export interface ArcTable {
  pts: readonly Pt[];
  closed: boolean;
  /** `cum[i]` is the arc length at vertex `i`; the last entry is the total. */
  cum: number[];
  total: number;
}

export function arcTable(pts: readonly Pt[], closed: boolean): ArcTable {
  const { lens, total } = segLengths(pts, closed);
  const cum: number[] = [0];
  for (const d of lens) cum.push(cum[cum.length - 1]! + d);
  return { pts, closed, cum, total };
}

/**
 * Point AND heading at arc-length `len`.
 *
 * The heading is what text on a path needs and what {@link pointAtLength}
 * cannot give: it computes the segment direction to interpolate and then
 * discards it.
 *
 * Off the ends: a closed path wraps; an open path **extrapolates** along the
 * end tangent rather than clamping. Clamping would pile every overflowing
 * glyph on the final vertex — a legible run of text sliding off the end is a
 * better answer than a smudge, and it matches what a margin control implies.
 */
export function pointAndTangentAtLength(
  table: ArcTable,
  len: number,
): { x: number; y: number; angle: number } {
  const { pts, closed, cum, total } = table;
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0, angle: 0 };
  if (n === 1 || total <= 0) return { x: pts[0]!.x, y: pts[0]!.y, angle: 0 };

  const count = closed ? n : n - 1;
  let target = len;
  if (closed) {
    target = ((len % total) + total) % total;
  }

  const segAt = (i: number): { a: Pt; b: Pt; d: number } => {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    return { a, b, d: cum[i + 1]! - cum[i]! };
  };
  const at = (i: number, t: number): { x: number; y: number; angle: number } => {
    const { a, b } = segAt(i);
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  };

  // Off an open path: extrapolate along the first/last segment's direction.
  if (!closed && target < 0) return at(0, target / (segAt(0).d || 1));
  if (!closed && target > total) {
    const i = count - 1;
    const { d } = segAt(i);
    return at(i, 1 + (target - total) / (d || 1));
  }

  // Binary search for the segment containing `target`.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  const { d } = segAt(lo);
  return at(lo, d > 0 ? (target - cum[lo]!) / d : 0);
}

/**
 * Slice an outline polyline into the visible sub-polylines for `segments`.
 * Each sub-polyline starts/ends at the exact arc-length boundary and includes
 * the original vertices in between. Pure.
 */
export function trimPolyline(
  pts: readonly Pt[],
  closed: boolean,
  segments: ReadonlyArray<readonly [number, number]>,
): Pt[][] {
  if (pts.length < 2) return [];
  const { total } = segLengths(pts, closed);
  if (total <= 0) return [];
  const n = pts.length;
  const count = closed ? n : n - 1;

  const out: Pt[][] = [];
  for (const [lo, hi] of segments) {
    const startLen = lo * total;
    const endLen = hi * total;
    if (endLen <= startLen) continue;
    const sub: Pt[] = [pointAtLength(pts, closed, startLen)];
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const b = pts[(i + 1) % n]!;
      acc += Math.hypot(b.x - pts[i]!.x, b.y - pts[i]!.y);
      if (acc > startLen && acc < endLen) sub.push({ x: b.x, y: b.y });
    }
    sub.push(pointAtLength(pts, closed, endLen));
    out.push(sub);
  }
  return out;
}
