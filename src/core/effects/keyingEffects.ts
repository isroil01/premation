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

/** Which side of the threshold Luma Key removes. */
export type LumaKeyType = 'brighter' | 'darker' | 'similar' | 'dissimilar';

const LUMA_KEY_TYPES: readonly LumaKeyType[] = ['brighter', 'darker', 'similar', 'dissimilar'];

export function lumaKeyType(v: number): LumaKeyType {
  return LUMA_KEY_TYPES[Math.round(v)] ?? 'brighter';
}

/**
 * Luma Key — key on BRIGHTNESS rather than on a colour.
 *
 * The tool for material that was never shot against a screen: white product
 * packshots, black-background smoke and fire plates, scanned line art, stock
 * explosions. Linear Color Key above cannot do this job well — a smoke plate is
 * every shade of grey at once, so there is no single key colour to name, but
 * there is a very clear luminance threshold.
 *
 * The four key types are two pairs. `brighter`/`darker` are one-sided cuts
 * either side of the threshold, which is what a black or white background needs;
 * `similar`/`dissimilar` are two-sided, keying a BAND of luminance around the
 * threshold, which is how a mid-grey card comes out.
 *
 * `tolerance` widens the fully-keyed region and `softness` is the ramp beyond
 * it, giving the same linear falloff Linear Color Key uses — and for the same
 * reason. A hard luminance cut on a smoke plate produces a contour-map edge that
 * no amount of choking recovers.
 *
 * Alpha is MULTIPLIED, never assigned, so keying a layer that already carries a
 * matte narrows it instead of resurrecting pixels the matte had removed.
 */
export function lumaKeyData(
  data: Uint8ClampedArray,
  type: LumaKeyType,
  threshold: number,
  tolerance: number,
  softness: number,
): Uint8ClampedArray {
  // Everything on the 0..1 luminance scale, so the three controls are directly
  // comparable to each other.
  const cut = Math.max(0, Math.min(1, threshold / 255));
  const tol = Math.max(0, tolerance / 255);
  const soft = Math.max(0, softness / 255);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const l = luma(data[i]!, data[i + 1]!, data[i + 2]!) / 255;

    // Signed distance INTO the region being removed. Positive means keyed.
    let into: number;
    switch (type) {
      case 'brighter': into = l - cut; break;
      case 'darker': into = cut - l; break;
      // Two-sided: inside the band is keyed, and `tol` sets the band's radius.
      case 'similar': into = tol - Math.abs(l - cut); break;
      case 'dissimilar': into = Math.abs(l - cut) - tol; break;
    }

    // The one-sided types spend their tolerance widening the cut instead.
    if (type === 'brighter' || type === 'darker') into += tol;

    let alpha: number;
    if (into <= 0) {
      alpha = 1;
    } else if (soft <= 0) {
      alpha = 0;
    } else {
      alpha = Math.max(0, Math.min(1, 1 - into / soft));
    }
    data[i + 3] = data[i + 3]! * alpha;
  }
  return data;
}

/** Minimax operations, in AE's menu order. */
export type MinimaxOp = 'maximum' | 'minimum' | 'max-then-min' | 'min-then-max';

const MINIMAX_OPS: readonly MinimaxOp[] = ['maximum', 'minimum', 'max-then-min', 'min-then-max'];

export function minimaxOp(v: number): MinimaxOp {
  return MINIMAX_OPS[Math.round(v)] ?? 'maximum';
}

/** Which channels Minimax operates on. */
export type MinimaxChannel = 'alpha' | 'color' | 'red' | 'green' | 'blue';

const MINIMAX_CHANNELS: readonly MinimaxChannel[] = ['alpha', 'color', 'red', 'green', 'blue'];

export function minimaxChannel(v: number): MinimaxChannel {
  return MINIMAX_CHANNELS[Math.round(v)] ?? 'alpha';
}

/**
 * Minimax — spread each pixel to the maximum (or minimum) of its neighbourhood.
 *
 * Dilate and erode, the two operations that every matte repair is built from.
 * On alpha, Maximum GROWS the matte and Minimum SHRINKS it, which is how a key's
 * fringe is pulled in or a matte spread to cover a seam. The compound
 * operations are the reason the effect carries four rather than two:
 *
 *   max-then-min   (a morphological CLOSE) fills holes and gaps smaller than the
 *                  radius while leaving the outer boundary where it was
 *   min-then-max   (an OPEN) removes specks and hairs smaller than the radius,
 *                  again without moving the boundary
 *
 * Neither compound is reachable by running the effect twice and tuning it — the
 * point is that the second pass exactly undoes the first pass's boundary shift,
 * which only holds when both use the same radius.
 *
 * ── Separability is why this is affordable ──────────────────────────────────
 *
 * A max over a square window is separable: the max over a w×h box equals a max
 * over each row followed by a max over each column. That turns the cost from
 * O(r²) per pixel into O(r), which at the radii matte work actually uses (10–40
 * px) is the difference between interactive and not. It holds for a SQUARE
 * structuring element and not for a circular one, which is why the window here
 * is square — AE's is too.
 */
export function minimaxData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  op: MinimaxOp,
  radius: number,
  channel: MinimaxChannel,
  direction: 'both' | 'horizontal' | 'vertical',
): Uint8ClampedArray {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return src;

  // Which byte offsets within a pixel this touches. Everything else is copied
  // through untouched — an alpha-only Minimax must not disturb the colour, or
  // a spread matte would drag smeared colour along its new edge.
  const offsets =
    channel === 'alpha' ? [3]
      : channel === 'color' ? [0, 1, 2]
        : channel === 'red' ? [0]
          : channel === 'green' ? [1]
            : [2];

  // Ping-pong buffers: each pass reads one and writes the other. Doing it in
  // place would let a pass read values the SAME pass already wrote, which turns
  // a radius-r dilation into an unbounded flood along the scan direction.
  let cur = new Uint8ClampedArray(src);
  let scratch = new Uint8ClampedArray(src.length);

  const pass = (takeMax: boolean, horizontal: boolean): void => {
    scratch.set(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        for (const c of offsets) {
          let best = takeMax ? 0 : 255;
          for (let k = -r; k <= r; k++) {
            const sx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
            const sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
            const v = cur[(sy * w + sx) * 4 + c]!;
            if (takeMax ? v > best : v < best) best = v;
          }
          scratch[o + c] = best;
        }
      }
    }
    const t = cur;
    cur = scratch;
    scratch = t;
  };

  const separable = (takeMax: boolean): void => {
    if (direction !== 'vertical') pass(takeMax, true);
    if (direction !== 'horizontal') pass(takeMax, false);
  };

  switch (op) {
    case 'maximum': separable(true); break;
    case 'minimum': separable(false); break;
    case 'max-then-min': separable(true); separable(false); break;
    case 'min-then-max': separable(false); separable(true); break;
  }

  src.set(cur);
  return src;
}
