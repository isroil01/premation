/**
 * Graph value↔pixel projection, and the frozen "reference" curves drawn behind
 * the live ones.
 *
 * The reference graph answers the question an edit always raises — "is this
 * better than what I had?" — by keeping a dashed ghost of every visible curve
 * as it stood when the toggle went on. Two decisions make it trustworthy:
 *
 *  • it snapshots the SAMPLED POLYLINE, not the keyframes. A ghost re-derived
 *    from the data being edited would move with every drag, which is precisely
 *    what a reference must never do;
 *  • the snapshot is in DATA space — [comp seconds, plotted value] — so zoom,
 *    scroll and a re-fitted vertical range move the ghost with its curve
 *    instead of leaving it stranded at yesterday's pixels.
 */

/** Plotted value → y within a graph of height `h` (svg y grows downward). */
export function valueToY(val: number, min: number, max: number, h: number): number {
  if (max === min) return h / 2;
  return h - ((val - min) / (max - min)) * h;
}

/** The inverse of `valueToY`. */
export function yToValue(y: number, min: number, max: number, h: number): number {
  return min + (1 - y / h) * (max - min);
}

/** A curve frozen for comparison: the sampled polyline in data space. */
export interface ReferenceCurve {
  points: ReadonlyArray<readonly [number, number]>;
}

/** Data-space polyline → svg path data. Empty input yields an empty string. */
export function polylinePath(
  points: ReadonlyArray<readonly [number, number]>,
  pixelsPerSecond: number,
  min: number,
  max: number,
  h: number,
): string {
  if (points.length === 0) return '';
  return `M${points
    .map(([t, v]) => `${(t * pixelsPerSecond).toFixed(2)},${valueToY(v, min, max, h).toFixed(2)}`)
    .join('L')}`;
}

/**
 * Freeze the curves currently plotted, keyed by track.
 *
 * The point arrays are stored by reference: the sampler builds a fresh array
 * on every pass and never mutates a previous one, so the snapshot is already
 * immutable in practice — copying them would only cost memory proportional to
 * the number of visible curves times their sample count.
 */
export function snapshotReferenceCurves<
  T extends { nodeId: string; prop: string; samples: ReadonlyArray<readonly [number, number]> },
>(paths: ReadonlyArray<T>, key: (nodeId: string, prop: string) => string): Map<string, ReferenceCurve> {
  const out = new Map<string, ReferenceCurve>();
  for (const p of paths) out.set(key(p.nodeId, p.prop), { points: p.samples });
  return out;
}
