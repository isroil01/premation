/**
 * Distort, round five — Flo Motion, Lens, Griddler, Ball Action, Drizzle.
 *
 * Every warp here is an INVERSE map fed to `remap` — for each destination
 * pixel, where in the source does it come from — like every other member of
 * the family. The round-four lesson stands: a forward map written by mistake
 * still produces a plausible picture, bent the wrong way, so the tests assert
 * WHERE content lands, never merely that it moved
 * (see gotcha_motion_inverse_map_direction).
 */

import { clamp01, clamp255 } from './colorSpace';
import { remap } from './distort';

/** Deterministic 0..1 hash of two integers (same recipe as the other rounds). */
function hash2(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fract(v: number): number {
  return v - Math.floor(v);
}

// ── Flo Motion ──────────────────────────────────────────────────────

/**
 * CC Flo Motion — two knots that shove the picture outward (positive amount)
 * or suck it in (negative). Gaussian falloff around each knot; the two
 * displacements simply add, which is also what CC does — knots close together
 * reinforce.
 *
 * Inverse map: a POSITIVE knot magnifies its neighbourhood, so a destination
 * pixel reads from CLOSER TO the knot than itself.
 */
export function floMotionData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  knot1X: number,
  knot1Y: number,
  knot1Amount: number,
  knot2X: number,
  knot2Y: number,
  knot2Amount: number,
  falloff: number,
): Uint8ClampedArray {
  const knots = [
    { x: w / 2 + knot1X, y: h / 2 + knot1Y, a: knot1Amount / 100 },
    { x: w / 2 + knot2X, y: h / 2 + knot2Y, a: knot2Amount / 100 },
  ];
  const sigma = Math.max(4, (falloff / 100) * Math.min(w, h));
  const twoSigma2 = 2 * sigma * sigma;
  const reach = sigma * 1.2;
  return remap(src, w, h, (dx, dy) => {
    let ox = 0;
    let oy = 0;
    for (const k of knots) {
      if (k.a === 0) continue;
      const vx = dx - k.x;
      const vy = dy - k.y;
      const d2 = vx * vx + vy * vy;
      const g = Math.exp(-d2 / twoSigma2);
      // Positive amount = magnify = sample toward the knot (inverse map).
      ox -= vx * k.a * g * (reach / sigma);
      oy -= vy * k.a * g * (reach / sigma);
    }
    return { x: dx + ox, y: dy + oy };
  });
}

// ── Lens ────────────────────────────────────────────────────────────

/**
 * CC Lens — the layer folded into a fisheye ball. Outside the ball is
 * TRANSPARENT (that is what distinguishes it from Spherize, which bulges
 * inside the frame). Convergence 0 keeps the centre linear and only bends the
 * rim; at 100 the WHOLE layer, corners included, is pulled inside the ball.
 */
export function lensData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  size: number,
  convergence: number,
): Uint8ClampedArray {
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const ballR = Math.max(4, (size / 100) * (Math.min(w, h) / 2));
  const conv = clamp01(convergence / 100);
  const halfDiag = Math.hypot(w, h) / 2;
  // How much source the rim reaches: from just the ball's own footprint
  // (conv 0) out to the whole layer (conv 1).
  const pull = ballR + (halfDiag - ballR) * conv;
  return remap(src, w, h, (dx, dy) => {
    const vx = dx - cx;
    const vy = dy - cy;
    const r = Math.hypot(vx, vy);
    if (r > ballR) return null; // outside the ball — transparent
    const rn = r / ballR;
    // Fisheye radial profile: linear at the centre, saturating at the rim.
    const srcR = pull * (Math.asin(Math.min(1, rn)) / (Math.PI / 2));
    if (r < 1e-6) return { x: w / 2, y: h / 2 };
    const s = srcR / r;
    return { x: w / 2 + vx * s, y: h / 2 + vy * s };
  });
}

// ── Griddler ────────────────────────────────────────────────────────

/**
 * CC Griddler — the layer cut into square tiles, every tile scaled and rotated
 * about its own centre. Sub-100% scales open transparent gaps at the seams;
 * the inverse map un-rotates/un-scales the destination back into the tile and
 * rejects anything that falls outside it.
 */
export function griddlerData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  tileSize: number,
  horizontalScale: number,
  verticalScale: number,
  rotation: number,
): Uint8ClampedArray {
  const tile = Math.max(4, tileSize);
  const sx = Math.max(0.01, horizontalScale / 100);
  const sy = Math.max(0.01, verticalScale / 100);
  const rot = (rotation * Math.PI) / 180;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  return remap(src, w, h, (dx, dy) => {
    const cellX = Math.floor(dx / tile);
    const cellY = Math.floor(dy / tile);
    const ccx = (cellX + 0.5) * tile;
    const ccy = (cellY + 0.5) * tile;
    const lx = dx - ccx;
    const ly = dy - ccy;
    // Inverse transform: un-rotate, then un-scale.
    const ux = (lx * cosR + ly * sinR) / sx;
    const uy = (-lx * sinR + ly * cosR) / sy;
    if (Math.abs(ux) > tile / 2 || Math.abs(uy) > tile / 2) return null; // gap
    return { x: ccx + ux, y: ccy + uy };
  });
}

// ── Ball Action ─────────────────────────────────────────────────────

/**
 * CC Ball Action — the layer sampled into a grid of shaded balls. Each ball
 * shows its own cell's picture, spherized; scatter jitters ball centres
 * deterministically by (seed, cell). The Lambert-ish top-left shading is what
 * sells the balls as 3D rather than as a mosaic of discs.
 */
export function ballActionData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  grid: number,
  ballSize: number,
  scatter: number,
  seed: number,
): Uint8ClampedArray {
  const g = Math.max(4, grid);
  const R = (g / 2) * clamp01(ballSize / 100);
  const jit = (scatter / 100) * g * 0.5;
  const s = Math.floor(seed);
  const cols = Math.ceil(w / g);
  const rows = Math.ceil(h / g);
  const out = new Uint8ClampedArray(src.length);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bx = (cx + 0.5) * g + (hash2(cx * 7919 + cy, s) - 0.5) * 2 * jit;
      const by = (cy + 0.5) * g + (hash2(cx * 7919 + cy, s + 77) - 0.5) * 2 * jit;
      const x0 = Math.max(0, Math.floor(bx - R));
      const x1 = Math.min(w - 1, Math.ceil(bx + R));
      const y0 = Math.max(0, Math.floor(by - R));
      const y1 = Math.min(h - 1, Math.ceil(by + R));
      const ccx = (cx + 0.5) * g; // sample from the UNJITTERED cell
      const ccy = (cy + 0.5) * g;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - bx;
          const dy = y + 0.5 - by;
          const d = Math.hypot(dx, dy);
          if (d > R) continue;
          // Spherize the cell picture onto the ball.
          const dn = d / R;
          const lift = dn > 1e-6 ? (Math.asin(Math.min(1, dn)) / (Math.PI / 2)) / dn : 1;
          const sxp = Math.min(w - 1, Math.max(0, Math.round(ccx + dx * lift * (g / (2 * R)))));
          const syp = Math.min(h - 1, Math.max(0, Math.round(ccy + dy * lift * (g / (2 * R)))));
          const so = (syp * w + sxp) * 4;
          if (src[so + 3] === 0) continue;
          // Lambert from the top-left plus a rim shadow.
          const nz = Math.sqrt(Math.max(0, 1 - dn * dn));
          const light = clamp01(0.35 + 0.65 * ((-dx / R) * 0.5 + (-dy / R) * 0.5 + nz * 0.7));
          const o = (y * w + x) * 4;
          out[o] = clamp255(src[so]! * light);
          out[o + 1] = clamp255(src[so + 1]! * light);
          out[o + 2] = clamp255(src[so + 2]! * light);
          out[o + 3] = src[so + 3]!;
        }
      }
    }
  }
  return out;
}

// ── Drizzle ─────────────────────────────────────────────────────────

/**
 * CC Drizzle — raindrops rippling the picture. Each drop's ring expands and
 * fades as a closed-form function of the KEYFRAMED `evolution`, so scrubbing
 * replays the same rain. The warp is a radial sine displacement in a band
 * around each ring — an inverse map, like every distortion here.
 */
export function drizzleData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  dripRate: number,
  rippleHeight: number,
  spreading: number,
  evolution: number,
  seed: number,
): Uint8ClampedArray {
  const n = Math.round(clamp01(dripRate / 100) * 30);
  if (n === 0 || rippleHeight <= 0) return Uint8ClampedArray.from(src);
  const s = Math.floor(seed);
  const spread = Math.max(8, spreading);
  const drops: Array<{ x: number; y: number; ringR: number; amp: number }> = [];
  for (let i = 0; i < n; i++) {
    // Each drop cycles: born, ring expands to `spread`, fades, reborn.
    const cycle = fract(evolution / 200 + hash2(i, s + 303));
    drops.push({
      x: hash2(i, s) * w,
      y: hash2(i, s + 11) * h,
      ringR: cycle * spread,
      amp: rippleHeight * (1 - cycle), // young rings are tall, old ones flat
    });
  }
  // Narrow band, several oscillations inside it: a raindrop ring is a crisp
  // wave TRAIN, not one soft bump — the wide single-lobe version read as a
  // blobby smear rather than as rings (seen, not guessed: contact-sheet
  // render, 2026-08-14).
  const bandW = Math.max(3, spread * 0.08);
  const freq = Math.PI / (bandW * 0.6);
  return remap(src, w, h, (dx, dy) => {
    let ox = 0;
    let oy = 0;
    for (const d of drops) {
      const vx = dx - d.x;
      const vy = dy - d.y;
      const r = Math.hypot(vx, vy);
      const off = r - d.ringR;
      if (Math.abs(off) > bandW * 2.5 || r < 1e-3) continue;
      const env = Math.exp(-(off * off) / (2 * bandW * bandW));
      const wave = Math.sin(off * freq) * d.amp * env;
      ox += (vx / r) * wave;
      oy += (vy / r) * wave;
    }
    if (ox === 0 && oy === 0) return { x: dx, y: dy };
    return { x: dx + ox, y: dy + oy };
  });
}
