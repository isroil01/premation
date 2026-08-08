/**
 * Offset a polyline by a PER-VERTEX distance — the shared half of DECISION D4.
 *
 * ## Why this is here and not in the brush tool
 *
 * This arithmetic already existed, inside `ribbonOutline` in
 * `packages/workspace/src/tools/builtin.ts`, under a brush-tool filename and
 * invisible to anyone searching the renderer for "taper". It is the mechanism
 * two separate features need:
 *
 *   • STROKE TAPER consumes the two offsets as one closed outline to FILL,
 *     because Canvas2D strokes at a single `lineWidth` and cannot vary it.
 *   • VARIABLE-WIDTH MASK FEATHER consumes them as two boundaries bounding a
 *     shaded band.
 *
 * D4's decision was one shared GEOMETRY primitive and two separate consumers —
 * not one mechanism producing either shape behind a flag, which would be two
 * features wearing one name (§2·0).
 *
 * It lives in `@motion/scene` because that package is "pure data + systems, no
 * rendering", and both the tool layer and the rasterizer can import it. Leaving
 * it in `packages/workspace` would have made a renderer-side taper depend on the
 * INTERACTION package — a layering inversion, and the reason this extraction is
 * a prerequisite rather than cleanup.
 *
 * ## What is deliberately NOT here
 *
 * Everything policy-shaped stays with its caller: the brush's pressure
 * normalisation, its arc-length taper profile, its width floor and its 1.4×
 * clamp are all brush decisions, not geometry. This function takes a distance
 * per vertex and asks no questions about where it came from.
 *
 * Also not here: bezier flattening. Callers hand in points they have already
 * sampled, because how finely to flatten is a quality/cost decision that
 * differs between a live brush stroke and an authored vector path.
 */

export interface OffsetPoint {
  x: number;
  y: number;
}

export interface OffsetSides {
  /** Offset by +distance along the left normal, in input order. */
  left: OffsetPoint[];
  /** Offset by −distance, also in INPUT order (callers reverse if they close). */
  right: OffsetPoint[];
}

/**
 * Offset each point along the local normal by `distanceAt(i)`.
 *
 * The normal is taken from the CENTRED difference of the neighbours
 * (`next − prev`), clamped at the ends, which is what keeps a corner from
 * producing two wildly different normals on its two sides. `left` is the +90°
 * side of the direction of travel: for a path running +x, left is −y.
 *
 * `distanceAt` is a DISTANCE, not a width. A stroke of width w passes `w / 2`;
 * a feather band passes its own reach. Making the caller halve it is deliberate
 * — "width" is a stroke concept and this primitive serves more than strokes.
 *
 * Degenerate input is survived rather than rejected: a zero-length tangent
 * (coincident neighbours) falls back to a unit length so the result is a
 * duplicated point rather than NaN, which is what a caller's smoothing step can
 * absorb. Fewer than two points returns empty — there is no direction of travel
 * to take a normal from.
 */
export function offsetAlongNormals(
  points: readonly OffsetPoint[],
  distanceAt: (index: number) => number,
): OffsetSides {
  const n = points.length;
  if (n < 2) return { left: [], right: [] };

  const left: OffsetPoint[] = [];
  const right: OffsetPoint[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(n - 1, i + 1)]!;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    // `|| 1` guards the coincident-neighbour case; see the header.
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const d = distanceAt(i);
    const p = points[i]!;
    left.push({ x: p.x + nx * d, y: p.y + ny * d });
    right.push({ x: p.x - nx * d, y: p.y - ny * d });
  }
  return { left, right };
}

/**
 * The closed ring around a variable-width centreline: left side forward, right
 * side back.
 *
 * Shared because BOTH prospective consumers need this exact walk — a tapered
 * stroke fills it, and a feather band is bounded by it. Kept separate from
 * `offsetAlongNormals` so a caller that wants only one boundary (an inner
 * feather edge, say) is not forced to build and discard the other.
 */
export function closedRibbon(sides: OffsetSides): OffsetPoint[] {
  if (sides.left.length === 0) return [];
  return [...sides.left, ...[...sides.right].reverse()];
}
