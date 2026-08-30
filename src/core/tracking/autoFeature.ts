/**
 * "What should we track?" — the half of one-click tracking the user is
 * normally made to answer by dragging a box onto the footage.
 *
 * A tracker's whole failure surface is decided BEFORE the first match:
 * a point on a flat wall has no unique correlation peak at all, a point on a
 * straight edge has a peak that is free to slide ALONG the edge (the aperture
 * problem), and a point on a brick wall has a hundred equally good peaks and
 * will hop between them. Handing those to `tracker.ts` produces a confident,
 * smoothly interpolated, completely wrong track — the worst possible output.
 * So this module refuses to guess: it measures.
 *
 * THREE MEASUREMENTS, in increasing cost, applied to fewer candidates each:
 *
 *  1. STRENGTH (every candidate, O(1) each) — the Shi-Tomasi minimum
 *     eigenvalue of the windowed structure tensor. Both eigenvalues large
 *     means the intensity surface curves in BOTH directions, which is the
 *     formal statement of "this patch pins down x and y". The minimum is
 *     taken rather than the sum precisely because an edge scores well on the
 *     sum and must not: one large eigenvalue and one near-zero is exactly the
 *     feature that slides. Windowed sums come from integral images over the
 *     scanned region, so window size costs nothing.
 *
 *  2. DISTINCTNESS (top handful only, ~60 NCC probes each) — the patch
 *     correlated against its own neighbourhood at a distance. A real feature
 *     beats every rival nearby; periodic texture does not, and its rival peak
 *     is what a tracker jumps to on the frame its prediction is a pixel off.
 *     Strength cannot see this — a brick corner is a textbook strong corner.
 *
 *  3. SCALE (the winner only) — the smallest window that still resolves the
 *     feature. Smaller windows are faster AND deform less under rotation and
 *     perspective, so taking the smallest window that works is both a quality
 *     and a speed decision, not a trade between them.
 *
 * Everything here is pure: planes in, numbers out, no decoder and no scene.
 * `autoTrack.ts` is what turns the answer into a track.
 */

import { extractPatch, ncc, type LumaPlane } from './patchMatch';

/** Window half-sizes offered to `suggestFeatureHalf`, smallest first. */
const SCALE_LADDER = [6, 8, 10, 13, 16] as const;

/** Candidate window half-size used while SCANNING (before scale selection). */
const SCAN_HALF = 8;

/** Grid step between scanned candidate centres, in px. Half of SCAN_HALF —
 *  fine enough that no corner falls between samples, coarse enough that a
 *  4K tile is a few thousand candidates rather than a few million. */
const SCAN_STRIDE = 4;

/** How many strength-ranked candidates pay for a distinctness probe. */
const DISTINCTNESS_SHORTLIST = 8;

/** Window half-size used to LOCALIZE a shortlisted candidate (see `refine`). */
const REFINE_HALF = 4;

/** Below this the region is flat or edge-only and nothing is trackable. */
const MIN_USABLE_STRENGTH = 1e-5;

/**
 * Distinctness floor. A rival scoring a perfect 1.0 happens on synthetic
 * grids and effectively never on real footage, and refusing outright to track
 * a tiled floor or a window grid is worse than tracking it with a tightened
 * search window and telling the user it is ambiguous. The floor keeps such a
 * feature ranked last without erasing it.
 */
const MIN_DISTINCTNESS = 0.05;

export interface FeatureCandidate {
  /** Feature centre in plane pixels. */
  x: number;
  y: number;
  /**
   * Shi-Tomasi min-eigenvalue of the structure tensor, per pixel of window,
   * on a 0..1 luma scale. Roughly "squared contrast gradient in the weaker
   * direction" — comparable across planes and window sizes.
   */
  strength: number;
  /**
   * 1 = nothing else nearby looks like this; 0 = an equally good rival sits
   * inside the search window and the tracker will eventually take it.
   * Only computed for shortlisted candidates; others report 1.
   */
  distinctness: number;
  /** `strength × distinctness × proximity` — the ranking key. */
  score: number;
}

export interface PickFeatureOptions {
  /**
   * Where the user pointed, in plane px. The search is centred here and
   * biased toward it, so a click near a mediocre feature snaps to that one
   * rather than to the strongest feature on the far side of the frame.
   */
  hint?: { x: number; y: number };
  /** Search radius around `hint` in px. Default: 12% of the short side. */
  radius?: number;
  /** Keep candidates this far from the plane edge. Default 24. */
  margin?: number;
}

/** Integer read, clamped at the borders. Uint8 planes are rescaled to 0..1 so
 *  strengths are comparable whatever the decoder handed us (see LumaPlane). */
function reader(plane: LumaPlane): (x: number, y: number) => number {
  const { data, width, height } = plane;
  const k = data instanceof Uint8Array ? 1 / 255 : 1;
  return (x, y) => {
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return data[cy * width + cx]! * k;
  };
}

/** An inclusive pixel box. Exported so callers can narrow a feature sweep. */
export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function clampRegion(r: Region, plane: LumaPlane, margin: number): Region | null {
  const x0 = Math.max(margin, Math.floor(r.x0));
  const y0 = Math.max(margin, Math.floor(r.y0));
  const x1 = Math.min(plane.width - 1 - margin, Math.ceil(r.x1));
  const y1 = Math.min(plane.height - 1 - margin, Math.ceil(r.y1));
  return x1 < x0 || y1 < y0 ? null : { x0, y0, x1, y1 };
}

/**
 * Strength for every candidate centre on a stride grid inside `region`.
 *
 * The gradients and their three integral images cover the region PLUS a
 * `half` halo, so every window is fully inside the buffers and the inner loop
 * needs no bounds test. Memory is O(region), never O(frame) — a full-frame
 * scan tiles instead (see `pickFeatures`), because Float64 integral images
 * over a 4K plane would be 200 MB and lose the point of being fast.
 */
function scanRegion(
  plane: LumaPlane,
  region: Region,
  half: number,
  stride: number,
): FeatureCandidate[] {
  const at = reader(plane);
  // Padded box: candidate centres ± half, plus 1 for the central difference.
  const bx = region.x0 - half - 1;
  const by = region.y0 - half - 1;
  const bw = region.x1 - region.x0 + 2 * half + 3;
  const bh = region.y1 - region.y0 + 2 * half + 3;

  // Structure-tensor products over the padded box. One pass, no allocation
  // per candidate — this is the loop that decides whether a full-frame scan
  // is 100 ms or 3 s.
  const gxx = new Float64Array(bw * bh);
  const gxy = new Float64Array(bw * bh);
  const gyy = new Float64Array(bw * bh);
  for (let j = 0; j < bh; j++) {
    const py = by + j;
    for (let i = 0; i < bw; i++) {
      const px = bx + i;
      const dx = (at(px + 1, py) - at(px - 1, py)) * 0.5;
      const dy = (at(px, py + 1) - at(px, py - 1)) * 0.5;
      const k = j * bw + i;
      gxx[k] = dx * dx;
      gxy[k] = dx * dy;
      gyy[k] = dy * dy;
    }
  }

  // Integral images (one leading zero row/col) → O(1) window sums.
  const iw = bw + 1;
  const ih = bh + 1;
  const sxx = new Float64Array(iw * ih);
  const sxy = new Float64Array(iw * ih);
  const syy = new Float64Array(iw * ih);
  for (let j = 0; j < bh; j++) {
    let rxx = 0;
    let rxy = 0;
    let ryy = 0;
    for (let i = 0; i < bw; i++) {
      const k = j * bw + i;
      rxx += gxx[k]!;
      rxy += gxy[k]!;
      ryy += gyy[k]!;
      const o = (j + 1) * iw + (i + 1);
      const up = j * iw + (i + 1);
      sxx[o] = sxx[up]! + rxx;
      sxy[o] = sxy[up]! + rxy;
      syy[o] = syy[up]! + ryy;
    }
  }
  const windowSum = (s: Float64Array, i0: number, j0: number, i1: number, j1: number): number =>
    s[(j1 + 1) * iw + (i1 + 1)]! - s[j0 * iw + (i1 + 1)]! - s[(j1 + 1) * iw + i0]! + s[j0 * iw + i0]!;

  const area = (2 * half + 1) ** 2;
  const out: FeatureCandidate[] = [];
  for (let y = region.y0; y <= region.y1; y += stride) {
    for (let x = region.x0; x <= region.x1; x += stride) {
      const i0 = x - half - bx;
      const j0 = y - half - by;
      const i1 = i0 + 2 * half;
      const j1 = j0 + 2 * half;
      const a = windowSum(sxx, i0, j0, i1, j1) / area;
      const b = windowSum(sxy, i0, j0, i1, j1) / area;
      const c = windowSum(syy, i0, j0, i1, j1) / area;
      // Smaller eigenvalue of [[a,b],[b,c]] — the weak direction is the one
      // that decides whether this point can be located in BOTH axes.
      const trace = a + c;
      const gap = Math.sqrt((a - c) * (a - c) + 4 * b * b);
      const strength = (trace - gap) * 0.5;
      if (strength > MIN_USABLE_STRENGTH) {
        out.push({ x, y, strength, distinctness: 1, score: strength });
      }
    }
  }
  return out;
}

/** Strength-ranked, spatially separated survivors — a corner is many adjacent
 *  strong candidates, and shortlisting all of them wastes every probe on one
 *  feature. */
function suppress(candidates: FeatureCandidate[], minSpacing: number, keep: number): FeatureCandidate[] {
  const sorted = candidates.slice().sort((p, q) => q.strength - p.strength);
  const chosen: FeatureCandidate[] = [];
  const spacingSq = minSpacing * minSpacing;
  for (const c of sorted) {
    if (chosen.length >= keep) break;
    let clear = true;
    for (const k of chosen) {
      if ((k.x - c.x) ** 2 + (k.y - c.y) ** 2 < spacingSq) {
        clear = false;
        break;
      }
    }
    if (clear) chosen.push(c);
  }
  return chosen;
}

/**
 * How much better this patch matches itself than it matches its
 * neighbourhood — the periodic-texture test.
 *
 * Probes sit on rings from `2·half+2` out to `radius`, far enough that the
 * patch no longer overlaps itself (an overlapping probe scores high for
 * trivial reasons and would report every feature as ambiguous). The worst
 * offender wins: one convincing rival is enough to lose a track.
 */
export function distinctnessAt(
  plane: LumaPlane,
  x: number,
  y: number,
  half: number,
  radius: number,
): number {
  const ref = extractPatch(plane, x, y, half);
  if (!ref) return 0;
  const inner = 2 * half + 2;
  if (radius <= inner) return 1;

  let rival = -1;
  const rings = 3;
  for (let r = 0; r < rings; r++) {
    const dist = inner + ((radius - inner) * r) / (rings - 1);
    const steps = Math.max(8, Math.round((2 * Math.PI * dist) / Math.max(4, half)));
    for (let s = 0; s < steps; s++) {
      const a = (2 * Math.PI * s) / steps;
      const cand = extractPatch(plane, x + dist * Math.cos(a), y + dist * Math.sin(a), half);
      if (!cand) continue;
      const score = ncc(ref, cand);
      if (score > rival) rival = score;
    }
  }
  // NCC in [-1,1]; only POSITIVE rivals are confusable (a negative peak is
  // the feature's photographic inverse, which no tracker locks onto).
  return Math.max(MIN_DISTINCTNESS, Math.min(1, 1 - Math.max(0, rival)));
}

/**
 * Move a candidate onto the feature itself.
 *
 * The scan window is a BOX, and a box structure tensor is flat-topped: slide
 * it anywhere within ±half of a corner and it still contains both of that
 * corner's edges, so it reports the same strength. The scan therefore says
 * "a corner is somewhere around here", which is not good enough — the point
 * the user sees, the patch the tracker chains from, and the accuracy of every
 * keyframe downstream all depend on being ON the feature rather than eight
 * pixels into the flat beside it.
 *
 * A smaller box window narrows the plateau but does not remove it — any
 * window that fully contains the corner's two gradient bands scores the same,
 * whatever its size. What removes it is WEIGHTING: with a Gaussian window the
 * same gradient bands count for more the closer they sit to the centre, so
 * the response is a true peak on the corner. That is what Harris and
 * Shi-Tomasi have always specified, and the box was only ever an integral-
 * image convenience.
 *
 * It is applied here rather than in the scan because a weighted window has no
 * O(1) integral-image form: over a shortlist of survivors it is a few
 * thousand multiplies, and over a whole 4K scan it would be minutes.
 */
function refine(plane: LumaPlane, cand: FeatureCandidate, reach: number): FeatureCandidate {
  const at = reader(plane);
  const cx = Math.round(cand.x);
  const cy = Math.round(cand.y);
  const lo = REFINE_HALF + 1;
  if (
    cx - reach - lo < 0 || cy - reach - lo < 0
    || cx + reach + lo >= plane.width || cy + reach + lo >= plane.height
  ) {
    return cand;
  }

  // Separable Gaussian weights, σ = half/2 — wide enough to see the whole
  // window, tight enough that the centre decides.
  const sigma = REFINE_HALF / 2;
  const w: number[] = [];
  for (let d = -REFINE_HALF; d <= REFINE_HALF; d++) w.push(Math.exp(-(d * d) / (2 * sigma * sigma)));

  let bestX = cand.x;
  let bestY = cand.y;
  let bestStrength = -1;
  for (let y = cy - reach; y <= cy + reach; y++) {
    for (let x = cx - reach; x <= cx + reach; x++) {
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      for (let j = -REFINE_HALF; j <= REFINE_HALF; j++) {
        const wy = w[j + REFINE_HALF]!;
        for (let i = -REFINE_HALF; i <= REFINE_HALF; i++) {
          const px = x + i;
          const py = y + j;
          const dx = (at(px + 1, py) - at(px - 1, py)) * 0.5;
          const dy = (at(px, py + 1) - at(px, py - 1)) * 0.5;
          const weight = wy * w[i + REFINE_HALF]!;
          sxx += weight * dx * dx;
          sxy += weight * dx * dy;
          syy += weight * dy * dy;
        }
      }
      const trace = sxx + syy;
      const gap = Math.sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy);
      const strength = (trace - gap) * 0.5;
      if (strength > bestStrength) {
        bestStrength = strength;
        bestX = x;
        bestY = y;
      }
    }
  }
  // The COARSE strength stays the ranking value: it was measured at the scan
  // window, and mixing refined small-window strengths with unrefined ones
  // would rank candidates on two different scales.
  return { ...cand, x: bestX, y: bestY };
}

/**
 * The smallest window that still resolves this feature.
 *
 * Strength is measured on the ladder and the smallest window within 25% of
 * the best is taken. Bigger is not better: a 33×33 window on a rotating or
 * receding surface contains pixels whose relationship to the centre changes,
 * which is drift the correlation cannot see, and it costs ~7× the arithmetic
 * of a 13×13. The ladder stops at 16 because past that the patch is a scene,
 * not a feature.
 */
export function suggestFeatureHalf(plane: LumaPlane, x: number, y: number): number {
  const cx = Math.round(x);
  const cy = Math.round(y);
  let best = 0;
  const strengths = SCALE_LADDER.map((half) => {
    const clamped = clampRegion({ x0: cx, y0: cy, x1: cx, y1: cy }, plane, half + 2);
    if (!clamped) return 0;
    const s = scanRegion(plane, clamped, half, 1)[0]?.strength ?? 0;
    if (s > best) best = s;
    return s;
  });
  if (best <= 0) return SCAN_HALF;
  const index = strengths.findIndex((s) => s >= best * 0.75);
  return SCALE_LADDER[index < 0 ? SCALE_LADDER.length - 1 : index]!;
}

/**
 * The best feature to track, near `hint` if given.
 *
 * Returns null when the region genuinely holds nothing trackable — a sky, a
 * white wall, a defocused background. That is a real answer and the caller
 * must show it, because the alternative (returning the least-flat flat point)
 * is how a tracker produces confident nonsense.
 */
export function pickFeature(plane: LumaPlane, opts: PickFeatureOptions = {}): FeatureCandidate | null {
  const margin = opts.margin ?? 24;
  const short = Math.min(plane.width, plane.height);
  const radius = opts.radius ?? Math.max(48, Math.round(short * 0.12));
  const hint = opts.hint ?? { x: plane.width / 2, y: plane.height / 2 };
  const region = clampRegion(
    { x0: hint.x - radius, y0: hint.y - radius, x1: hint.x + radius, y1: hint.y + radius },
    plane,
    margin,
  );
  if (!region) return null;

  const scanned = scanRegion(plane, region, SCAN_HALF, SCAN_STRIDE);
  if (scanned.length === 0) return null;

  // Proximity bias: a strong feature 200 px from the click is not what was
  // asked for. Gaussian at σ = radius/2 — near-free inside the click's
  // neighbourhood, decisive at the region edge.
  const sigmaSq = 2 * (radius / 2) ** 2;
  let best: FeatureCandidate | null = null;
  for (const coarse of suppress(scanned, SCAN_HALF * 2, DISTINCTNESS_SHORTLIST)) {
    const c = refine(plane, coarse, SCAN_HALF);
    const distinctness = distinctnessAt(plane, c.x, c.y, SCAN_HALF, radius);
    const dSq = (c.x - hint.x) ** 2 + (c.y - hint.y) ** 2;
    const proximity = Math.exp(-dSq / sigmaSq);
    const score = c.strength * distinctness * proximity;
    if (!best || score > best.score) best = { ...c, distinctness, score };
  }
  return best && best.score > 0 ? best : null;
}

/**
 * Several features spread across the frame — what the multi-point modes
 * (rotation/scale, planar/corner pin) need seeded automatically.
 *
 * Scanned TILE BY TILE rather than as one region: it bounds working memory to
 * one tile whatever the footage resolution, and the tiles double as spatial
 * bins, so the result cannot be five features on the one high-contrast object
 * in the corner — which is a degenerate configuration every fit downstream
 * (similarity, homography, camera solve) resolves badly.
 */
export function pickFeatures(
  plane: LumaPlane,
  count: number,
  opts: { margin?: number; tile?: number; within?: Region } = {},
): FeatureCandidate[] {
  if (count <= 0) return [];
  const margin = opts.margin ?? 24;
  const tile = opts.tile ?? 256;
  const perTile: FeatureCandidate[] = [];
  // `within` narrows the sweep to one area — what picking a COMPANION for an
  // already-chosen feature needs, since a second point is only useful if it is
  // plausibly on the same rigid surface as the first.
  const bounds = clampRegion(
    opts.within ?? { x0: 0, y0: 0, x1: plane.width - 1, y1: plane.height - 1 },
    plane,
    margin,
  );
  if (!bounds) return [];

  for (let ty = bounds.y0; ty <= bounds.y1; ty += tile) {
    for (let tx = bounds.x0; tx <= bounds.x1; tx += tile) {
      const region = clampRegion(
        {
          x0: tx, y0: ty,
          x1: Math.min(tx + tile - 1, bounds.x1),
          y1: Math.min(ty + tile - 1, bounds.y1),
        },
        plane,
        margin,
      );
      if (!region) continue;
      const top = suppress(scanRegion(plane, region, SCAN_HALF, SCAN_STRIDE), SCAN_HALF * 2, 1)[0];
      if (top) perTile.push(top);
    }
  }

  // Probe distinctness for a shortlist twice the requested size, so a
  // repetitive tile can be dropped without leaving a hole in the result.
  const shortlist = perTile.sort((p, q) => q.strength - p.strength).slice(0, count * 2);
  return shortlist
    .map((coarse) => {
      const c = refine(plane, coarse, SCAN_HALF);
      const distinctness = distinctnessAt(plane, c.x, c.y, SCAN_HALF, tile / 2);
      return { ...c, distinctness, score: c.strength * distinctness };
    })
    .filter((c) => c.score > 0)
    .sort((p, q) => q.score - p.score)
    .slice(0, count);
}
