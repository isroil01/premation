/**
 * Bitmap → outlines. The shared core under Auto-trace and Create Shapes From
 * Text: an alpha (or luma) plane in, a list of closed contours out, each
 * simplified to the fewest vertices that stay within a pixel tolerance.
 *
 * ## Algorithm
 *
 * 1. Threshold to a binary mask.
 * 2. Border-follow every connected region (Suzuki–Abe style: outer borders
 *    AND hole borders), walking pixel EDGES rather than pixel centres so a
 *    one-pixel-wide stroke still yields a ring with area.
 * 3. Ramer–Douglas–Peucker simplification, tolerance in pixels.
 *
 * Holes come back as separate contours with `hole: true` — a letter's
 * counter, a donut's middle. A consumer that cannot represent holes (a mask
 * path) gets the outer rings; one that can (a Geometry with subpaths) gets
 * both, and the renderer's even-odd fill does the rest.
 *
 * Pure, allocation-light, no DOM. Corner vertices are emitted as corners —
 * smoothing a traced glyph into curves is a separate, opt-in step
 * (`smoothContour`), because a traced rectangle that comes back with rounded
 * corners has lost information the tracer actually had.
 */

export interface TracePoint { x: number; y: number }

export interface TracedContour {
  points: TracePoint[];
  /** True for an inner border (the region's hole), false for an outer one. */
  hole: boolean;
}

export interface TraceOptions {
  /** 0..255 alpha at or above which a pixel is "inside". Default 128. */
  threshold?: number;
  /** RDP tolerance in pixels. Default 1. 0 keeps every edge vertex. */
  tolerance?: number;
  /** Drop contours with fewer pixels of area than this. Default 4. */
  minArea?: number;
}

// ── Binary mask with a one-pixel border so neighbour lookups never bounds-check ──

function toMask(src: Uint8Array | Uint8ClampedArray, w: number, h: number, stride: number, threshold: number): Uint8Array {
  const mw = w + 2;
  const mask = new Uint8Array(mw * (h + 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src[(y * w + x) * stride + (stride - 1)]! >= threshold) mask[(y + 1) * mw + (x + 1)] = 1;
    }
  }
  return mask;
}

/**
 * Trace the boundary of the region containing (sx, sy), walking the pixel
 * edges clockwise (outer) or counter-clockwise (hole). Returns vertices on
 * the pixel grid (integer corners) in IMAGE coordinates, and marks every
 * visited boundary pixel in `visited` so the scan does not re-trace it.
 *
 * Edge-following on a 4-connected crack boundary: at each step we stand on a
 * grid corner with a direction; the two pixels ahead decide turn left,
 * straight, or turn right. Classic "square tracing" with the inside kept on
 * the right hand.
 */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

function followEdges(
  mask: Uint8Array,
  mw: number,
  startX: number,
  startY: number,
  startDir: number,
  visited: Uint8Array,
): TracePoint[] {
  // Directions: 0 = +x, 1 = +y, 2 = −x, 3 = −y. Position is a grid CORNER
  // (cx, cy); pixel (px, py) occupies corners [px, px+1] × [py, py+1].
  const inside = (px: number, py: number): boolean => mask[py * mw + px] === 1;
  const pts: TracePoint[] = [];
  let cx = startX, cy = startY, dir = startDir;
  let guard = mw * mw * 4;
  // The start corner is a vertex by construction (the scan picked it where
  // the boundary turns), so it is pushed unconditionally; every later corner
  // is pushed only when the heading changes there — a straight run of edges
  // is one segment, not one vertex per pixel.
  let first = true;
  do {
    // Inside on the RIGHT as we walk. The two pixels ahead of this corner —
    // one on each side of the heading — decide the turn; see AHEAD.
    const ahead = AHEAD[dir]!;
    const R = inside(cx + ahead.rx, cy + ahead.ry);
    const L = inside(cx + ahead.lx, cy + ahead.ly);
    const before = dir;
    if (R && !L) {
      // straight on
    } else if (R && L) {
      dir = (dir + 3) & 3; // concave corner: turn left
    } else {
      // !R: convex corner (or a diagonal touch, which we also treat as a
      // convex turn so two regions meeting at a point stay two regions).
      dir = (dir + 1) & 3;
    }
    if (first || dir !== before) pts.push({ x: cx, y: cy });
    first = false;
    // Mark the inside pixel on our right as a visited boundary pixel.
    const a = AHEAD[dir]!;
    visited[(cy + a.ry) * mw + (cx + a.rx)] = 1;
    cx += DX[dir]!;
    cy += DY[dir]!;
  } while ((cx !== startX || cy !== startY) && --guard > 0);
  return pts;
}

/**
 * For a walker at corner (cx, cy) heading `dir`, the pixel just ahead on its
 * RIGHT and on its LEFT, as corner-relative offsets. Pixel (px,py) has its
 * top-left corner at (px,py).
 */
const AHEAD: ReadonlyArray<{ rx: number; ry: number; lx: number; ly: number }> = [
  { rx: 0, ry: 0, lx: 0, ly: -1 },   // +x: right = below the edge, left = above
  { rx: -1, ry: 0, lx: 0, ly: 0 },   // +y: right = left of the edge
  { rx: -1, ry: -1, lx: -1, ly: 0 }, // −x
  { rx: 0, ry: -1, lx: -1, ly: -1 }, // −y
];

/** Signed area (shoelace); positive = clockwise in y-down image space. */
function signedArea(pts: ReadonlyArray<TracePoint>): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i]!, q = pts[(i + 1) % n]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// ── Ramer–Douglas–Peucker on a closed ring ──────────────────────────

function perpDist(p: TracePoint, a: TracePoint, b: TracePoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rdpOpen(pts: ReadonlyArray<TracePoint>, eps: number, out: TracePoint[]): void {
  if (pts.length < 3) { for (const p of pts) out.push(p); return; }
  let maxD = 0, idx = 0;
  const a = pts[0]!, b = pts[pts.length - 1]!;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i]!, a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    rdpOpen(pts.slice(0, idx + 1), eps, out);
    out.pop();
    rdpOpen(pts.slice(idx), eps, out);
  } else {
    out.push(a, b);
  }
}

/** Simplify a closed ring: split at the two most distant vertices, RDP each half. */
export function simplifyRing(pts: ReadonlyArray<TracePoint>, eps: number): TracePoint[] {
  if (eps <= 0 || pts.length <= 4) return [...pts];
  // Anchor at the vertex farthest from the first; that pair is a sound split.
  let far = 0, farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]!.x - pts[0]!.x, pts[i]!.y - pts[0]!.y);
    if (d > farD) { farD = d; far = i; }
  }
  const half1 = pts.slice(0, far + 1);
  const half2 = [...pts.slice(far), pts[0]!];
  const out: TracePoint[] = [];
  rdpOpen(half1, eps, out);
  out.pop();
  rdpOpen(half2, eps, out);
  out.pop(); // the repeated start
  // Drop collinear survivors the split may have left at the seams.
  return out.filter((p, i, arr) => {
    const a = arr[(i + arr.length - 1) % arr.length]!, b = arr[(i + 1) % arr.length]!;
    return perpDist(p, a, b) > 1e-6;
  });
}

/**
 * Trace every region in an 8-bit plane.
 *
 * `stride` is the bytes per pixel and the value is read from the LAST byte of
 * each pixel — 1 for a luma/alpha plane, 4 for RGBA (alpha). Coordinates are
 * image pixels with (0,0) at the top-left corner of the top-left pixel.
 */
export function traceBitmap(
  src: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  stride: 1 | 4 = 1,
  opts: TraceOptions = {},
): TracedContour[] {
  const threshold = opts.threshold ?? 128;
  const tolerance = opts.tolerance ?? 1;
  const minArea = opts.minArea ?? 4;
  const mw = w + 2;
  const mask = toMask(src, w, h, stride, threshold);
  const visitedOuter = new Uint8Array(mask.length);
  const visitedHole = new Uint8Array(mask.length);
  const out: TracedContour[] = [];

  // Raster scan. An OUTER border starts where a row goes outside→inside with
  // the pixel above the start corner outside; a HOLE border where it goes
  // inside→outside. Each boundary pixel is visited once per border kind.
  for (let py = 1; py <= h; py++) {
    for (let px = 1; px <= w; px++) {
      const here = mask[py * mw + px] === 1;
      const left = mask[py * mw + px - 1] === 1;
      // `!visitedHole` too: the inside pixel just right of a hole also reads
      // as "inside with outside on its left", but it is a hole-border pixel
      // and the hole walk — which started at the hole's left edge earlier on
      // this same row — has already marked it.
      if (here && !left && !visitedOuter[py * mw + px] && !visitedHole[py * mw + px]) {
        // Outer border: from the pixel's top-left corner heading +x along its
        // top edge — the pixel itself is then on the walker's right.
        const pts = followEdges(mask, mw, px, py, 0, visitedOuter);
        visitedOuter[py * mw + px] = 1;
        const ring = pts.map((p) => ({ x: p.x - 1, y: p.y - 1 }));
        if (Math.abs(signedArea(ring)) < minArea) continue;
        out.push({ points: simplifyRing(ring, tolerance), hole: false });
      } else if (!here && left && !visitedHole[py * mw + px - 1]) {
        // Hole border: the pixel to the left is inside, this one is a hole
        // (or the outside). Only a hole if the run is enclosed: walking the
        // border with inside on the right and checking orientation tells us.
        // Heading +y down the edge between them keeps the inside pixel (to
        // the west) on the right.
        const pts = followEdges(mask, mw, px, py, 1, visitedHole);
        visitedHole[py * mw + px - 1] = 1;
        const ring = pts.map((p) => ({ x: p.x - 1, y: p.y - 1 }));
        const area = signedArea(ring);
        if (Math.abs(area) < minArea) continue;
        // The outside of the whole image traced from this seed comes back as
        // a counter-clockwise ring around the region's OUTER edge — the same
        // ring the outer pass emits. Skip those by orientation: a hole walked
        // with inside-on-right is clockwise-negative in y-down space.
        if (area > 0) continue;
        out.push({ points: simplifyRing(ring, tolerance), hole: true });
      }
    }
  }
  return out;
}

/**
 * Turn a polygon into a smooth closed Bézier (Catmull–Rom tangents), for the
 * consumers that want a traced letterform to read as a curve rather than a
 * polyline. `tension` 0 = straight segments, 1 = fully rounded.
 */
export function smoothContour(
  pts: ReadonlyArray<TracePoint>,
  tension = 0.5,
): Array<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }> {
  const n = pts.length;
  const k = tension / 3; // Catmull-Rom → Bézier handle factor at tension 1 is 1/6 per side; /3 reads better for traced art
  return pts.map((p, i) => {
    const prev = pts[(i + n - 1) % n]!, next = pts[(i + 1) % n]!;
    const tx = (next.x - prev.x) * k, ty = (next.y - prev.y) * k;
    return { x: p.x, y: p.y, inX: p.x - tx, inY: p.y - ty, outX: p.x + tx, outY: p.y + ty };
  });
}
