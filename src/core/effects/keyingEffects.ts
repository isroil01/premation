/**
 * Keying kernels — Simple Choker, Linear Color Key, Shift Channels.
 *
 * Set Matte is deliberately NOT here. It reads another LAYER's pixels, which
 * this module's `(data, w, h, …)` shape cannot express at all — the bake chain
 * hands each effect its own layer's buffer and nothing else. It lives on the GPU
 * path instead, following the `displacement-map` precedent (a second texture
 * bound alongside the layer's own). That is the structural difference between it
 * and everything else in this family, and it is why it is the only one here that
 * needed a shader.
 *
 * All three operate on straight (non-premultiplied) `getImageData` bytes.
 */

import { luma } from './colorEffects';

/**
 * Simple Choker — contract or spread a matte's edge.
 *
 * Implemented as an alpha-only erode/dilate, which is what "choke" means: the
 * coverage boundary moves, the colour does not. A blur would soften the edge
 * instead of moving it, and softening is what the user was trying to undo.
 *
 * Separable min/max over a square window. AE's choker is radial, and the visible
 * difference at the 1–3px this is used at is nil, while the cost difference is
 * O(r) against O(r²) per pixel.
 */
export function simpleChokerData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  chokePx: number,
): Uint8ClampedArray {
  const r = Math.round(Math.abs(chokePx));
  if (r === 0 || w <= 0 || h <= 0) return data;
  // Positive chokes IN, which means taking the MINIMUM alpha over the window.
  const erode = chokePx > 0;

  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) alpha[p] = data[i + 3]!;

  const tmp = new Uint8ClampedArray(w * h);
  const pass = (src: Uint8ClampedArray, dst: Uint8ClampedArray, horizontal: boolean): void => {
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    for (let line = 0; line < lines; line++) {
      for (let p = 0; p < len; p++) {
        let best = erode ? 255 : 0;
        for (let k = -r; k <= r; k++) {
          const q = p + k;
          if (q < 0 || q >= len) {
            // Outside the layer is transparent. Eroding must SEE that, or the
            // border never chokes and a full-frame matte is untouched at its
            // edge — the same class of mistake as blur's repeat-edge divisor.
            if (erode) best = 0;
            continue;
          }
          const idx = horizontal ? line * w + q : q * w + line;
          const v = src[idx]!;
          best = erode ? Math.min(best, v) : Math.max(best, v);
        }
        dst[horizontal ? line * w + p : p * w + line] = best;
      }
    }
  };

  pass(alpha, tmp, true);
  pass(tmp, alpha, false);

  for (let i = 3, p = 0; i < data.length; i += 4, p++) data[i] = alpha[p]!;
  return data;
}

/** How Linear Color Key compares a pixel to the key colour. */
export type ColorMatchMode = 'rgb' | 'hue' | 'chroma';

export function colorMatchMode(v: number): ColorMatchMode {
  return v === 1 ? 'hue' : v === 2 ? 'chroma' : 'rgb';
}

/** Hue in 0..1, or 0 for a achromatic pixel. */
function hueOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d === 0) return 0;
  let hue: number;
  if (mx === r) hue = ((g - b) / d) % 6;
  else if (mx === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue /= 6;
  return hue < 0 ? hue + 1 : hue;
}

/**
 * Linear Color Key — key out (or keep) pixels near a colour.
 *
 * "Linear" is the point: between the tolerance edge and the softness edge the
 * alpha ramps LINEARLY rather than cutting. A hard threshold is what produces
 * the jagged, aliased matte that makes people give up on keying; the ramp is the
 * entire difference between this and a colour-distance cut.
 *
 * `keepMatched` inverts the sense — AE's Key Colors / Keep Colors — which turns
 * the effect into a selective colour isolator.
 */
export function linearColorKeyData(
  data: Uint8ClampedArray,
  key: readonly [number, number, number],
  mode: ColorMatchMode,
  tolerance: number,
  softness: number,
  keepMatched: boolean,
): Uint8ClampedArray {
  const tol = Math.max(0, Math.min(1, tolerance / 100));
  const soft = Math.max(0, Math.min(1, softness / 100));
  const keyHue = hueOf(key[0], key[1], key[2]);
  const keyLum = luma(key[0], key[1], key[2]);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;

    let distance: number;
    if (mode === 'hue') {
      const dh = Math.abs(hueOf(r, g, b) - keyHue);
      // Hue is circular: 0.9 and 0.05 are close, not far.
      distance = Math.min(dh, 1 - dh) * 2;
    } else if (mode === 'chroma') {
      // Colour difference with BRIGHTNESS normalised away, so a shadow falling
      // across the key colour still keys — the entire reason to offer the mode.
      //
      // Done by rescaling the pixel to the key's luminance and then comparing,
      // NOT by subtracting the luma difference from each channel. That
      // subtraction looks equivalent and is not: luma weights green at 0.587, so
      // darkening a pure green shifts its green channel by far more than it
      // shifts the luma, and the residual never cancels. A half-lit green keyed
      // no better than under a plain RGB match, which made the mode pointless.
      const pixLum = luma(r, g, b);
      if (pixLum <= 0.5) {
        // Black has no chroma to compare — treat it as matching only if the key
        // is also black, rather than dividing by ~0 and landing anywhere.
        distance = keyLum <= 0.5 ? 0 : 1;
      } else {
        const k = keyLum / pixLum;
        distance = Math.min(1, Math.hypot(r * k - key[0], g * k - key[1], b * k - key[2]) / 441.673);
      }
    } else {
      distance = Math.min(1, Math.hypot(r - key[0], g - key[1], b - key[2]) / 441.673);
    }

    // Inside tolerance → fully matched. Beyond tolerance+softness → not at all.
    // Between → linear.
    let matched: number;
    if (distance <= tol) matched = 1;
    else if (soft <= 0 || distance >= tol + soft) matched = 0;
    else matched = 1 - (distance - tol) / soft;

    const keepFraction = keepMatched ? matched : 1 - matched;
    data[i + 3] = data[i + 3]! * keepFraction;
  }
  return data;
}

/** Sources an output channel can be taken from, by stored index. */
export type ChannelSource = 'alpha' | 'red' | 'green' | 'blue' | 'luminance' | 'full-on' | 'full-off';

const CHANNEL_SOURCES: readonly ChannelSource[] = [
  'alpha', 'red', 'green', 'blue', 'luminance', 'full-on', 'full-off',
];

export function channelSource(v: number): ChannelSource {
  return CHANNEL_SOURCES[Math.round(v)] ?? 'alpha';
}

/**
 * Shift Channels — rewire which source channel feeds each output channel.
 *
 * The workhorse behind half of AE's matte plumbing: "take alpha from luminance"
 * turns a greyscale render into a matte in one step, and it is the reason this
 * unglamorous effect is worth having.
 *
 * Every read comes from a SNAPSHOT of the original pixel, not from the buffer as
 * it is being written. Swapping red and green in place without one leaves both
 * channels holding green — the classic in-place-permutation bug.
 */
export function shiftChannelsData(
  data: Uint8ClampedArray,
  takeAlphaFrom: ChannelSource,
  takeRedFrom: ChannelSource,
  takeGreenFrom: ChannelSource,
  takeBlueFrom: ChannelSource,
): Uint8ClampedArray {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
    const l = luma(r, g, b);
    const pick = (s: ChannelSource): number => {
      switch (s) {
        case 'alpha': return a;
        case 'red': return r;
        case 'green': return g;
        case 'blue': return b;
        case 'luminance': return l;
        case 'full-on': return 255;
        case 'full-off': return 0;
      }
    };
    data[i] = pick(takeRedFrom);
    data[i + 1] = pick(takeGreenFrom);
    data[i + 2] = pick(takeBlueFrom);
    data[i + 3] = pick(takeAlphaFrom);
  }
  return data;
}
