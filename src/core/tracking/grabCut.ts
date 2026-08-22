/**
 * GrabCut-class matte — FG/BG colour models + iterative unknown labelling.
 *
 * Not OpenCV GrabCut (no graph-cut max-flow). Classical AE foothold:
 * seed flood → trimap (FG / unknown ring / BG) → GMM-lite (per-channel mean
 * + variance) iterates on unknown pixels, then morph clean. Feeds the same
 * mask path as Roto Brush / Seed Matte.
 */

import { floodMatte, morphClose, morphOpen, refineRotoMatte, type RotoSeed } from './rotoMatte';

export interface GrabCutOptions {
  /** Unknown band width around the FG seed (px). */
  unknownRadius?: number;
  iterations?: number;
  featherPx?: number;
}

interface ColourModel {
  mean: [number, number, number];
  var: [number, number, number];
  n: number;
}

function fitModel(rgba: Uint8ClampedArray | Uint8Array, mask: Uint8Array, label: number): ColourModel {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== label) continue;
    sr += rgba[i * 4]!;
    sg += rgba[i * 4 + 1]!;
    sb += rgba[i * 4 + 2]!;
    n++;
  }
  if (n === 0) return { mean: [128, 128, 128], var: [1e4, 1e4, 1e4], n: 0 };
  const mean: [number, number, number] = [sr / n, sg / n, sb / n];
  let vr = 0;
  let vg = 0;
  let vb = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== label) continue;
    const dr = rgba[i * 4]! - mean[0];
    const dg = rgba[i * 4 + 1]! - mean[1];
    const db = rgba[i * 4 + 2]! - mean[2];
    vr += dr * dr;
    vg += dg * dg;
    vb += db * db;
  }
  return {
    mean,
    var: [Math.max(16, vr / n), Math.max(16, vg / n), Math.max(16, vb / n)],
    n,
  };
}

function logLik(model: ColourModel, r: number, g: number, b: number): number {
  const dr = r - model.mean[0];
  const dg = g - model.mean[1];
  const db = b - model.mean[2];
  // −½ Σ (d²/σ²) − ½ log σ²  (drop constants)
  return (
    -0.5 * (dr * dr / model.var[0] + dg * dg / model.var[1] + db * db / model.var[2])
    - 0.5 * (Math.log(model.var[0]) + Math.log(model.var[1]) + Math.log(model.var[2]))
  );
}

/** Dilate binary FG into an unknown band; rest stays BG (0). Labels: 0=BG, 1=unknown, 2=FG. */
function buildTrimap(fg: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const trimap = new Uint8Array(w * h);
  const r = Math.max(1, Math.round(radius));
  for (let i = 0; i < fg.length; i++) {
    if (fg[i]) trimap[i] = 2;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (trimap[i] === 2) continue;
      let near = false;
      for (let dy = -r; dy <= r && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (fg[yy * w + xx]) { near = true; break; }
        }
      }
      if (near) trimap[i] = 1;
    }
  }
  return trimap;
}

/**
 * Run GrabCut-class segmentation from colour seeds.
 * Returns a binary matte (0/255) ready for path extraction / refine.
 */
export function grabCutMatte(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seeds: readonly RotoSeed[],
  opts: GrabCutOptions = {},
): Uint8Array {
  const unknownRadius = opts.unknownRadius ?? 8;
  const iterations = opts.iterations ?? 5;
  const seedFg = floodMatte(rgba, width, height, seeds);
  const trimap = buildTrimap(seedFg, width, height, unknownRadius);
  // Working labels: reuse trimap, reassign unknowns each iter.
  const labels = new Uint8Array(trimap);

  for (let it = 0; it < iterations; it++) {
    const fgMask = new Uint8Array(labels.length);
    const bgMask = new Uint8Array(labels.length);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 2) fgMask[i] = 1;
      else if (labels[i] === 0) bgMask[i] = 1;
    }
    const fg = fitModel(rgba, fgMask, 1);
    const bg = fitModel(rgba, bgMask, 1);
    for (let i = 0; i < labels.length; i++) {
      if (trimap[i] !== 1) continue; // only free unknowns; hard FG/BG stick
      const r = rgba[i * 4]!;
      const g = rgba[i * 4 + 1]!;
      const b = rgba[i * 4 + 2]!;
      labels[i] = logLik(fg, r, g, b) >= logLik(bg, r, g, b) ? 2 : 0;
    }
  }

  let out = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) out[i] = labels[i] === 2 ? 255 : 0;
  out = morphOpen(out, width, height, 1);
  out = morphClose(out, width, height, 1);
  if ((opts.featherPx ?? 0) > 0) {
    return refineRotoMatte(rgba, out, width, height, {
      morphRadius: 1,
      featherPx: opts.featherPx,
    }).mask;
  }
  return out;
}
