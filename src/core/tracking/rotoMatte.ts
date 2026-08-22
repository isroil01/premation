/**
 * Roto-matte foothold — seed flood-fill → soft alpha matte → mask path.
 *
 * Not Roto Brush 3 / SAM: no temporal propagation network. One frame, colour
 * similarity from a brush seed, marching-squares outline written as a mask.
 * Enough to start a matte and hand off to mask tracking.
 */

export interface RotoSeed {
  x: number;
  y: number;
  /** Max ΔE-ish RGB distance in 0..255 space (default 32). */
  tolerance?: number;
}

/**
 * Flood-fill a binary matte from seeds on RGBA8 pixels. Returns Uint8 mask
 * (0/255) same length as pixels/4.
 */
export function floodMatte(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seeds: readonly RotoSeed[],
): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  if (seeds.length === 0 || rgba.length < n * 4) return out;
  const visited = new Uint8Array(n);
  const stack: number[] = [];

  for (const seed of seeds) {
    const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(seed.y)));
    const tol = seed.tolerance ?? 32;
    const si = sy * width + sx;
    const sr = rgba[si * 4]!;
    const sg = rgba[si * 4 + 1]!;
    const sb = rgba[si * 4 + 2]!;
    stack.push(si);
    while (stack.length) {
      const i = stack.pop()!;
      if (visited[i]) continue;
      visited[i] = 1;
      const r = rgba[i * 4]!;
      const g = rgba[i * 4 + 1]!;
      const b = rgba[i * 4 + 2]!;
      if (Math.abs(r - sr) + Math.abs(g - sg) + Math.abs(b - sb) > tol * 3) continue;
      out[i] = 255;
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0) stack.push(i - 1);
      if (x + 1 < width) stack.push(i + 1);
      if (y > 0) stack.push(i - width);
      if (y + 1 < height) stack.push(i + width);
    }
  }
  return out;
}

export interface MaskPoint {
  x: number;
  y: number;
}

/**
 * Trace the outer boundary of a binary matte (simple Moore neighborhood).
 * Returns polygon vertices in pixel space, or [] if empty.
 */
export function matteToPath(mask: Uint8Array, width: number, height: number): MaskPoint[] {
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { start = i; break; }
  }
  if (start < 0) return [];
  // Boundary cells: any filled texel facing an empty neighbour.
  const pts: MaskPoint[] = [];
  const seen = new Set<string>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const leftEmpty = x === 0 || !mask[i - 1];
      const rightEmpty = x === width - 1 || !mask[i + 1];
      const topEmpty = y === 0 || !mask[i - width];
      const botEmpty = y === height - 1 || !mask[i + width];
      if (!(leftEmpty || rightEmpty || topEmpty || botEmpty)) continue;
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pts.push({ x: x + 0.5, y: y + 0.5 });
    }
  }
  // Decimate to ≤128 verts for mask UX.
  if (pts.length <= 128) return pts;
  const step = Math.ceil(pts.length / 128);
  return pts.filter((_, i) => i % step === 0);
}

/** Dilate a binary matte by a square structuring element of radius r. */
export function morphDilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.max(0, Math.round(radius));
  if (r <= 0) return mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) { on = 255; break; }
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

/** Erode a binary matte by a square structuring element of radius r. */
export function morphErode(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.max(0, Math.round(radius));
  if (r <= 0) return mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 255;
      for (let dy = -r; dy <= r && on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) { on = 0; break; }
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || !mask[yy * w + xx]) { on = 0; break; }
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

/** Open = erode then dilate (drop speckles). Close = dilate then erode (fill holes). */
export function morphOpen(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return morphDilate(morphErode(mask, w, h, radius), w, h, radius);
}

export function morphClose(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return morphErode(morphDilate(mask, w, h, radius), w, h, radius);
}

/**
 * Snap the matte boundary to colour edges: for each boundary pixel, keep/kill
 * based on whether the local RGB still matches the interior mean within `tol`.
 * One-pixel ring only — cheap classical Refine Edge foothold.
 */
export function refineMatteEdge(
  rgba: Uint8ClampedArray | Uint8Array,
  mask: Uint8Array,
  w: number,
  h: number,
  tol = 28,
): Uint8Array {
  // Interior mean colour
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    sr += rgba[i * 4]!;
    sg += rgba[i * 4 + 1]!;
    sb += rgba[i * 4 + 2]!;
    n++;
  }
  if (n === 0) return mask;
  sr /= n; sg /= n; sb /= n;
  const thr = tol * 3;
  const out = new Uint8Array(mask);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mask[i]!;
      // Boundary = differs from a 4-neighbour
      const boundary =
        m !== mask[i - 1] || m !== mask[i + 1] || m !== mask[i - w] || m !== mask[i + w];
      if (!boundary) continue;
      const r = rgba[i * 4]!;
      const g = rgba[i * 4 + 1]!;
      const b = rgba[i * 4 + 2]!;
      const dist = Math.abs(r - sr) + Math.abs(g - sg) + Math.abs(b - sb);
      out[i] = dist <= thr ? 255 : 0;
    }
  }
  return out;
}

/**
 * Soft alpha matte from a binary mask via box blur — keeps 0..255 continuous
 * values (unlike a re-thresholded blur). Used for feather estimates.
 */
export function softFeatherMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += mask[yy * w + xx]!;
          n++;
        }
      }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.round(tmp[i]!);
  return out;
}

/**
 * Full classical refine: open → close → colour-edge snap → soft feather.
 * Returns a binary contour mask (thresholded soft) plus the recommended feather px.
 */
export function refineRotoMatte(
  rgba: Uint8ClampedArray | Uint8Array,
  mask: Uint8Array,
  w: number,
  h: number,
  opts?: { morphRadius?: number; featherPx?: number; edgeTol?: number },
): { mask: Uint8Array; feather: number } {
  const morphR = opts?.morphRadius ?? 1;
  const feather = opts?.featherPx ?? 2;
  const edgeTol = opts?.edgeTol ?? 28;
  let m = morphOpen(mask, w, h, morphR);
  m = morphClose(m, w, h, morphR);
  m = refineMatteEdge(rgba, m, w, h, edgeTol);
  const soft = softFeatherMask(m, w, h, feather);
  // Contour from the soft mid-level so the path sits in the feather ramp.
  const binary = new Uint8Array(soft.length);
  for (let i = 0; i < soft.length; i++) binary[i] = soft[i]! >= 128 ? 255 : 0;
  return { mask: binary, feather };
}
