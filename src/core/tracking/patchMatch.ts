/**
 * Patch matching — the arithmetic half of the point tracker.
 *
 * Pure functions over luma planes, no DOM and no decoder, so the matcher that
 * decides WHERE a feature went is testable to sub-pixel tolerances in jest
 * with synthetic frames. The orchestration half (walking a real clip's frames
 * through the exact decoder) lives in tracker.ts; the split mirrors
 * frameIndex.ts vs exactVideoSource.ts one directory over.
 *
 * The matcher is zero-mean normalized cross-correlation (NCC) over an
 * integer-offset search window, refined to sub-pixel by fitting a parabola
 * through the correlation peak and its neighbours — the classic Lucas-Kanade
 * -adjacent design AE's point tracker family uses. NCC rather than SSD
 * because footage exposure drifts: zero-mean + unit-variance makes the score
 * invariant to brightness and contrast changes, which is the difference
 * between a tracker that survives a lighting shift and one that doesn't.
 *
 * Patches are sampled BILINEARLY at fractional centres. That is not a
 * refinement detail: the whole point of sub-pixel output is that the next
 * frame's search starts from a fractional position, and re-quantizing it to
 * integers every frame would accumulate up to half a pixel of drift per
 * frame — a tracker that walks away from its feature on a static shot.
 */

/** A single-channel float image. Values in [0, 1]. */
export interface LumaPlane {
  data: Float32Array;
  width: number;
  height: number;
}

/** Rec.601 luma from RGBA bytes — footage is video, 601 is the safe default
 *  and the tracker only needs CONSISTENCY between frames, not colorimetric
 *  truth (any fixed weighting tracks equally well). */
export function lumaFromRGBA(rgba: Uint8ClampedArray, width: number, height: number): LumaPlane {
  const data = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = (0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!) / 255;
  }
  return { data, width, height };
}

/** Bilinear sample, clamped at the borders (a feature tracked to the frame
 *  edge degrades gracefully instead of reading garbage). */
export function sampleBilinear(plane: LumaPlane, x: number, y: number): number {
  const { data, width, height } = plane;
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const top = data[y0 * width + x0]! * (1 - fx) + data[y0 * width + x1]! * fx;
  const bot = data[y1 * width + x0]! * (1 - fx) + data[y1 * width + x1]! * fx;
  return top * (1 - fy) + bot * fy;
}

/**
 * Extract a (2·half+1)² patch centred at a (possibly fractional) point.
 * Returns null when the centre is outside the plane entirely — a feature
 * that left the frame has no patch, and the caller must say so rather than
 * match against border-clamp smear.
 */
export function extractPatch(
  plane: LumaPlane,
  cx: number,
  cy: number,
  half: number,
): Float32Array | null {
  if (cx < 0 || cy < 0 || cx > plane.width - 1 || cy > plane.height - 1) return null;
  const size = 2 * half + 1;
  const out = new Float32Array(size * size);
  let i = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      out[i++] = sampleBilinear(plane, cx + dx, cy + dy);
    }
  }
  return out;
}

/**
 * Zero-mean normalized cross-correlation of two equal-length patches,
 * in [-1, 1]. A flat patch (zero variance) correlates with nothing — 0, not
 * NaN, because "featureless region" must read as LOW confidence, and NaN
 * poisons every comparison it touches.
 */
export function ncc(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= n;
  meanB /= n;
  let cross = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cross += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 1e-12 || varB <= 1e-12) return 0;
  return cross / Math.sqrt(varA * varB);
}

export interface MatchResult {
  /** Matched centre in the TARGET plane, sub-pixel. */
  x: number;
  y: number;
  /** Peak NCC score in [-1, 1]. Treat < ~0.5 as "lost". */
  confidence: number;
}

/** Zero-mean, unit-variance copy — lets the LK refinement below inherit
 *  NCC's gain/offset invariance. Returns null for a flat patch. */
function normalized(p: Float32Array): Float32Array | null {
  const n = p.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += p[i]!;
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (p[i]! - mean) ** 2;
  if (variance <= 1e-12) return null;
  const inv = 1 / Math.sqrt(variance / n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (p[i]! - mean) * inv;
  return out;
}

/**
 * Lucas-Kanade sub-pixel refinement around an integer NCC peak.
 *
 * Parabolic peak fitting alone pixel-locks: bilinear resampling blurs a
 * patch by a phase-dependent amount, so the correlation surface is dented
 * toward integer offsets, and a true displacement near ±0.5px is estimated
 * ~0.1px short — every frame, in the same direction, which a CHAINED
 * tracker integrates into a walk-off. LK instead solves for the residual
 * displacement directly from the template's spatial gradients (the KLT
 * design), which does not care where the pixel grid is.
 *
 * Both patches are normalized first so the least-squares residual keeps
 * NCC's brightness/contrast invariance. Returns null when the template has
 * no usable gradient structure (flat/1-D texture — the aperture problem) or
 * when the iteration walks out of the integer cell it was asked to refine.
 */
function lkRefine(
  refPatch: Float32Array,
  featureHalf: number,
  target: LumaPlane,
  startX: number,
  startY: number,
): { x: number; y: number } | null {
  const size = 2 * featureHalf + 1;
  const ref = normalized(refPatch);
  if (!ref) return null;

  // Template gradients (interior pixels — central differences need both
  // neighbours) and the 2×2 Gauss-Newton Hessian, computed ONCE.
  const gx = new Float32Array(size * size);
  const gy = new Float32Array(size * size);
  let hxx = 0;
  let hxy = 0;
  let hyy = 0;
  for (let r = 1; r < size - 1; r++) {
    for (let c = 1; c < size - 1; c++) {
      const i = r * size + c;
      const dx = (ref[i + 1]! - ref[i - 1]!) * 0.5;
      const dy = (ref[i + size]! - ref[i - size]!) * 0.5;
      gx[i] = dx;
      gy[i] = dy;
      hxx += dx * dx;
      hxy += dx * dy;
      hyy += dy * dy;
    }
  }
  const det = hxx * hyy - hxy * hxy;
  if (det <= 1e-9) return null; // aperture problem — no unique solution

  let x = startX;
  let y = startY;
  for (let iter = 0; iter < 12; iter++) {
    const candRaw = extractPatch(target, x, y, featureHalf);
    if (!candRaw) return null;
    const cand = normalized(candRaw);
    if (!cand) return null;
    let bx = 0;
    let by = 0;
    for (let r = 1; r < size - 1; r++) {
      for (let c = 1; c < size - 1; c++) {
        const i = r * size + c;
        const e = cand[i]! - ref[i]!;
        bx += gx[i]! * e;
        by += gy[i]! * e;
      }
    }
    // e ≈ ∇T·δ with δ = (current − true), so the solved δ is SUBTRACTED.
    const stepX = (hyy * bx - hxy * by) / det;
    const stepY = (hxx * by - hxy * bx) / det;
    x -= stepX;
    y -= stepY;
    // Refinement only — a step chain leaving the integer cell means the
    // linearization is chasing something else; the NCC peak stands.
    if (Math.abs(x - startX) > 1 || Math.abs(y - startY) > 1) return null;
    if (Math.abs(stepX) < 1e-3 && Math.abs(stepY) < 1e-3) break;
  }
  return { x, y };
}

/** Parabolic peak refinement in one axis: offset in (-0.5, 0.5) of the true
 *  peak given the score at the integer peak and its two neighbours. */
function parabolicOffset(left: number, centre: number, right: number): number {
  const denom = left - 2 * centre + right;
  if (denom >= -1e-12) return 0; // not a proper maximum — stay on the sample
  const off = (0.5 * (left - right)) / denom;
  // A fit that claims the peak is outside the bracket is extrapolating noise.
  return Math.max(-0.5, Math.min(0.5, off));
}

/**
 * Find `refPatch` (a patch extracted around the feature in the previous
 * frame) inside `target`, searching integer offsets within ±`searchHalf` of
 * (`predictX`, `predictY`), then refining to sub-pixel.
 *
 * Returns null only when the predicted centre has left the plane; a bad
 * match inside the plane returns its (low) confidence instead, so the caller
 * can distinguish "gone" from "unsure" — they want different UI.
 */
export function matchPatch(
  refPatch: Float32Array,
  featureHalf: number,
  target: LumaPlane,
  predictX: number,
  predictY: number,
  searchHalf: number,
): MatchResult | null {
  const size = 2 * searchHalf + 1;
  const scores = new Float32Array(size * size).fill(-2);
  let bestScore = -2;
  let bestDx = 0;
  let bestDy = 0;
  for (let dy = -searchHalf; dy <= searchHalf; dy++) {
    for (let dx = -searchHalf; dx <= searchHalf; dx++) {
      const cand = extractPatch(target, predictX + dx, predictY + dy, featureHalf);
      if (!cand) continue;
      const s = ncc(refPatch, cand);
      scores[(dy + searchHalf) * size + (dx + searchHalf)] = s;
      if (s > bestScore) {
        bestScore = s;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  if (bestScore <= -2) return null; // every candidate centre was off-plane

  // Sub-pixel: parabola through the peak's axis neighbours. At the search
  // border there is no neighbour — the caller's search window was too small
  // for this motion and half a pixel of refinement is the least of it.
  const at = (dx: number, dy: number): number | null => {
    if (Math.abs(dx) > searchHalf || Math.abs(dy) > searchHalf) return null;
    const s = scores[(dy + searchHalf) * size + (dx + searchHalf)]!;
    return s <= -2 ? null : s;
  };
  // Sub-pixel: LK refinement from the integer peak (see lkRefine on why the
  // parabola alone pixel-locks); parabolic fit is the fallback when the
  // template has no usable gradients or the iteration diverges.
  const refined = lkRefine(refPatch, featureHalf, target, predictX + bestDx, predictY + bestDy);
  if (refined) {
    return { x: refined.x, y: refined.y, confidence: bestScore };
  }
  const l = at(bestDx - 1, bestDy);
  const r = at(bestDx + 1, bestDy);
  const t = at(bestDx, bestDy - 1);
  const b = at(bestDx, bestDy + 1);
  const offX = l !== null && r !== null ? parabolicOffset(l, bestScore, r) : 0;
  const offY = t !== null && b !== null ? parabolicOffset(t, bestScore, b) : 0;

  return {
    x: predictX + bestDx + offX,
    y: predictY + bestDy + offY,
    confidence: bestScore,
  };
}
