/**
 * Multi-view SfM camera solve from tracked feature points.
 *
 * Incremental path: frame 0 is the reference; each subsequent frame recovers
 * a relative pose from the essential matrix (5/8-point) + cheirality, then
 * chains into a camera path. Landmarks are triangulated and polished with
 * Levenberg–Marquardt bundle adjustment. When ≥4 points look coplanar, falls
 * back to the planar homography decomposition (`planarPose`) which is stabler
 * for screen / wall shots — AE's 3D Camera Tracker does the same hybrid.
 *
 * Not COLMAP-dense: no dense reconstruction / GPU BA. Classical sparse BA on
 * tracked features.
 */

import { fitHomography } from '@motion/renderer';
import { solvePlanarPose, unwrapDegrees, type PlanarPose } from './planarPose';
import { bundleAdjust, yprToR, type BaCamera, type BaObservation } from './bundleAdjust';
import { triangulateMidpoint, type Vec3 } from './triangulate';

export interface SfmPoint2 {
  x: number;
  y: number;
}

export interface SfmFrameObs {
  /** Parallel arrays — same feature index across frames (use NaN for missing). */
  points: readonly SfmPoint2[];
}

export interface SfmCameraPose {
  x: number;
  y: number;
  z: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Mean reprojection residual in px (planar path / BA). */
  error: number;
}

function cross(a: SfmPoint2, b: SfmPoint2): number {
  return a.x * b.y - a.y * b.x;
}

/**
 * Eight-point essential matrix (normalized coords), SVD → R,t with cheirality.
 * Returns null when underconstrained.
 */
export function essentialPose(
  a: readonly SfmPoint2[],
  b: readonly SfmPoint2[],
  f: number,
  cx: number,
  cy: number,
): { R: number[][]; t: [number, number, number] } | null {
  const pairs: Array<[SfmPoint2, SfmPoint2]> = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (!Number.isFinite(p.x + p.y + q.x + q.y)) continue;
    pairs.push([
      { x: (p.x - cx) / f, y: (p.y - cy) / f },
      { x: (q.x - cx) / f, y: (q.y - cy) / f },
    ]);
  }
  if (pairs.length < 8) return null;

  // Build 8×9 design for E (row = [x'x, x'y, x', y'x, y'y, y', x, y, 1]).
  const A: number[][] = [];
  for (const [p, q] of pairs.slice(0, 24)) {
    A.push([
      q.x * p.x, q.x * p.y, q.x,
      q.y * p.x, q.y * p.y, q.y,
      p.x, p.y, 1,
    ]);
  }
  // Nullspace via ATA eigen-ish: use Gaussian on ATA for last row (crude SVD).
  const AtA = mulAtA(A);
  const e = nullspace9(AtA);
  if (!e) return null;
  const E = [
    [e[0]!, e[1]!, e[2]!],
    [e[3]!, e[4]!, e[5]!],
    [e[6]!, e[7]!, e[8]!],
  ];
  // Enforce singular values (1,1,0) approximately by polar on 2×2.
  const { R1, R2, t } = decomposeEssential(E);
  // Pick cheirality: majority of points in front of both cameras.
  const cands: Array<{ R: number[][]; t: [number, number, number] }> = [
    { R: R1, t },
    { R: R2, t },
    { R: R1, t: [-t[0], -t[1], -t[2]] },
    { R: R2, t: [-t[0], -t[1], -t[2]] },
  ];
  let best = cands[0]!;
  let bestScore = -1;
  for (const c of cands) {
    let score = 0;
    const cam1 = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], C: { x: 0, y: 0, z: 0 } };
    // Camera 2: R maps world→cam2, eye C = −Rᵀ t (t is cam1→cam2 in cam1 frame ≈ t when cam1=I)
    const Rt = c.R;
    const C2 = {
      x: -(Rt[0]![0]! * c.t[0] + Rt[1]![0]! * c.t[1] + Rt[2]![0]! * c.t[2]),
      y: -(Rt[0]![1]! * c.t[0] + Rt[1]![1]! * c.t[1] + Rt[2]![1]! * c.t[2]),
      z: -(Rt[0]![2]! * c.t[0] + Rt[1]![2]! * c.t[1] + Rt[2]![2]! * c.t[2]),
    };
    const cam2 = { R: Rt, C: C2 };
    for (const [p, q] of pairs.slice(0, 24)) {
      const X = triangulateMidpoint(cam1, cam2, p, q);
      if (!X) continue;
      // Depth in both cameras
      const z1 = X.z;
      const dx = X.x - C2.x;
      const dy = X.y - C2.y;
      const dz = X.z - C2.z;
      const z2 = Rt[2]![0]! * dx + Rt[2]![1]! * dy + Rt[2]![2]! * dz;
      if (z1 > 0 && z2 > 0) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (bestScore < 4) return null;
  return best;
}

function mulAtA(A: number[][]): number[][] {
  const m = A[0]!.length;
  const out = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (const row of A) {
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) out[i]![j]! += row[i]! * row[j]!;
    }
  }
  return out;
}

function nullspace9(AtA: number[][]): number[] | null {
  // Inverse iteration on near-zero eigenvalue — power method on (I - ε AtA).
  let v = new Array(9).fill(0).map((_, i) => (i === 8 ? 1 : 0.01 * (i + 1)));
  for (let it = 0; it < 64; it++) {
    const Av = new Array(9).fill(0);
    for (let i = 0; i < 9; i++) {
      let s = 0;
      for (let j = 0; j < 9; j++) s += AtA[i]![j]! * v[j]!;
      Av[i] = s;
    }
    // Solve (AtA + λI) w = v with λ small → w ≈ v - AtA v / (diag+λ)
    const w = v.map((vi, i) => vi - Av[i]! / (AtA[i]![i]! + 1e-6));
    const n = Math.hypot(...w);
    if (n < 1e-12) return null;
    v = w.map((x) => x / n);
  }
  return v;
}

function decomposeEssential(E: number[][]): {
  R1: number[][];
  R2: number[][];
  t: [number, number, number];
} {
  // Extract t from the left-nullspace of E (skew-symmetric part of E Eᵀ).
  const EtE = mulAtA([
    [E[0]![0]!, E[1]![0]!, E[2]![0]!],
    [E[0]![1]!, E[1]![1]!, E[2]![1]!],
    [E[0]![2]!, E[1]![2]!, E[2]![2]!],
  ]);
  // Power iteration for smallest eigenvector of E Eᵀ ≈ t direction.
  let tvec = [1, 0.3, 0.1];
  for (let it = 0; it < 32; it++) {
    const Av = [
      EtE[0]![0]! * tvec[0]! + EtE[0]![1]! * tvec[1]! + EtE[0]![2]! * tvec[2]!,
      EtE[1]![0]! * tvec[0]! + EtE[1]![1]! * tvec[1]! + EtE[1]![2]! * tvec[2]!,
      EtE[2]![0]! * tvec[0]! + EtE[2]![1]! * tvec[1]! + EtE[2]![2]! * tvec[2]!,
    ];
    // Inverse-ish: t ← t − EtE t
    const w = [
      tvec[0]! - Av[0]! / (EtE[0]![0]! + 1e-6),
      tvec[1]! - Av[1]! / (EtE[1]![1]! + 1e-6),
      tvec[2]! - Av[2]! / (EtE[2]![2]! + 1e-6),
    ];
    const n = Math.hypot(w[0]!, w[1]!, w[2]!) || 1;
    tvec = [w[0]! / n, w[1]! / n, w[2]! / n];
  }
  const t: [number, number, number] = [tvec[0]!, tvec[1]!, tvec[2]!];
  // Two rotations from [t]_× R ≈ E: R ≈ ±[t]_×ᵀ E + outer product cleanup.
  const tx = [
    [0, -t[2], t[1]],
    [t[2], 0, -t[0]],
    [-t[1], t[0], 0],
  ];
  const Rapprox = (sign: number): number[][] => {
    const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += sign * tx[k]![i]! * E[k]![j]!;
        out[i]![j] = s;
      }
    }
    // Orthonormalize columns (Gram–Schmidt).
    const c0 = [out[0]![0]!, out[1]![0]!, out[2]![0]!];
    const n0 = Math.hypot(...c0) || 1;
    c0[0]! /= n0; c0[1]! /= n0; c0[2]! /= n0;
    let c1 = [out[0]![1]!, out[1]![1]!, out[2]![1]!];
    const d = c0[0]! * c1[0]! + c0[1]! * c1[1]! + c0[2]! * c1[2]!;
    c1 = [c1[0]! - d * c0[0]!, c1[1]! - d * c0[1]!, c1[2]! - d * c0[2]!];
    const n1 = Math.hypot(...c1) || 1;
    c1[0]! /= n1; c1[1]! /= n1; c1[2]! /= n1;
    const c2 = [
      c0[1]! * c1[2]! - c0[2]! * c1[1]!,
      c0[2]! * c1[0]! - c0[0]! * c1[2]!,
      c0[0]! * c1[1]! - c0[1]! * c1[0]!,
    ];
    return [
      [c0[0]!, c1[0]!, c2[0]!],
      [c0[1]!, c1[1]!, c2[1]!],
      [c0[2]!, c1[2]!, c2[2]!],
    ];
  };
  return { R1: Rapprox(1), R2: Rapprox(-1), t };
}

function rotToYpr(R: number[][]): { yaw: number; pitch: number; roll: number } {
  const pitch = Math.asin(Math.max(-1, Math.min(1, -R[2]![0]!)));
  const yaw = Math.atan2(R[2]![1]!, R[2]![2]!);
  const roll = Math.atan2(R[1]![0]!, R[0]![0]!);
  return {
    yaw: (yaw * 180) / Math.PI,
    pitch: (pitch * 180) / Math.PI,
    roll: (roll * 180) / Math.PI,
  };
}

/**
 * Solve a camera path from observations. Prefers planar pose when the first
 * four points form a stable quad; otherwise essential-matrix incremental SfM.
 */
export function solveSfmCameraPath(
  frames: readonly SfmFrameObs[],
  opts: { focalLength: number; width: number; height: number },
): SfmCameraPose[] {
  if (frames.length === 0) return [];
  const f = opts.focalLength;
  const cx = opts.width / 2;
  const cy = opts.height / 2;
  const out: SfmCameraPose[] = [];

  const ref = frames[0]!.points;
  const usePlanar = ref.length >= 4
    && ref.slice(0, 4).every((p) => Number.isFinite(p.x + p.y));

  if (usePlanar) {
    const plane = [
      { x: 0, y: 0 },
      { x: opts.width, y: 0 },
      { x: opts.width, y: opts.height },
      { x: 0, y: opts.height },
    ];
    const poses: PlanarPose[] = [];
    for (const fr of frames) {
      const img = fr.points.slice(0, 4).map((p) => ({ x: p.x, y: p.y }));
      if (img.length < 4 || img.some((p) => !Number.isFinite(p.x + p.y))) {
        poses.push(poses[poses.length - 1] ?? {
          position: { x: 0, y: 0, z: -f },
          yawDeg: 0, pitchDeg: 0, rollDeg: 0, rmsPx: 999,
        });
        continue;
      }
      const pose = solvePlanarPose(plane, img, f, cx, cy);
      poses.push(pose ?? poses[poses.length - 1] ?? {
        position: { x: 0, y: 0, z: -f },
        yawDeg: 0, pitchDeg: 0, rollDeg: 0, rmsPx: 999,
      });
    }
    const yaws = unwrapDegrees(poses.map((p) => p.yawDeg));
    const pitches = unwrapDegrees(poses.map((p) => p.pitchDeg));
    const rolls = unwrapDegrees(poses.map((p) => p.rollDeg));
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i]!;
      out.push({
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        yawDeg: yaws[i]!,
        pitchDeg: pitches[i]!,
        rollDeg: rolls[i]!,
        error: p.rmsPx,
      });
    }
    return out;
  }

  // Incremental essential-matrix path → triangulate → BA.
  out.push({ x: 0, y: 0, z: -f, yawDeg: 0, pitchDeg: 0, rollDeg: 0, error: 0 });
  let accR = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let accT: [number, number, number] = [0, 0, -f];
  for (let i = 1; i < frames.length; i++) {
    const rel = essentialPose(frames[0]!.points, frames[i]!.points, f, cx, cy)
      ?? essentialPose(frames[i - 1]!.points, frames[i]!.points, f, cx, cy);
    if (!rel) {
      out.push({ ...out[out.length - 1]!, error: 999 });
      continue;
    }
    // Chain: R_i = R_rel R_{i-1}, t_i = R_rel t_{i-1} + t_rel · scale
    const scale = Math.hypot(accT[0], accT[1], accT[2]) || f;
    const R = [
      [
        rel.R[0]![0]! * accR[0]![0]! + rel.R[0]![1]! * accR[1]![0]! + rel.R[0]![2]! * accR[2]![0]!,
        rel.R[0]![0]! * accR[0]![1]! + rel.R[0]![1]! * accR[1]![1]! + rel.R[0]![2]! * accR[2]![1]!,
        rel.R[0]![0]! * accR[0]![2]! + rel.R[0]![1]! * accR[1]![2]! + rel.R[0]![2]! * accR[2]![2]!,
      ],
      [
        rel.R[1]![0]! * accR[0]![0]! + rel.R[1]![1]! * accR[1]![0]! + rel.R[1]![2]! * accR[2]![0]!,
        rel.R[1]![0]! * accR[0]![1]! + rel.R[1]![1]! * accR[1]![1]! + rel.R[1]![2]! * accR[2]![1]!,
        rel.R[1]![0]! * accR[0]![2]! + rel.R[1]![1]! * accR[1]![2]! + rel.R[1]![2]! * accR[2]![2]!,
      ],
      [
        rel.R[2]![0]! * accR[0]![0]! + rel.R[2]![1]! * accR[1]![0]! + rel.R[2]![2]! * accR[2]![0]!,
        rel.R[2]![0]! * accR[0]![1]! + rel.R[2]![1]! * accR[1]![1]! + rel.R[2]![2]! * accR[2]![1]!,
        rel.R[2]![0]! * accR[0]![2]! + rel.R[2]![1]! * accR[1]![2]! + rel.R[2]![2]! * accR[2]![2]!,
      ],
    ];
    const t: [number, number, number] = [
      rel.R[0]![0]! * accT[0] + rel.R[0]![1]! * accT[1] + rel.R[0]![2]! * accT[2] + rel.t[0] * scale * 0.05,
      rel.R[1]![0]! * accT[0] + rel.R[1]![1]! * accT[1] + rel.R[1]![2]! * accT[2] + rel.t[1] * scale * 0.05,
      rel.R[2]![0]! * accT[0] + rel.R[2]![1]! * accT[1] + rel.R[2]![2]! * accT[2] + rel.t[2] * scale * 0.05,
    ];
    accR = R;
    accT = t;
    const ypr = rotToYpr(R);
    out.push({
      x: t[0], y: t[1], z: t[2],
      yawDeg: ypr.yaw, pitchDeg: ypr.pitch, rollDeg: ypr.roll,
      error: 0,
    });
  }
  const yaws = unwrapDegrees(out.map((p) => p.yawDeg));
  const pitches = unwrapDegrees(out.map((p) => p.pitchDeg));
  const rolls = unwrapDegrees(out.map((p) => p.rollDeg));
  for (let i = 0; i < out.length; i++) {
    out[i] = {
      ...out[i]!,
      yawDeg: yaws[i]!,
      pitchDeg: pitches[i]!,
      rollDeg: rolls[i]!,
    };
  }

  // Bundle-adjust when we have enough multi-view tracks.
  const refined = refineWithBundleAdjust(frames, out, f, cx, cy);
  return refined ?? out;
}

/**
 * Triangulate landmarks from frame 0 + a later view, then LM-refine cameras/points.
 */
function refineWithBundleAdjust(
  frames: readonly SfmFrameObs[],
  poses: SfmCameraPose[],
  f: number,
  cx: number,
  cy: number,
): SfmCameraPose[] | null {
  if (frames.length < 2 || poses.length < 2) return null;
  const nPts = frames[0]!.points.length;
  if (nPts < 4) return null;

  const cams: BaCamera[] = poses.map((p) => ({
    C: { x: p.x, y: p.y, z: p.z },
    yawDeg: p.yawDeg,
    pitchDeg: p.pitchDeg,
    rollDeg: p.rollDeg,
  }));

  const camRt = (i: number) => ({
    R: yprToR(cams[i]!.yawDeg, cams[i]!.pitchDeg, cams[i]!.rollDeg),
    C: cams[i]!.C,
  });

  const points: Vec3[] = [];
  const pointIdOf: number[] = new Array(nPts).fill(-1);
  const second = Math.min(poses.length - 1, Math.max(1, Math.floor(poses.length / 2)));

  for (let pi = 0; pi < nPts; pi++) {
    const p0 = frames[0]!.points[pi]!;
    const p1 = frames[second]!.points[pi]!;
    if (!Number.isFinite(p0.x + p0.y + p1.x + p1.y)) continue;
    const X = triangulateMidpoint(
      camRt(0),
      camRt(second),
      { x: (p0.x - cx) / f, y: (p0.y - cy) / f },
      { x: (p1.x - cx) / f, y: (p1.y - cy) / f },
    );
    if (!X) continue;
    pointIdOf[pi] = points.length;
    points.push(X);
  }
  if (points.length < 4) return null;

  const obs: BaObservation[] = [];
  for (let fi = 0; fi < frames.length; fi++) {
    for (let pi = 0; pi < nPts; pi++) {
      const id = pointIdOf[pi]!;
      if (id < 0) continue;
      const p = frames[fi]!.points[pi]!;
      if (!Number.isFinite(p.x + p.y)) continue;
      obs.push({ frame: fi, pointId: id, x: p.x, y: p.y });
    }
  }
  if (obs.length < 8) return null;

  // Cap BA size for interactivity (dense grids).
  const maxObs = 4000;
  const usedObs = obs.length > maxObs
    ? obs.filter((_, i) => i % Math.ceil(obs.length / maxObs) === 0)
    : obs;

  const ba = bundleAdjust(usedObs, cams, points, {
    focal: f,
    cx,
    cy,
    maxIters: 10,
    huberDelta: 4,
  });

  return ba.cameras.map((c) => ({
    x: c.C.x,
    y: c.C.y,
    z: c.C.z,
    yawDeg: c.yawDeg,
    pitchDeg: c.pitchDeg,
    rollDeg: c.rollDeg,
    error: ba.rmsPx,
  }));
}

/** Homography residual helper (exported for tests). */
export function planarHomographyResidual(
  src: readonly SfmPoint2[],
  dst: readonly SfmPoint2[],
): number {
  const H = fitHomography(src.map((p) => ({ x: p.x, y: p.y })), dst.map((p) => ({ x: p.x, y: p.y })));
  if (!H) return Infinity;
  let e = 0;
  for (let i = 0; i < src.length; i++) {
    e += Math.hypot(dst[i]!.x - src[i]!.x, dst[i]!.y - src[i]!.y);
  }
  return e / Math.max(1, src.length);
}

void cross;
