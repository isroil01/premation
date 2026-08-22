/**
 * Dense stabilization's math half — Warp-Stabilizer-class SMOOTH MOTION,
 * as opposed to the point tracker's lock-to-a-feature Stabilize.
 *
 * Per adjacent frame pair, the optical-flow grid (pixelMotionFlow) votes on
 * one global SIMILARITY (translate + rotate + uniform scale) — the camera's
 * frame-to-frame motion. Composing the pairs gives the camera's path;
 * smoothing the path and applying `smoothed ∘ actual⁻¹` per frame removes the
 * high-frequency shake while KEEPING the deliberate move — which is the whole
 * difference between this and locking to a point.
 *
 * Scope, stated plainly: similarity-model stabilization (position, rotation,
 * scale — AE Warp Stabilizer's default visible result on most shots). Subspace
 * warp and rolling-shutter repair live in `subspaceWarp.ts` (grid of local
 * similarities + per-row shear) for Mesh Warp / repair apply paths.
 *
 * Everything here is pure and deterministic: closed-form least squares, fixed
 * trim rounds, Gaussian weights from an explicit sigma. Same frames → same
 * corrections, so preview and export agree.
 */

import type { FlowField } from '@core/rendering/pixelMotionFlow';

/**
 * Similarity transform p' = R·s·p + t, stored as the four linear-solve
 * parameters: x' = a·x − b·y + tx ; y' = b·x + a·y + ty. `a = s·cosθ`,
 * `b = s·sinθ`.
 */
export interface Sim {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

export const IDENTITY_SIM: Sim = { a: 1, b: 0, tx: 0, ty: 0 };

export function composeSim(outer: Sim, inner: Sim): Sim {
  // outer(inner(p)).
  return {
    a: outer.a * inner.a - outer.b * inner.b,
    b: outer.b * inner.a + outer.a * inner.b,
    tx: outer.a * inner.tx - outer.b * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.a * inner.ty + outer.ty,
  };
}

export function invertSim(s: Sim): Sim {
  const d = s.a * s.a + s.b * s.b;
  if (d < 1e-12) return { ...IDENTITY_SIM };
  const ia = s.a / d;
  const ib = -s.b / d;
  return {
    a: ia,
    b: ib,
    tx: -(ia * s.tx - ib * s.ty),
    ty: -(ib * s.tx + ia * s.ty),
  };
}

export function applySim(s: Sim, x: number, y: number): [number, number] {
  return [s.a * x - s.b * y + s.tx, s.b * x + s.a * y + s.ty];
}

/** Rotation (radians) and uniform scale of a similarity. */
export function simRotation(s: Sim): number {
  return Math.atan2(s.b, s.a);
}
export function simScale(s: Sim): number {
  return Math.hypot(s.a, s.b);
}

/** Build a similarity from rotation (radians), scale and translation. */
export function simFrom(rot: number, scale: number, tx: number, ty: number): Sim {
  return { a: Math.cos(rot) * scale, b: Math.sin(rot) * scale, tx, ty };
}

/** One flow observation: a point and where it went. */
export interface MotionSamplePoint {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** The measured grid points of a flow field, in flow-resolution px scaled by
 *  `scaleX`/`scaleY` to whatever grid the caller works in. Abstaining blocks
 *  (`valid` 0) are EXCLUDED — on a mostly-flat shot they would outvote the
 *  actual motion with "the camera is still". */
export function flowSamplePoints(f: FlowField, scaleX = 1, scaleY = 1): MotionSamplePoint[] {
  const out: MotionSamplePoint[] = [];
  for (let gy = 0; gy < f.rows; gy++) {
    for (let gx = 0; gx < f.cols; gx++) {
      const i = gy * f.cols + gx;
      if (!f.valid[i]) continue;
      out.push({
        x: (gx + 0.5) * f.step * scaleX,
        y: (gy + 0.5) * f.step * scaleY,
        dx: f.dx[i]! * scaleX,
        dy: f.dy[i]! * scaleY,
      });
    }
  }
  return out;
}

/**
 * Least-squares similarity through a set of observations, with trimming.
 *
 * Closed form on centred coordinates (the standard 4-parameter solve), then
 * `trimRounds` passes dropping observations whose residual exceeds
 * 2.5× the median — a foreground subject moving against the camera is exactly
 * such a cluster, and one trim round is usually what separates "stabilize the
 * world" from "stabilize the actor". Returns null below 3 usable points.
 */
export function fitSimilarity(points: readonly MotionSamplePoint[], trimRounds = 2): Sim | null {
  let active = points.slice();
  let fit: Sim | null = null;
  for (let round = 0; round <= trimRounds; round++) {
    if (active.length < 3) return fit;
    // Centre both point sets.
    let mx = 0, my = 0, mX = 0, mY = 0;
    for (const p of active) {
      mx += p.x; my += p.y; mX += p.x + p.dx; mY += p.y + p.dy;
    }
    const n = active.length;
    mx /= n; my /= n; mX /= n; mY /= n;
    // Accumulate the 2×2 normal equations for a,b on centred coords.
    let sxx = 0, sxy = 0, syx = 0, syy = 0, spp = 0;
    for (const p of active) {
      const cx = p.x - mx;
      const cy = p.y - my;
      const CX = p.x + p.dx - mX;
      const CY = p.y + p.dy - mY;
      sxx += cx * CX; sxy += cx * CY; syx += cy * CX; syy += cy * CY;
      spp += cx * cx + cy * cy;
    }
    if (spp < 1e-9) return fit;
    const a = (sxx + syy) / spp;
    const b = (sxy - syx) / spp;
    const tx = mX - (a * mx - b * my);
    const ty = mY - (b * mx + a * my);
    fit = { a, b, tx, ty };
    if (round === trimRounds) break;
    // Trim by residual against this fit.
    const residuals = active.map((p) => {
      const [px, py] = applySim(fit!, p.x, p.y);
      return Math.hypot(px - (p.x + p.dx), py - (p.y + p.dy));
    });
    const sorted = [...residuals].sort((u, v) => u - v);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const cut = Math.max(0.5, median * 2.5);
    const next = active.filter((_, i) => residuals[i]! <= cut);
    if (next.length === active.length) break; // converged — nothing to drop
    active = next;
  }
  return fit;
}

/** A camera path decomposed for smoothing: per-frame absolute translation,
 *  UNWRAPPED rotation, and log-scale — the spaces where a Gaussian average is
 *  meaningful (averaging raw a/b through a rotation shrinks the scale). */
interface PathParams {
  tx: Float64Array;
  ty: Float64Array;
  rot: Float64Array;
  logS: Float64Array;
}

function decomposePath(path: readonly Sim[]): PathParams {
  const n = path.length;
  const p: PathParams = {
    tx: new Float64Array(n), ty: new Float64Array(n),
    rot: new Float64Array(n), logS: new Float64Array(n),
  };
  let prevRot = 0;
  for (let i = 0; i < n; i++) {
    const s = path[i]!;
    p.tx[i] = s.tx;
    p.ty[i] = s.ty;
    let r = simRotation(s);
    // Unwrap: keep each frame within π of the previous — a pan through ±180°
    // must not snap the smoother.
    while (r - prevRot > Math.PI) r -= 2 * Math.PI;
    while (r - prevRot < -Math.PI) r += 2 * Math.PI;
    p.rot[i] = r;
    prevRot = r;
    p.logS[i] = Math.log(Math.max(1e-6, simScale(s)));
  }
  return p;
}

/** Gaussian-smooth one channel, edge-truncated (weights renormalized at the
 *  ends, so the path is not dragged toward zero at the cut). */
function gaussSmooth(v: Float64Array, sigma: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  if (sigma <= 0 || n < 2) {
    out.set(v);
    return out;
  }
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const weights = new Float64Array(radius * 2 + 1);
  for (let k = -radius; k <= radius; k++) {
    weights[k + radius] = Math.exp(-(k * k) / (2 * sigma * sigma));
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let wsum = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const w = weights[k + radius]!;
      sum += v[j]! * w;
      wsum += w;
    }
    out[i] = sum / wsum;
  }
  return out;
}

/**
 * Per-frame stabilizing corrections from per-PAIR camera motion.
 *
 * `pairs[i]` maps frame i's pixels onto frame i+1's (the fitted flow
 * similarity). The cumulative path C(i) maps frame 0 onto frame i; the
 * correction for frame i is `S(i) ∘ C(i)⁻¹` with S the Gaussian-smoothed
 * path — content is carried back to where the SMOOTH camera would have put
 * it. Frame 0's correction is what S(0) differs from identity, so the whole
 * clip shifts consistently rather than pinning the first frame.
 *
 * A pair that failed to fit (null) contributes identity motion — the honest
 * reading of "we could not measure", and one bad frame then costs smoothness,
 * not a spike.
 */
export function stabilizingCorrections(
  pairs: ReadonlyArray<Sim | null>,
  sigmaFrames: number,
): Sim[] {
  const n = pairs.length + 1;
  const path: Sim[] = [{ ...IDENTITY_SIM }];
  for (let i = 0; i < pairs.length; i++) {
    path.push(composeSim(pairs[i] ?? IDENTITY_SIM, path[i]!));
  }
  const p = decomposePath(path);
  const stx = gaussSmooth(p.tx, sigmaFrames);
  const sty = gaussSmooth(p.ty, sigmaFrames);
  const srot = gaussSmooth(p.rot, sigmaFrames);
  const slog = gaussSmooth(p.logS, sigmaFrames);
  const out: Sim[] = [];
  for (let i = 0; i < n; i++) {
    const smooth = simFrom(srot[i]!, Math.exp(slog[i]!), stx[i]!, sty[i]!);
    out.push(composeSim(smooth, invertSim(path[i]!)));
  }
  return out;
}
