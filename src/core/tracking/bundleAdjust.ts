/**
 * Sparse bundle adjustment — Levenberg–Marquardt on cameras + 3D points.
 *
 * Not Ceres/COLMAP-grade (no Schur complement, dense Jacobian), but a real BA
 * loop: triangulated landmarks, multi-view reprojection, Huber robustification,
 * gauge fixed (camera 0 pose locked). Enough to polish an incremental SfM path
 * from tracked features.
 */

import { projectPoint, type Vec3 } from './triangulate';

export interface BaObservation {
  frame: number;
  pointId: number;
  x: number;
  y: number;
  weight?: number;
}

export interface BaCamera {
  /** Eye position in world. */
  C: Vec3;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface BaOptions {
  focal: number;
  cx: number;
  cy: number;
  maxIters?: number;
  lambda0?: number;
  huberDelta?: number;
}

export interface BaResult {
  cameras: BaCamera[];
  points: Vec3[];
  rmsPx: number;
  iters: number;
}

const DEG = Math.PI / 180;

/** Engine convention: world→cam = Rz(−roll)·Rx(−pitch)·Ry(−yaw). */
export function yprToR(yawDeg: number, pitchDeg: number, rollDeg: number): number[][] {
  const y = -yawDeg * DEG;
  const p = -pitchDeg * DEG;
  const r = -rollDeg * DEG;
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  // Ry then Rx then Rz
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
  const Rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
  return mul3(Rz, mul3(Rx, Ry));
}

function mul3(A: number[][], B: number[][]): number[][] {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i]![j] = A[i]![0]! * B[0]![j]! + A[i]![1]! * B[1]![j]! + A[i]![2]! * B[2]![j]!;
    }
  }
  return out;
}

function huberWeight(r: number, delta: number): number {
  const a = Math.abs(r);
  return a <= delta ? 1 : delta / a;
}

interface Pack {
  /** Free camera params: frames 1..n-1 × (x,y,z,yaw,pitch,roll) = 6 each. */
  nFreeCams: number;
  nPoints: number;
  /** Parameter vector length. */
  n: number;
}

function packLayout(nCams: number, nPoints: number): Pack {
  const nFreeCams = Math.max(0, nCams - 1);
  return { nFreeCams, nPoints, n: nFreeCams * 6 + nPoints * 3 };
}

function toVector(cams: BaCamera[], pts: Vec3[]): Float64Array {
  const layout = packLayout(cams.length, pts.length);
  const v = new Float64Array(layout.n);
  let k = 0;
  for (let i = 1; i < cams.length; i++) {
    const c = cams[i]!;
    v[k++] = c.C.x;
    v[k++] = c.C.y;
    v[k++] = c.C.z;
    v[k++] = c.yawDeg;
    v[k++] = c.pitchDeg;
    v[k++] = c.rollDeg;
  }
  for (const p of pts) {
    v[k++] = p.x;
    v[k++] = p.y;
    v[k++] = p.z;
  }
  return v;
}

function fromVector(v: Float64Array, cams0: BaCamera[], pts0: Vec3[]): { cams: BaCamera[]; pts: Vec3[] } {
  const cams = cams0.map((c) => ({
    C: { ...c.C },
    yawDeg: c.yawDeg,
    pitchDeg: c.pitchDeg,
    rollDeg: c.rollDeg,
  }));
  const pts = pts0.map((p) => ({ ...p }));
  let k = 0;
  for (let i = 1; i < cams.length; i++) {
    cams[i]!.C = { x: v[k++]!, y: v[k++]!, z: v[k++]! };
    cams[i]!.yawDeg = v[k++]!;
    cams[i]!.pitchDeg = v[k++]!;
    cams[i]!.rollDeg = v[k++]!;
  }
  for (let i = 0; i < pts.length; i++) {
    pts[i] = { x: v[k++]!, y: v[k++]!, z: v[k++]! };
  }
  return { cams, pts };
}

function residuals(
  obs: readonly BaObservation[],
  cams: BaCamera[],
  pts: Vec3[],
  f: number,
  cx: number,
  cy: number,
  huberDelta: number,
): { r: Float64Array; cost: number; nValid: number } {
  const r = new Float64Array(obs.length * 2);
  let cost = 0;
  let nValid = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i]!;
    const cam = cams[o.frame];
    const X = pts[o.pointId];
    if (!cam || !X) {
      r[i * 2] = 0;
      r[i * 2 + 1] = 0;
      continue;
    }
    const R = yprToR(cam.yawDeg, cam.pitchDeg, cam.rollDeg);
    const proj = projectPoint(R, cam.C, X, f, cx, cy);
    if (!proj) {
      r[i * 2] = 100;
      r[i * 2 + 1] = 100;
      cost += 2 * 100 * 100;
      continue;
    }
    const w = o.weight ?? 1;
    let dx = (proj.u - o.x) * w;
    let dy = (proj.v - o.y) * w;
    const hw = huberWeight(Math.hypot(dx, dy), huberDelta);
    dx *= Math.sqrt(hw);
    dy *= Math.sqrt(hw);
    r[i * 2] = dx;
    r[i * 2 + 1] = dy;
    cost += dx * dx + dy * dy;
    nValid++;
  }
  return { r, cost, nValid };
}

/** Dense JTJ / JTr via finite differences (small track sets). */
function accumulateNormal(
  obs: readonly BaObservation[],
  cams: BaCamera[],
  pts: Vec3[],
  v: Float64Array,
  f: number,
  cx: number,
  cy: number,
  huberDelta: number,
  lambda: number,
): { JTJ: Float64Array; JTr: Float64Array; cost: number; nValid: number } {
  const n = v.length;
  const { r: r0, cost, nValid } = residuals(obs, cams, pts, f, cx, cy, huberDelta);
  const JTJ = new Float64Array(n * n);
  const JTr = new Float64Array(n);
  const cols: Float64Array[] = new Array(n);
  const eps = 1e-4;

  for (let j = 0; j < n; j++) {
    const vp = Float64Array.from(v);
    vp[j]! += eps;
    const { cams: cp, pts: pp } = fromVector(vp, cams, pts);
    const { r: rp } = residuals(obs, cp, pp, f, cx, cy, huberDelta);
    const col = new Float64Array(r0.length);
    for (let i = 0; i < r0.length; i++) col[i] = (rp[i]! - r0[i]!) / eps;
    cols[j] = col;
  }

  for (let j = 0; j < n; j++) {
    const cj = cols[j]!;
    let jtr = 0;
    for (let i = 0; i < r0.length; i++) jtr += cj[i]! * r0[i]!;
    JTr[j] = jtr;
    for (let k = 0; k <= j; k++) {
      const ck = cols[k]!;
      let s = 0;
      for (let i = 0; i < r0.length; i++) s += cj[i]! * ck[i]!;
      JTJ[j * n + k] = s;
      JTJ[k * n + j] = s;
    }
    JTJ[j * n + j]! += lambda;
  }
  return { JTJ, JTr, cost, nValid };
}

function solveDense(JTJ: Float64Array, JTr: Float64Array, n: number): Float64Array | null {
  // Gaussian elimination with partial pivot on copy
  const A = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i * (n + 1) + j] = JTJ[i * n + j]!;
    A[i * (n + 1) + n] = JTr[i]!;
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(A[col * (n + 1) + col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * (n + 1) + col]!);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) return null;
    if (piv !== col) {
      for (let j = col; j <= n; j++) {
        const tmp = A[col * (n + 1) + j]!;
        A[col * (n + 1) + j] = A[piv * (n + 1) + j]!;
        A[piv * (n + 1) + j] = tmp;
      }
    }
    const diag = A[col * (n + 1) + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = A[r * (n + 1) + col]! / diag;
      for (let j = col; j <= n; j++) A[r * (n + 1) + j]! -= f * A[col * (n + 1) + j]!;
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = A[i * (n + 1) + n]!;
    for (let j = i + 1; j < n; j++) s -= A[i * (n + 1) + j]! * x[j]!;
    x[i] = s / A[i * (n + 1) + i]!;
  }
  return x;
}

/**
 * Refine cameras + points. Camera 0 is held fixed (gauge). Returns updated
 * copies; on failure / empty free params returns the input with measured RMS.
 */
export function bundleAdjust(
  observations: readonly BaObservation[],
  cameras: BaCamera[],
  points: Vec3[],
  opts: BaOptions,
): BaResult {
  const maxIters = opts.maxIters ?? 12;
  const huberDelta = opts.huberDelta ?? 4;
  let lambda = opts.lambda0 ?? 1e-2;
  let cams = cameras.map((c) => ({ C: { ...c.C }, yawDeg: c.yawDeg, pitchDeg: c.pitchDeg, rollDeg: c.rollDeg }));
  let pts = points.map((p) => ({ ...p }));

  const layout = packLayout(cams.length, pts.length);
  if (layout.n === 0 || observations.length < 4) {
    const { cost, nValid } = residuals(observations, cams, pts, opts.focal, opts.cx, opts.cy, huberDelta);
    return {
      cameras: cams,
      points: pts,
      rmsPx: nValid > 0 ? Math.sqrt(cost / (nValid * 2)) : 999,
      iters: 0,
    };
  }

  let v = toVector(cams, pts);
  let { cost: bestCost, nValid } = residuals(observations, cams, pts, opts.focal, opts.cx, opts.cy, huberDelta);
  let iters = 0;

  for (; iters < maxIters; iters++) {
    const { JTJ, JTr, cost } = accumulateNormal(
      observations, cams, pts, v, opts.focal, opts.cx, opts.cy, huberDelta, lambda,
    );
    bestCost = cost;
    const delta = solveDense(JTJ, JTr, layout.n);
    if (!delta) {
      lambda *= 10;
      continue;
    }
    const trial = new Float64Array(layout.n);
    for (let i = 0; i < layout.n; i++) trial[i] = v[i]! - delta[i]!;
    const { cams: tc, pts: tp } = fromVector(trial, cams, pts);
    const { cost: trialCost, nValid: nv } = residuals(
      observations, tc, tp, opts.focal, opts.cx, opts.cy, huberDelta,
    );
    nValid = nv;
    if (trialCost < bestCost) {
      v = trial;
      cams = tc;
      pts = tp;
      bestCost = trialCost;
      lambda = Math.max(1e-8, lambda * 0.3);
    } else {
      lambda *= 8;
      if (lambda > 1e8) break;
    }
  }

  return {
    cameras: cams,
    points: pts,
    rmsPx: nValid > 0 ? Math.sqrt(bestCost / (nValid * 2)) : 999,
    iters,
  };
}
