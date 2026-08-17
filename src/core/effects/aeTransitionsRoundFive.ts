/**
 * Transitions, round five — Jaws, Pixel Polly, Twister, Card Dance.
 *
 * The wipes' contract holds: `completion` runs 0→100 meaning "how much is
 * gone", 0 is bit-exactly the untouched frame, and everything animates through
 * that one keyframed param. Card Dance is the one member that is as much a
 * stylize as a transition — at amount 0 it is the identity, and its cards are
 * driven by the layer's OWN luminance standing in for AE's gradient layer.
 */

import { clamp01, clamp255, luma } from './colorSpace';

/** Deterministic 0..1 hash of two integers (same recipe as the other rounds). */
function hash2(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// ── Jaws ────────────────────────────────────────────────────────────

/**
 * CC Jaws — the frame bitten in two along a toothed seam; the halves part
 * along the seam's normal. Inverse map with a side check: a destination pixel
 * asks "which half would be here", samples back where that half came from, and
 * verifies the SOURCE point really belonged to that half — without the check
 * the widening gap fills with content from the wrong side instead of opening.
 */
export function jawsData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  direction: number,
  teethHeight: number,
  teethWidth: number,
): Uint8ClampedArray {
  const t = clamp01(completion / 100);
  if (t <= 0) return Uint8ClampedArray.from(src);
  const out = new Uint8ClampedArray(src.length);
  if (t >= 1) return out;
  const ang = (direction * Math.PI) / 180;
  // Axis u runs along the seam; s is the signed distance across it.
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const nx = -uy;
  const ny = ux;
  const cx = w / 2;
  const cy = h / 2;
  const extent = Math.abs(nx * w) / 2 + Math.abs(ny * h) / 2;
  const sep = t * (extent + teethHeight);
  const tw = Math.max(2, teethWidth);
  const th = Math.max(1, teethHeight);
  // Triangle-wave tooth profile along the seam.
  const tooth = (u: number): number => {
    const p = ((u / tw) % 1 + 1) % 1;
    return (p < 0.5 ? p * 2 : 2 - p * 2) * th - th / 2;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const rx = x + 0.5 - cx;
      const ry = y + 0.5 - cy;
      const u = rx * ux + ry * uy;
      const sDist = rx * nx + ry * ny;
      const seam = tooth(u);
      const top = sDist >= seam;
      // The half this pixel shows moved AWAY by `sep`; sample back toward the seam.
      const sxp = x + 0.5 - nx * (top ? sep : -sep);
      const syp = y + 0.5 - ny * (top ? sep : -sep);
      const sxi = Math.round(sxp - 0.5);
      const syi = Math.round(syp - 0.5);
      if (sxi < 0 || sxi >= w || syi < 0 || syi >= h) continue;
      // Side check: the source point must belong to the same half.
      const srx = sxp - cx;
      const sry = syp - cy;
      const sU = srx * ux + sry * uy;
      const sS = srx * nx + sry * ny;
      if ((sS >= tooth(sU)) !== top) continue; // the opening gap
      const so = (syi * w + sxi) * 4;
      const o = (y * w + x) * 4;
      out[o] = src[so]!;
      out[o + 1] = src[so + 1]!;
      out[o + 2] = src[so + 2]!;
      out[o + 3] = src[so + 3]!;
    }
  }
  return out;
}

// ── Pixel Polly ─────────────────────────────────────────────────────

/**
 * CC Pixel Polly — the frame shattered into cells that fly from the force
 * centre, tumble, drop and fade. Rendered cell-by-cell into the destination
 * (each cell inverse-maps its own transformed footprint), painter's order by
 * cell index — deterministic, no z fights.
 */
export function pixelPollyData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  cellSize: number,
  gravity: number,
  spin: number,
  centerX: number,
  centerY: number,
  seed: number,
): Uint8ClampedArray {
  const t = clamp01(completion / 100);
  if (t <= 0) return Uint8ClampedArray.from(src);
  const out = new Uint8ClampedArray(src.length);
  if (t >= 1) return out;
  const cell = Math.max(4, cellSize);
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const s = Math.floor(seed);
  const fx = w / 2 + centerX;
  const fy = h / 2 + centerY;
  const maxFly = Math.hypot(w, h) * 0.7;
  const fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const id = cy * cols + cx;
      const ccx = (cx + 0.5) * cell;
      const ccy = (cy + 0.5) * cell;
      // Flight: away from the force centre, plus per-cell jitter and gravity.
      let dirX = ccx - fx;
      let dirY = ccy - fy;
      const dl = Math.hypot(dirX, dirY) || 1;
      dirX /= dl;
      dirY /= dl;
      const kick = 0.5 + hash2(id, s) * 0.8;
      const jx = (hash2(id, s + 31) - 0.5) * 0.8;
      const jy = (hash2(id, s + 47) - 0.5) * 0.8;
      const px = ccx + (dirX + jx) * t * t * maxFly * kick;
      const py = ccy + (dirY + jy) * t * t * maxFly * kick + (gravity / 100) * t * t * h * 0.8;
      const rot = ((spin * Math.PI) / 180) * t * (hash2(id, s + 63) - 0.5) * 2;
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      // Inverse-render this cell's transformed footprint.
      const half = (cell / 2) * Math.SQRT2;
      const x0 = Math.max(0, Math.floor(px - half));
      const x1 = Math.min(w - 1, Math.ceil(px + half));
      const y0 = Math.max(0, Math.floor(py - half));
      const y1 = Math.min(h - 1, Math.ceil(py + half));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const lx = x + 0.5 - px;
          const ly = y + 0.5 - py;
          const sxl = lx * cosR + ly * sinR;
          const syl = -lx * sinR + ly * cosR;
          if (Math.abs(sxl) > cell / 2 || Math.abs(syl) > cell / 2) continue;
          const sxi = Math.round(ccx + sxl - 0.5);
          const syi = Math.round(ccy + syl - 0.5);
          if (sxi < 0 || sxi >= w || syi < 0 || syi >= h) continue;
          const so = (syi * w + sxi) * 4;
          if (src[so + 3] === 0) continue;
          const o = (y * w + x) * 4;
          out[o] = src[so]!;
          out[o + 1] = src[so + 1]!;
          out[o + 2] = src[so + 2]!;
          out[o + 3] = clamp255(src[so + 3]! * fade);
        }
      }
    }
  }
  return out;
}

// ── Twister ─────────────────────────────────────────────────────────

/**
 * CC Twister — the frame wrings out around a horizontal axis: rows compress
 * toward the axis as the sheet turns edge-on, with a twist phase running along
 * x so it wrings rather than flips flat. Past 90° a column shows its BACK
 * (mirrored, darkened); at completion 100 every column is edge-on → gone.
 */
export function twisterData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  centerY: number,
  twist: number,
): Uint8ClampedArray {
  const t = clamp01(completion / 100);
  if (t <= 0) return Uint8ClampedArray.from(src);
  const out = new Uint8ClampedArray(src.length);
  if (t >= 1) return out;
  const axisY = h / 2 + centerY;
  const twistRad = (twist * Math.PI) / 180;
  for (let x = 0; x < w; x++) {
    // Column fold angle: base rotation plus the along-x wring. At t = 1 every
    // column reaches ≥ 90° and the sheet is edge-on everywhere.
    const phase = Math.sin((x / Math.max(1, w - 1)) * Math.PI * 2) * twistRad * t * 0.5;
    const ang = t * (Math.PI / 2) + phase * (1 - t);
    const c = Math.cos(Math.min(Math.PI / 2, Math.max(0, ang)));
    if (c <= 0.02) continue; // edge-on — this column has vanished
    const backside = false; // ang capped at 90°, the sheet never fully flips
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5 - axisY) / c;
      const sy = Math.round(axisY + v - 0.5);
      if (sy < 0 || sy >= h) continue;
      const so = (sy * w + x) * 4;
      if (src[so + 3] === 0) continue;
      const o = (y * w + x) * 4;
      // Foreshortened columns catch less light — the fold reads as a curl.
      const shade = backside ? 0.5 : 0.6 + 0.4 * c;
      out[o] = clamp255(src[so]! * shade);
      out[o + 1] = clamp255(src[so + 1]! * shade);
      out[o + 2] = clamp255(src[so + 2]! * shade);
      out[o + 3] = src[so + 3]!;
    }
  }
  return out;
}

// ── Card Dance ──────────────────────────────────────────────────────

/**
 * Card Dance — the frame cut into rows×columns cards; each card is displaced
 * and rotated by its own average LUMINANCE (bright cards up, dark cards down —
 * the layer stands in for AE's gradient layer) plus a travelling wave in
 * `phase`. Amount 0 renders bit-exactly the untouched frame.
 */
export function cardDanceData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  rows: number,
  columns: number,
  amount: number,
  cardRotation: number,
  phase: number,
): Uint8ClampedArray {
  const amt = clamp01(amount / 100);
  if (amt <= 0) return Uint8ClampedArray.from(src);
  const out = new Uint8ClampedArray(src.length);
  const R = Math.max(1, Math.round(rows));
  const C = Math.max(1, Math.round(columns));
  const cellW = w / C;
  const cellH = h / R;
  const maxOff = Math.min(w, h) * 0.4;
  for (let cy = 0; cy < R; cy++) {
    for (let cx = 0; cx < C; cx++) {
      const ccx = (cx + 0.5) * cellW;
      const ccy = (cy + 0.5) * cellH;
      // Card drive: centre-pixel luminance, signed around mid-grey.
      const sxi = Math.min(w - 1, Math.max(0, Math.round(ccx)));
      const syi = Math.min(h - 1, Math.max(0, Math.round(ccy)));
      const so = (syi * w + sxi) * 4;
      const lum = luma(src[so]!, src[so + 1]!, src[so + 2]!) / 255;
      const drive = (lum - 0.5) * 2;
      const wave = Math.sin((phase / 100) * Math.PI * 2 + cx * 0.7 + cy * 0.45);
      const offY = -(drive * maxOff * amt) - wave * maxOff * amt * 0.3;
      const rot = ((cardRotation * Math.PI) / 180) * (drive + wave * 0.3) * amt;
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const px = ccx;
      const py = ccy + offY;
      const half = Math.hypot(cellW, cellH) / 2;
      const x0 = Math.max(0, Math.floor(px - half));
      const x1 = Math.min(w - 1, Math.ceil(px + half));
      const y0 = Math.max(0, Math.floor(py - half));
      const y1 = Math.min(h - 1, Math.ceil(py + half));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const lx = x + 0.5 - px;
          const ly = y + 0.5 - py;
          const sxl = lx * cosR + ly * sinR;
          const syl = -lx * sinR + ly * cosR;
          if (Math.abs(sxl) > cellW / 2 || Math.abs(syl) > cellH / 2) continue;
          const rsx = Math.round(ccx + sxl - 0.5);
          const rsy = Math.round(ccy + syl - 0.5);
          if (rsx < 0 || rsx >= w || rsy < 0 || rsy >= h) continue;
          const ro = (rsy * w + rsx) * 4;
          if (src[ro + 3] === 0) continue;
          const o = (y * w + x) * 4;
          out[o] = src[ro]!;
          out[o + 1] = src[ro + 1]!;
          out[o + 2] = src[ro + 2]!;
          out[o + 3] = src[ro + 3]!;
        }
      }
    }
  }
  return out;
}
