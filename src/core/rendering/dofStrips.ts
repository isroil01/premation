/**
 * Depth-of-field for flat 3D quads that span depth (tilted cards, ground planes).
 *
 * Preferred path: {@link planDofCocCorners} — four corner CoC radii for a
 * per-pixel variable-radius gather in the renderer (`coc-blur`). Fallback:
 * {@link planDofStrips} subdivides into UV strips/grids with uniform blur each
 * (used only when the GPU path cannot take corners).
 *
 * Extrusion faces already carry per-face CoC in buildSnapshot.
 */

import { dofBlurPx, type DofConfig } from '@core/scene/camera3d';

export interface DofStripPlan {
  /** Texture UV crop in 0..1. */
  uvRect: { x: number; y: number; width: number; height: number };
  /**
   * Remap of the parent layer's 2×3 affine matrix so a unit quad draws only
   * this strip. Column-major [a,b,c,d,tx,ty] — same layout as RenderLayer.matrix.
   */
  matrix: readonly [number, number, number, number, number, number];
  /** View depth at the strip centre (for painter sort + dofBlurPx). */
  depth: number;
  /** Blur radius px for this strip. */
  blurPx: number;
}

const MAX_STRIPS = 12;
/** Minimum CoC delta (px) across the quad before we bother splitting. */
const MIN_BLUR_SPAN = 1.25;
/** Per-axis cap for the 2D CoC grid (5×5 = 25 tiles max). */
const MAX_GRID = 5;

/**
 * Per-pixel planar CoC: blur radii (px) at UV corners (0,0), (1,0), (1,1), (0,1).
 * Null when the span is too small — caller keeps a single uniform `dof` blur.
 */
export function planDofCocCorners(
  cornerDepths: readonly [number, number, number, number],
  dof: DofConfig,
): { corners: [number, number, number, number]; maxPx: number } | null {
  const blur = (d: number) => dofBlurPx(d, dof);
  const corners: [number, number, number, number] = [
    Number(blur(cornerDepths[0]).toFixed(2)),
    Number(blur(cornerDepths[1]).toFixed(2)),
    Number(blur(cornerDepths[2]).toFixed(2)),
    Number(blur(cornerDepths[3]).toFixed(2)),
  ];
  const maxPx = Math.max(...corners);
  const minPx = Math.min(...corners);
  if (maxPx - minPx < MIN_BLUR_SPAN) return null;
  if (maxPx < 0.3) return null;
  return { corners, maxPx: Number(maxPx.toFixed(1)) };
}

/**
 * Plan DOF strips for a depth-spanning quad.
 *
 * @param matrix Parent layer affine (unit UV → screen), length ≥ 6
 * @param cornerDepths Depths at UV corners: (0,0), (1,0), (1,1), (0,1)
 */
export function planDofStrips(
  matrix: readonly number[],
  cornerDepths: readonly [number, number, number, number],
  dof: DofConfig,
  maxStrips = MAX_STRIPS,
): DofStripPlan[] | null {
  if (matrix.length < 6) return null;
  const [d00, d10, d11, d01] = cornerDepths;
  const blur = (d: number) => dofBlurPx(d, dof);
  const b00 = blur(d00);
  const b10 = blur(d10);
  const b11 = blur(d11);
  const b01 = blur(d01);
  const blurMin = Math.min(b00, b10, b11, b01);
  const blurMax = Math.max(b00, b10, b11, b01);
  if (blurMax - blurMin < MIN_BLUR_SPAN) return null;

  // Depth gradient along U (left→right) vs V (top→bottom).
  const midL = (d00 + d01) / 2;
  const midR = (d10 + d11) / 2;
  const midT = (d00 + d10) / 2;
  const midB = (d01 + d11) / 2;
  const spanU = Math.abs(midR - midL);
  const spanV = Math.abs(midB - midT);
  const axis: 'u' | 'v' = spanU >= spanV ? 'u' : 'v';

  // More strips when the blur span is larger; at least 2, at most maxStrips.
  const n = Math.max(2, Math.min(maxStrips, Math.ceil((blurMax - blurMin) / 2)));

  const a = matrix[0]!;
  const b = matrix[1]!;
  const c = matrix[2]!;
  const d = matrix[3]!;
  const tx = matrix[4]!;
  const ty = matrix[5]!;

  const lerpDepth = (u: number, v: number): number => {
    const top = d00 + (d10 - d00) * u;
    const bot = d01 + (d11 - d01) * u;
    return top + (bot - top) * v;
  };

  const tile = (u0: number, u1: number, v0: number, v1: number): DofStripPlan => {
    const du = u1 - u0;
    const dv = v1 - v0;
    const uMid = (u0 + u1) / 2;
    const vMid = (v0 + v1) / 2;
    const depth = lerpDepth(uMid, vMid);
    return {
      uvRect: { x: u0, y: v0, width: du, height: dv },
      matrix: [a * du, b * du, c * dv, d * dv, a * u0 + c * v0 + tx, b * u0 + d * v0 + ty],
      depth,
      blurPx: Number(blur(depth).toFixed(1)),
    };
  };

  // Both axes span meaningful CoC → 2D grid (tilted cards). One-axis strips
  // stay for ground planes / simple ramps so we don't explode layer count.
  const blurSpanU = Math.abs(blur(midR) - blur(midL));
  const blurSpanV = Math.abs(blur(midB) - blur(midT));
  if (blurSpanU >= MIN_BLUR_SPAN && blurSpanV >= MIN_BLUR_SPAN) {
    const nu = Math.max(2, Math.min(MAX_GRID, Math.ceil(blurSpanU / 2)));
    const nv = Math.max(2, Math.min(MAX_GRID, Math.ceil(blurSpanV / 2)));
    const plans: DofStripPlan[] = [];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const p = tile(i / nu, (i + 1) / nu, j / nv, (j + 1) / nv);
        if (p.blurPx < 0.3 && blurMax < 0.3) continue;
        plans.push(p);
      }
    }
    return plans.length >= 4 ? plans : null;
  }

  const plans: DofStripPlan[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const p = axis === 'u' ? tile(t0, t1, 0, 1) : tile(0, 1, t0, t1);
    if (p.blurPx < 0.3 && blurMax < 0.3) continue;
    plans.push(p);
  }

  return plans.length >= 2 ? plans : null;
}

/**
 * Corner depths of a layer quad from its world3d matrix and size.
 * Local frame is centred: corners at (±w/2, ±h/2, 0).
 */
export function layerCornerDepths(
  world3d: readonly number[],
  width: number,
  height: number,
  project: (p: { x: number; y: number; z: number }) => { depth: number; clipped?: boolean },
): [number, number, number, number] | null {
  if (world3d.length < 16) return null;
  const hw = width / 2;
  const hh = height / 2;
  // UV order: (0,0)=top-left in texture space. Layer local Y+ is typically down
  // in this editor; match UV: v=0 → y=-hh (top), v=1 → y=+hh (bottom).
  const locals: Array<[number, number]> = [
    [-hw, -hh], // u=0,v=0
    [hw, -hh], // u=1,v=0
    [hw, hh], // u=1,v=1
    [-hw, hh], // u=0,v=1
  ];
  const out: number[] = [];
  for (const [lx, ly] of locals) {
    // Column-major 4×4 × (lx, ly, 0, 1)
    const x = world3d[0]! * lx + world3d[4]! * ly + world3d[12]!;
    const y = world3d[1]! * lx + world3d[5]! * ly + world3d[13]!;
    const z = world3d[2]! * lx + world3d[6]! * ly + world3d[14]!;
    const p = project({ x, y, z });
    if (p.clipped) return null;
    out.push(p.depth);
  }
  return out as [number, number, number, number];
}
