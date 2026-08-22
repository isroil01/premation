/**
 * Subspace-warp + rolling-shutter math — Warp Stabilizer's remaining half.
 *
 * Smooth Stabilize already removes a global similarity shake. Subspace warp
 * fits a GRID of local similarities so the frame can bend (parallax / flex).
 * Rolling-shutter repair estimates a per-row horizontal shear from vertical
 * scan velocity in the same flow field.
 *
 * Pure + deterministic. Apply paths write Mesh Warp / position keyframes;
 * this module only solves.
 */

import type { FlowField } from '@core/rendering/pixelMotionFlow';
import {
  applySim,
  fitSimilarity,
  flowSamplePoints,
  type MotionSamplePoint,
  type Sim,
  IDENTITY_SIM,
} from './globalMotion';

export interface SubspaceCell {
  /** Cell centre in the same coordinates as the flow samples. */
  cx: number;
  cy: number;
  /** Local similarity (identity when under-constrained). */
  sim: Sim;
}

/**
 * Fit an `rows×cols` grid of local similarities from one flow field.
 * Each cell uses samples inside its rectangle (with a small overlap margin).
 */
export function fitSubspaceWarp(
  field: FlowField,
  rows = 3,
  cols = 3,
  scaleX = 1,
  scaleY = 1,
): SubspaceCell[] {
  const pts = flowSamplePoints(field, scaleX, scaleY);
  const w = field.cols * field.step * scaleX;
  const h = field.rows * field.step * scaleY;
  const out: SubspaceCell[] = [];
  const margin = 0.15;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = (c / cols) * w;
      const x1 = ((c + 1) / cols) * w;
      const y0 = (r / rows) * h;
      const y1 = ((r + 1) / rows) * h;
      const mw = (x1 - x0) * margin;
      const mh = (y1 - y0) * margin;
      const local: MotionSamplePoint[] = [];
      for (const p of pts) {
        if (p.x >= x0 - mw && p.x < x1 + mw && p.y >= y0 - mh && p.y < y1 + mh) {
          local.push(p);
        }
      }
      const sim = fitSimilarity(local, 1) ?? IDENTITY_SIM;
      out.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, sim });
    }
  }
  return out;
}

/**
 * Estimate rolling-shutter shear: horizontal displacement as a linear function
 * of row (`dx = k * (y - cy)`). Returns `k` in px-per-px (dimensionless).
 * Positive k = top rows lag left relative to the centre (classic CMOS readout).
 */
export function estimateRollingShutterShear(
  field: FlowField,
  scaleX = 1,
  scaleY = 1,
): number {
  const pts = flowSamplePoints(field, scaleX, scaleY);
  if (pts.length < 8) return 0;
  let cy = 0;
  for (const p of pts) cy += p.y;
  cy /= pts.length;
  // dx ≈ k * (y − cy)  →  k = Σ dx(y−cy) / Σ (y−cy)²
  let num = 0;
  let den = 0;
  for (const p of pts) {
    const dy = p.y - cy;
    num += p.dx * dy;
    den += dy * dy;
  }
  if (den < 1e-6) return 0;
  return num / den;
}

/** Apply rolling-shutter shear to a point (inverse repair: subtract estimated lag). */
export function applyRollingShutterRepair(
  x: number,
  y: number,
  cy: number,
  shearK: number,
): [number, number] {
  return [x - shearK * (y - cy), y];
}

/** Evaluate a subspace grid at (x,y) by bilinear blend of the four nearest cell sims. */
export function sampleSubspace(
  cells: readonly SubspaceCell[],
  rows: number,
  cols: number,
  x: number,
  y: number,
  fieldW: number,
  fieldH: number,
): [number, number] {
  if (cells.length !== rows * cols || rows < 1 || cols < 1) return [x, y];
  const u = Math.max(0, Math.min(1, x / Math.max(1e-6, fieldW)));
  const v = Math.max(0, Math.min(1, y / Math.max(1e-6, fieldH)));
  const fx = u * (cols - 1);
  const fy = v * (rows - 1);
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;
  const s00 = cells[r0 * cols + c0]!.sim;
  const s10 = cells[r0 * cols + c1]!.sim;
  const s01 = cells[r1 * cols + c0]!.sim;
  const s11 = cells[r1 * cols + c1]!.sim;
  const [x00, y00] = applySim(s00, x, y);
  const [x10, y10] = applySim(s10, x, y);
  const [x01, y01] = applySim(s01, x, y);
  const [x11, y11] = applySim(s11, x, y);
  const topX = x00 + (x10 - x00) * tx;
  const topY = y00 + (y10 - y00) * tx;
  const botX = x01 + (x11 - x01) * tx;
  const botY = y01 + (y11 - y01) * tx;
  return [topX + (botX - topX) * ty, topY + (botY - topY) * ty];
}
