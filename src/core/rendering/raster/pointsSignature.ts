/**
 * The points half of a path's raster-cache key, memoised by the identity of
 * the point array — NATIVE_CORE_PLAN §4 T3 "raster cache keys memoised per
 * node revision instead of JSON.stringify per frame".
 *
 * ── Where this hits, measured ───────────────────────────────────────────────
 *
 * `buildSnapshot` hands a static outline through to `layer.pathPoints` AS the
 * scene's own `Geometry.props.points` array (line ~3072: `staticPathPoints =
 * geomComponent.props.points`, then `pathPoints: pathPoints` on the layer
 * literal). Probed over three frames of the `animated-paths-300` bench scene:
 * 600/600 layer-frames kept the same array object. That array is exactly the
 * expensive part of `pathRasterSignature` — six floats per vertex through
 * `Number#toString` — and it is the part that does NOT change when only the
 * transform animates, which is the case the `RasterReuse` fast path misses
 * whenever any OTHER property (a stroke width, a fill) animates too.
 *
 * Everything else the key stringifies (`effects`, `mask.paths`, `fillPaint`,
 * text `glyphs`/`runs`/`textPath`/`textExtras`) is a fresh object per frame —
 * resolved from tracks, never the scene's own object — so a memo on those
 * would miss every frame and only add WeakMap churn. Same probe: 0 identity
 * hits for each. They stay as they are.
 *
 * ── Why identity alone is not trusted ───────────────────────────────────────
 *
 * The scene has write paths that mutate nested `props` arrays in place without
 * replacing them (the reason `snapshotSharing.ts` compares content rather than
 * revision counters), and the pen tool's drag reads `geom.props.points` back
 * out of the node. A memo that returned the cached string for "same array"
 * would serve a stale key after such a write — the texture would freeze. So
 * the entry stores a content hash of the array (two independent 32-bit
 * word-mixed FNV lanes over the Float64 bits of every coordinate) and is
 * honoured only when the hash still matches. The hash is an INVALIDATION
 * signal, never part of the key: a false "changed" just rebuilds the same
 * string, and the only failure mode left is a 64-bit collision on an in-place
 * edit of an unchanged-identity array.
 *
 * Hashing 6n floats is an order of magnitude cheaper than formatting them
 * (`contentHash.ts` measured the same trade for the layer digest), which is
 * the whole saving. The string produced is byte-identical to the inline
 * expression it replaced — `pathRasterSignature`'s test pins that against an
 * unmemoised rebuild, including after an in-place mutation.
 *
 * Pure apart from the cache; no DOM, no clock.
 */

import type { BezierPoint } from '../../../../packages/workspace/src/math/BezierPoint';

interface Entry {
  h1: number;
  h2: number;
  sig: string;
}

const memo = new WeakMap<ReadonlyArray<BezierPoint>, Entry>();

// Bound once — the same jest vm-context global lookup cost contentHash.ts
// documents; identical results either way.
const imul = Math.imul;
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** Hits and misses since the last reset, for the memo's tests and the bench. */
export const pointsSignatureStats = { hit: 0, miss: 0, stale: 0 };
export function resetPointsSignatureStats(): void {
  pointsSignatureStats.hit = 0;
  pointsSignatureStats.miss = 0;
  pointsSignatureStats.stale = 0;
}

/**
 * `points.map(p => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|')`
 * — the exact string, memoised on the array's identity + content hash.
 */
export function pointsSignature(points: ReadonlyArray<BezierPoint>): string {
  // Two lanes with different seeds and multipliers so an in-place edit that
  // collides in one still turns the other over.
  let h1 = 0x811c9dc5;
  let h2 = 0x27d4eb2f;
  h1 = imul(h1 ^ points.length, 0x01000193);
  h2 = imul(h2 ^ points.length, 0x9e3779b1);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    f64[0] = p.x; h1 = imul(h1 ^ u32[0]!, 0x01000193); h1 = imul(h1 ^ u32[1]!, 0x01000193); h2 = imul(h2 ^ u32[0]!, 0x9e3779b1); h2 = imul(h2 ^ u32[1]!, 0x9e3779b1);
    f64[0] = p.y; h1 = imul(h1 ^ u32[0]!, 0x01000193); h1 = imul(h1 ^ u32[1]!, 0x01000193); h2 = imul(h2 ^ u32[0]!, 0x9e3779b1); h2 = imul(h2 ^ u32[1]!, 0x9e3779b1);
    f64[0] = p.inX; h1 = imul(h1 ^ u32[0]!, 0x01000193); h1 = imul(h1 ^ u32[1]!, 0x01000193); h2 = imul(h2 ^ u32[0]!, 0x9e3779b1); h2 = imul(h2 ^ u32[1]!, 0x9e3779b1);
    f64[0] = p.inY; h1 = imul(h1 ^ u32[0]!, 0x01000193); h1 = imul(h1 ^ u32[1]!, 0x01000193); h2 = imul(h2 ^ u32[0]!, 0x9e3779b1); h2 = imul(h2 ^ u32[1]!, 0x9e3779b1);
    f64[0] = p.outX; h1 = imul(h1 ^ u32[0]!, 0x01000193); h1 = imul(h1 ^ u32[1]!, 0x01000193); h2 = imul(h2 ^ u32[0]!, 0x9e3779b1); h2 = imul(h2 ^ u32[1]!, 0x9e3779b1);
    f64[0] = p.outY; h1 = imul(h1 ^ u32[0]!, 0x01000193); h1 = imul(h1 ^ u32[1]!, 0x01000193); h2 = imul(h2 ^ u32[0]!, 0x9e3779b1); h2 = imul(h2 ^ u32[1]!, 0x9e3779b1);
  }
  const hit = memo.get(points);
  if (hit !== undefined) {
    if (hit.h1 === h1 && hit.h2 === h2) {
      pointsSignatureStats.hit++;
      return hit.sig;
    }
    pointsSignatureStats.stale++;
  } else {
    pointsSignatureStats.miss++;
  }
  // Byte-for-byte the expression this replaced in pathRasterSignature.
  const sig = points.map((p) => `${p.x},${p.y},${p.inX},${p.inY},${p.outX},${p.outY}`).join('|');
  memo.set(points, { h1, h2, sig });
  return sig;
}
