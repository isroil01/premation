/**
 * Keylight — a colour-difference chroma keyer (AE's Keying › Keylight, the most
 * requested keyer). Pulls a matte from a screen colour (green/blue screen),
 * with screen balance, gain, matte clip (black/white), softness and despill.
 *
 * It's a per-pixel pass that writes ALPHA (the matte) and can modify RGB (spill
 * suppression), so it runs in the Canvas2D pixel-pass chain like Sharpen/Noise.
 * Pure and fully unit-testable — no canvas needed for the maths.
 */

import { parseHex } from './canvas2dEffects';
import { clamp01 } from '@utils/lang';

export interface KeyParams {
  /** The screen colour to key out, `#rrggbb`. */
  screenColor: string;
  /** 0..1 — weights the two secondary channels (AE Screen Balance /100). */
  balance: number;
  /** 0..2 — scales the keyed difference before clipping (AE Screen Gain /100). */
  gain: number;
  /** 0..1 — matte values at/below this become fully transparent (Clip Black). */
  clipBlack: number;
  /** 0..1 — matte values at/above this become fully opaque (Clip White). */
  clipWhite: number;
  /** 0..1 — how strongly to remove screen-colour spill from the kept pixels. */
  despill: number;
}

/** Screen channel layout: which channel dominates the key colour, and the two
 *  secondary channels. Green screen → primary G, secondaries R and B. */
function channels(key: [number, number, number]): { p: number; a: number; b: number } {
  const [r, g, bl] = key;
  if (g >= r && g >= bl) return { p: 1, a: 0, b: 2 };
  if (bl >= r && bl >= g) return { p: 2, a: 0, b: 1 };
  return { p: 0, a: 1, b: 2 };
}

/**
 * The keyed matte value for one pixel, in [0,1] BEFORE clip/gain: how much the
 * pixel looks like the screen (1 = pure screen, 0 = no screen). `balance`
 * blends the two secondary channels — AE's Screen Balance.
 */
export function screenAmount(
  r: number,
  g: number,
  b: number,
  ch: { p: number; a: number; b: number },
  balance: number,
): number {
  const px = [r, g, b];
  const prim = px[ch.p]! / 255;
  const s1 = px[ch.a]! / 255;
  const s2 = px[ch.b]! / 255;
  // Screen Balance mixes the min and max of the two secondaries.
  const sec = balance * Math.max(s1, s2) + (1 - balance) * Math.min(s1, s2);
  // How much the primary exceeds the (balanced) secondaries → screen-ness.
  return prim - sec;
}

/** Smooth clip a value into [0,1] between black and white points. */
function clipMatte(v: number, black: number, white: number): number {
  if (white <= black) return v <= black ? 0 : 1;
  const t = (v - black) / (white - black);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Apply Keylight to RGBA pixel data in place.
 *
 * For each pixel: compute the screen amount, normalise it by the screen colour's
 * own amount so a pure-screen pixel keys to ~1, apply gain, then map through the
 * matte clip to an alpha the pixel is MULTIPLIED by (so existing transparency is
 * preserved). Finally, suppress spill by pulling the primary channel down toward
 * its secondaries on kept pixels.
 */
export function applyKeyData(data: Uint8ClampedArray, params: KeyParams): void {
  const key = parseHex(params.screenColor);
  const ch = channels(key);
  const balance = clamp01(params.balance);
  const gain = Math.max(0, params.gain);
  const despill = clamp01(params.despill);

  // The screen colour's own amount is the reference for "fully screen".
  const ref = screenAmount(key[0], key[1], key[2], ch, balance);
  const denom = Math.abs(ref) < 1e-4 ? 1 : ref;

  const clipBlack = clamp01(params.clipBlack);
  const clipWhite = clamp01(params.clipWhite);
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const a0 = data[i + 3]!;
    if (a0 === 0) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;

    const amt = (screenAmount(r, g, b, ch, balance) / denom) * gain;
    // amt≈1 on screen, ≈0 on foreground → the matte (foreground-ness / alpha) is
    // its complement, which AE's Clip Black/White then contrast-stretch.
    const rawAlpha = 1 - amt;
    const alpha = clipMatte(rawAlpha, clipBlack, clipWhite);
    data[i + 3] = Math.round(a0 * alpha);

    // Spill suppression: where the primary channel exceeds its secondaries,
    // pull it down toward them (removes green/blue fringing on kept edges).
    if (despill > 0 && alpha > 0) {
      const px = [r, g, b];
      const s1 = px[ch.a]!;
      const s2 = px[ch.b]!;
      const cap = Math.max(s1, s2);
      if (px[ch.p]! > cap) {
        px[ch.p] = px[ch.p]! + (cap - px[ch.p]!) * despill;
        data[i] = px[0]!;
        data[i + 1] = px[1]!;
        data[i + 2] = px[2]!;
      }
    }
  }
}


/**
 * Matte choke (AE Screen Shrink/Grow): a separable morphological filter on the
 * ALPHA channel only. Positive `px` shrinks the matte (erode — min filter),
 * negative grows it (dilate — max filter). Kills the 1-px screen-coloured halo
 * a clip alone can't remove. Pure; radius capped for per-frame cost.
 */
export function chokeAlpha(data: Uint8ClampedArray, w: number, h: number, px: number): void {
  const r = Math.min(10, Math.round(Math.abs(px)));
  if (r === 0) return;
  const erode = px > 0;
  const pick = erode ? Math.min : Math.max;

  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3]!;
  const tmp = new Uint8ClampedArray(w * h);

  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = alpha[row + x]!;
      for (let k = 1; k <= r; k++) {
        if (x - k >= 0) v = pick(v, alpha[row + x - k]!);
        if (x + k < w) v = pick(v, alpha[row + x + k]!);
      }
      tmp[row + x] = v;
    }
  }
  // Vertical pass.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x]!;
      for (let k = 1; k <= r; k++) {
        if (y - k >= 0) v = pick(v, tmp[(y - k) * w + x]!);
        if (y + k < h) v = pick(v, tmp[(y + k) * w + x]!);
      }
      data[(y * w + x) * 4 + 3] = v;
    }
  }
}

/**
 * Matte softness (AE Screen Softness): a separable box blur on the ALPHA
 * channel only — feathers the keyed edge without blurring colour. Pure.
 */
export function softenAlpha(data: Uint8ClampedArray, w: number, h: number, px: number): void {
  const r = Math.min(25, Math.round(px));
  if (r <= 0) return;

  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3]!;
  const tmp = new Float32Array(w * h);
  const win = 2 * r + 1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const cx = k < -x ? 0 : x + k >= w ? w - 1 : x + k;
        sum += alpha[row + cx]!;
      }
      tmp[row + x] = sum / win;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const cy = k < -y ? 0 : y + k >= h ? h - 1 : y + k;
        sum += tmp[cy * w + x]!;
      }
      data[(y * w + x) * 4 + 3] = Math.round(sum / win);
    }
  }
}
