/**
 * Depth-of-field strip subdivision.
 *
 * A single 3D quad that spans depth (tilted card, ground plane) used to get one
 * uniform Gaussian from `dofEffectOf(originDepth)`. Extrusion faces already
 * carry per-face CoC; this module does the same for flat quads by splitting
 * them into UV strips along the dominant depth gradient, each with its own
 * blur radius from `dofBlurPx`.
 *
 * Not per-pixel CoC (that needs a sampleable depth buffer). Visibly better for
 * depth-spanning planes without a new renderer pass.
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

const MAX_STRIPS = 8;
/** Minimum CoC delta (px) across the quad before we bother splitting. */
const MIN_BLUR_SPAN = 1.25;

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

  const plans: DofStripPlan[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const tMid = (t0 + t1) / 2;

    let uvRect: DofStripPlan['uvRect'];
    let m: [number, number, number, number, number, number];
    let depth: number;

    if (axis === 'u') {
      // u in [t0,t1], v in [0,1]
      uvRect = { x: t0, y: 0, width: t1 - t0, height: 1 };
      // u = t0 + s*(t1-t0), v = t  →  screen = M · (u,v,1)
      m = [a * (t1 - t0), b * (t1 - t0), c, d, a * t0 + tx, b * t0 + ty];
      // Depth along left-right edges, lerped by tMid.
      const dTop = d00 + (d10 - d00) * tMid;
      const dBot = d01 + (d11 - d01) * tMid;
      depth = (dTop + dBot) / 2;
    } else {
      uvRect = { x: 0, y: t0, width: 1, height: t1 - t0 };
      m = [a, b, c * (t1 - t0), d * (t1 - t0), c * t0 + tx, d * t0 + ty];
      const dLeft = d00 + (d01 - d00) * tMid;
      const dRight = d10 + (d11 - d10) * tMid;
      depth = (dLeft + dRight) / 2;
    }

    const blurPx = Number(blur(depth).toFixed(1));
    if (blurPx < 0.3 && blurMax < 0.3) continue;
    plans.push({ uvRect, matrix: m, depth, blurPx });
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
