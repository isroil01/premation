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

/**
 * A single-channel image. Float planes carry [0, 1]; Uint8 planes carry raw
 * Y bytes (0–255, straight off `VideoFrame.copyTo` with zero conversion —
 * see lumaExtract). Every consumer in this module is GAIN-INVARIANT by
 * design (zero-mean NCC, normalized LK), so the two ranges interoperate —
 * which is exactly what lets the tracker skip an 8M-element u8→f32 loop per
 * 4K frame.
 */
export interface LumaPlane {
  data: Float32Array | Uint8Array;
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
  // ── The fast path's three observations ─────────────────────────────
  //
  // The naive search is (2·sh+1)² candidates × (extract 441 bilinear samples
  // + a full NCC) ≈ 12M ops per point per frame at the defaults — the whole
  // reason Track progress crawled. But:
  //
  //  1. Every candidate centre shares the SAME fractional phase (offsets are
  //     integers), so the bilinear resampling can happen ONCE: one region of
  //     (2·(sh+fh)+1)² samples, and every candidate patch is an integer-
  //     aligned window into it — byte-identical values to extractPatch.
  //  2. NCC's window statistics (Σw, Σw²) come from two integral images over
  //     that region in O(1) per candidate; only the template cross term
  //     needs a real loop.
  //  3. The NCC surface of a 21×21 patch is smooth at stride 2, so a coarse
  //     pass + a ±2 refine visits ~¼ of the candidates. (Small windows stay
  //     exhaustive — there is nothing to skip.)
  //
  // Together: ~30× less arithmetic, same answer. The sub-pixel stage below
  // (LK / parabola) is untouched and still reads the ORIGINAL plane.
  const featureSize = 2 * featureHalf + 1;
  const n = featureSize * featureSize;
  const reach = searchHalf + featureHalf;
  const regionSize = 2 * reach + 1;

  // One bilinear pass over the search region, at the prediction's phase.
  const region = new Float32Array(regionSize * regionSize);
  {
    let i = 0;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        region[i++] = sampleBilinear(target, predictX + dx, predictY + dy);
      }
    }
  }

  // Integral images (one extra row/col of zeros) for O(1) window sums.
  const iw = regionSize + 1;
  const integ = new Float64Array(iw * iw);
  const integSq = new Float64Array(iw * iw);
  for (let y = 0; y < regionSize; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < regionSize; x++) {
      const v = region[y * regionSize + x]!;
      rowSum += v;
      rowSumSq += v * v;
      integ[(y + 1) * iw + (x + 1)] = integ[y * iw + (x + 1)]! + rowSum;
      integSq[(y + 1) * iw + (x + 1)] = integSq[y * iw + (x + 1)]! + rowSumSq;
    }
  }

  // Template statistics, once.
  let sumT = 0;
  let sumT2 = 0;
  for (let i = 0; i < n; i++) {
    const v = refPatch[i]!;
    sumT += v;
    sumT2 += v * v;
  }
  const varT = sumT2 - (sumT * sumT) / n;

  const size = 2 * searchHalf + 1;
  const scores = new Float32Array(size * size).fill(-3); // -3 = not evaluated
  const score = (dx: number, dy: number): number => {
    if (Math.abs(dx) > searchHalf || Math.abs(dy) > searchHalf) return -2;
    const slot = (dy + searchHalf) * size + (dx + searchHalf);
    const memo = scores[slot]!;
    if (memo > -3) return memo;
    // Same off-plane rule as extractPatch: the CENTRE must be inside.
    const cx = predictX + dx;
    const cy = predictY + dy;
    if (cx < 0 || cy < 0 || cx > target.width - 1 || cy > target.height - 1) {
      scores[slot] = -2;
      return -2;
    }
    // Window top-left inside the region grid.
    const wx = dx + searchHalf;
    const wy = dy + searchHalf;
    const x0 = wx;
    const y0 = wy;
    const x1 = wx + featureSize;
    const y1 = wy + featureSize;
    const sumW = integ[y1 * iw + x1]! - integ[y0 * iw + x1]! - integ[y1 * iw + x0]! + integ[y0 * iw + x0]!;
    const sumW2 = integSq[y1 * iw + x1]! - integSq[y0 * iw + x1]! - integSq[y1 * iw + x0]! + integSq[y0 * iw + x0]!;
    const varW = sumW2 - (sumW * sumW) / n;
    if (varT <= 1e-12 || varW <= 1e-12) {
      scores[slot] = 0; // flat patch correlates with nothing (see ncc)
      return 0;
    }
    let cross = 0;
    let k = 0;
    for (let r = 0; r < featureSize; r++) {
      let ri = (wy + r) * regionSize + wx;
      for (let c = 0; c < featureSize; c++, k++, ri++) {
        cross += refPatch[k]! * region[ri]!;
      }
    }
    const s = (cross - (sumT * sumW) / n) / Math.sqrt(varT * varW);
    scores[slot] = s;
    return s;
  };

  let bestScore = -2;
  let bestDx = 0;
  let bestDy = 0;
  const consider = (dx: number, dy: number): void => {
    const s = score(dx, dy);
    if (s > bestScore) {
      bestScore = s;
      bestDx = dx;
      bestDy = dy;
    }
  };

  if (searchHalf <= 6) {
    // Small windows: exhaustive, nothing worth skipping.
    for (let dy = -searchHalf; dy <= searchHalf; dy++) {
      for (let dx = -searchHalf; dx <= searchHalf; dx++) consider(dx, dy);
    }
  } else {
    // Coarse stride-2 sweep (window edges included), then a full ±2 refine
    // around the coarse peak so the true integer peak cannot be missed.
    for (let dy = -searchHalf; dy <= searchHalf; dy += 2) {
      for (let dx = -searchHalf; dx <= searchHalf; dx += 2) consider(dx, dy);
    }
    if (searchHalf % 2 === 1) {
      // Odd half: the stride grid misses the far edges — sweep them.
      for (let d = -searchHalf; d <= searchHalf; d += 2) {
        consider(d, searchHalf);
        consider(d, -searchHalf);
        consider(searchHalf, d);
        consider(-searchHalf, d);
      }
    }
    const cDx = bestDx;
    const cDy = bestDy;
    for (let dy = Math.max(-searchHalf, cDy - 2); dy <= Math.min(searchHalf, cDy + 2); dy++) {
      for (let dx = Math.max(-searchHalf, cDx - 2); dx <= Math.min(searchHalf, cDx + 2); dx++) {
        consider(dx, dy);
      }
    }
  }
  if (bestScore <= -2) return null; // every candidate centre was off-plane

  // Sub-pixel: parabola through the peak's axis neighbours. At the search
  // border there is no neighbour — the caller's search window was too small
  // for this motion and half a pixel of refinement is the least of it.
  const at = (dx: number, dy: number): number | null => {
    if (Math.abs(dx) > searchHalf || Math.abs(dy) > searchHalf) return null;
    const s = score(dx, dy);
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
