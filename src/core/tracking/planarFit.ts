/**
 * Robust planar fitting — the step from "least-squares over every point" to
 * Mocha-class behaviour under occlusion.
 *
 * A plain LS homography treats every correspondence as truth, so one feature
 * that slid onto a passing foreground object drags the whole plane with it.
 * RANSAC inverts the trust model: minimal 4-point fits nominate a plane, the
 * plane keeps the points that agree with it (reprojection under `inlierPx`),
 * and the final homography is LS over that consensus set only.
 *
 * Deterministic by construction (seeded xorshift, no Math.random): a track
 * applied twice writes identical keyframes, and jest can pin exact fits.
 */

import { fitHomography, projectHomography } from '@motion/renderer';

type Vec2 = { x: number; y: number };
type Mat3 = ReturnType<typeof fitHomography>;

export interface RansacOptions {
  /** Max reprojection error (px, source grid) for a point to count as inlier. */
  inlierPx?: number;
  /** Minimal-sample rounds. 64 covers >99.9% for ≤40% outliers. */
  iterations?: number;
  /** PRNG seed — same seed, same fit. */
  seed?: number;
  /** Optional 0..1 weight per correspondence (e.g. tracker confidence).
   *  Points with weight 0 are excluded outright. */
  weights?: ReadonlyArray<number>;
}

export interface RansacFit {
  H: NonNullable<Mat3>;
  /** Per-correspondence inlier flags, input order. */
  inliers: boolean[];
  inlierCount: number;
  /** RMS reprojection error over the inlier set, px. */
  rms: number;
}

function xorshift32(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

function reprojError(H: NonNullable<Mat3>, s: Vec2, d: Vec2): number {
  const p = projectHomography(H, s);
  if (!p) return Infinity;
  return Math.hypot(p.x - d.x, p.y - d.y);
}

/**
 * RANSAC + least-squares homography mapping `src[i]` → `dst[i]`.
 *
 * Returns null when fewer than 4 usable correspondences exist or no model
 * gathers 4 inliers. With exactly 4 usable points RANSAC degenerates to the
 * direct fit (there is no consensus to measure) — callers with only corner
 * handles get the classic behaviour.
 */
export function fitHomographyRansac(
  src: readonly Vec2[],
  dst: readonly Vec2[],
  opts: RansacOptions = {},
): RansacFit | null {
  const inlierPx = opts.inlierPx ?? 3;
  const iterations = opts.iterations ?? 64;
  const n = Math.min(src.length, dst.length);

  // Usable = weight > 0. Order is preserved so inlier flags line up with input.
  const usable: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((opts.weights?.[i] ?? 1) > 0) usable.push(i);
  }
  if (usable.length < 4) return null;

  const finish = (H: NonNullable<Mat3>): RansacFit => {
    const inliers = new Array<boolean>(n).fill(false);
    let count = 0;
    let sq = 0;
    for (const i of usable) {
      const e = reprojError(H, src[i]!, dst[i]!);
      if (e <= inlierPx) {
        inliers[i] = true;
        count += 1;
        sq += e * e;
      }
    }
    return { H, inliers, inlierCount: count, rms: count > 0 ? Math.sqrt(sq / count) : Infinity };
  };

  if (usable.length === 4) {
    const H = fitHomography(usable.map((i) => src[i]!), usable.map((i) => dst[i]!));
    return H ? finish(H) : null;
  }

  const rand = xorshift32(opts.seed ?? 1);
  let best: { idx: number[]; count: number; rms: number } | null = null;

  for (let it = 0; it < iterations; it++) {
    // 4 distinct usable indices.
    const pick: number[] = [];
    while (pick.length < 4) {
      const i = usable[Math.floor(rand() * usable.length)]!;
      if (!pick.includes(i)) pick.push(i);
    }
    const H = fitHomography(pick.map((i) => src[i]!), pick.map((i) => dst[i]!));
    if (!H) continue;
    let count = 0;
    let sq = 0;
    const idx: number[] = [];
    for (const i of usable) {
      const e = reprojError(H, src[i]!, dst[i]!);
      if (e <= inlierPx) {
        count += 1;
        sq += e * e;
        idx.push(i);
      }
    }
    const rms = count > 0 ? Math.sqrt(sq / count) : Infinity;
    if (count >= 4 && (!best || count > best.count || (count === best.count && rms < best.rms))) {
      best = { idx, count, rms };
    }
  }
  if (!best) return null;

  // Final LS over the consensus set — the minimal fit that nominated it is
  // exact on 4 points and noisy; the LS over all inliers is the answer.
  const H = fitHomography(best.idx.map((i) => src[i]!), best.idx.map((i) => dst[i]!));
  return H ? finish(H) : null;
}

/**
 * Densify a tracked quad into an interior grid — the "dense planar grid"
 * setting: TL,TR,BR,BL (+anything after them, kept) plus a bilinear
 * `grid`×`grid` lattice inside the quad, corners excluded. More features →
 * an overdetermined RANSAC fit that survives partial occlusion.
 */
export function densifyQuad(points: ReadonlyArray<Vec2>, grid = 5): Vec2[] {
  if (points.length < 4) return [...points];
  const [tl, tr, br, bl] = [points[0]!, points[1]!, points[2]!, points[3]!];
  const out: Vec2[] = [...points];
  for (let r = 0; r < grid; r++) {
    const v = (r + 0.5) / grid;
    for (let c = 0; c < grid; c++) {
      const u = (c + 0.5) / grid;
      const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
      const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
      out.push({ x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v });
    }
  }
  return out;
}

/**
 * Temporal smooth of a homography sequence (Mocha-class foothold).
 * Element-wise box filter on the 9 column-major entries, then re-normalize
 * so H[8] (bottom-right) = 1. Null slots stay null (gaps don't invent planes).
 */
export function smoothHomographySequence(
  Hs: ReadonlyArray<NonNullable<Mat3> | null>,
  radius = 1,
): Array<NonNullable<Mat3> | null> {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0 || Hs.length === 0) {
    return Hs.map((H) => (H ? new Float32Array(H) : null));
  }
  const out: Array<NonNullable<Mat3> | null> = new Array(Hs.length).fill(null);
  for (let i = 0; i < Hs.length; i++) {
    if (!Hs[i]) continue;
    const acc = new Float32Array(9);
    let n = 0;
    for (let j = i - r; j <= i + r; j++) {
      const H = Hs[j];
      if (!H) continue;
      n += 1;
      for (let k = 0; k < 9; k++) acc[k]! += H[k]!;
    }
    if (n === 0) continue;
    const H = new Float32Array(9);
    for (let k = 0; k < 9; k++) H[k] = acc[k]! / n;
    const s = H[8]!;
    if (Math.abs(s) > 1e-12) {
      for (let k = 0; k < 9; k++) H[k]! /= s;
    }
    out[i] = H;
  }
  return out;
}

/**
 * Corner positions over time from a sequence of plane homographies evaluated
 * at four seed corners. Used after {@link smoothHomographySequence}.
 */
export function cornersFromHomographies(
  Hs: ReadonlyArray<NonNullable<Mat3> | null>,
  seeds: ReadonlyArray<Vec2>,
): Array<Array<Vec2 | null>> {
  return Hs.map((H) => {
    if (!H) return [null, null, null, null];
    return [0, 1, 2, 3].map((c) => {
      const seed = seeds[c];
      if (!seed) return null;
      return projectHomography(H, seed);
    });
  });
}
