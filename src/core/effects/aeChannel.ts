/**
 * Channel operations — Alpha Levels, Solid Composite, Channel Combiner,
 * Remove Color Matting.
 *
 * These treat the four channels as data rather than as a picture, which is why
 * they sit apart from the colour-correction family: Levels remaps a channel to
 * look better, Alpha Levels remaps one to composite correctly. Same maths,
 * different job, and conflating them would put a matte control in a grading
 * panel where nobody would look for it.
 *
 * As everywhere in this tree, `ImageData` is STRAIGHT alpha. Remove Color
 * Matting is the one effect here that cares deeply — it exists precisely to
 * undo a PREMULTIPLICATION that happened outside this pipeline.
 */

import { clamp01, clamp255, luma, rgbToHsl, hslToRgb } from './colorSpace';

// ── Alpha Levels ────────────────────────────────────────────────────

/**
 * Alpha Levels — a Levels remap applied to the ALPHA channel.
 *
 * The standard matte-tightening tool: pull `inBlack` up to crush noise in the
 * transparent region, pull `inWhite` down to make the near-opaque core fully
 * opaque, and use `gamma` to fatten or thin the soft edge between them without
 * moving either end.
 *
 * That middle control is the reason this is not just two thresholds. Clipping
 * both ends of a soft edge gives a hard matte; a gamma bends the ramp and keeps
 * the edge soft while still making it denser, which is what you actually want
 * on hair.
 */
export function alphaLevelsData(
  data: Uint8ClampedArray,
  inBlack: number,
  inWhite: number,
  gamma: number,
  outBlack: number,
  outWhite: number,
): Uint8ClampedArray {
  // Precomputed, because the map is identical for all pixels and alpha is a
  // single byte — 256 entries beats a pow() per pixel by a wide margin.
  const table = new Uint8Array(256);
  const span = Math.max(1e-6, inWhite - inBlack);
  const g = 1 / Math.max(1e-3, gamma);
  for (let i = 0; i < 256; i++) {
    const t = clamp01((i - inBlack) / span);
    table[i] = clamp255(outBlack + (outWhite - outBlack) * Math.pow(t, g));
  }
  for (let i = 3; i < data.length; i += 4) data[i] = table[data[i]!]!;
  return data;
}

// ── Solid Composite ─────────────────────────────────────────────────

/**
 * Solid Composite — composite the layer against a solid colour, in one effect.
 *
 * `mode` 0 = normal, 1 = multiply, 2 = screen, 3 = add.
 *
 * The value is doing this WITHOUT a second layer: filling behind a key,
 * flattening a title onto a plate, or forcing an opaque background so a
 * downstream blur has something to pull from. Every one of those otherwise
 * costs a solid layer and a parent, and the layer version cannot be keyframed
 * as part of the effect stack's order.
 *
 * The solid sits UNDER the layer, so `sourceOpacity` fades the layer toward the
 * colour rather than the other way round — matching AE, and the opposite of
 * what the parameter name suggests to most people on first use.
 */
export function solidCompositeData(
  data: Uint8ClampedArray,
  color: [number, number, number],
  sourceOpacity: number,
  solidOpacity: number,
  mode: number,
): Uint8ClampedArray {
  const so = clamp01(sourceOpacity / 100);
  const co = clamp01(solidOpacity / 100);
  const m = Math.round(mode);
  const [cr, cg, cb] = color;

  for (let i = 0; i < data.length; i += 4) {
    const sa = (data[i + 3]! / 255) * so;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;

    // Blend the source against the solid in the chosen mode first, then
    // composite that result over the solid by the source's own coverage. Doing
    // the blend BEFORE the coverage weighting is what makes a partially
    // transparent pixel blend proportionally rather than popping.
    let br: number, bg: number, bb: number;
    if (m === 1) { br = (r * cr) / 255; bg = (g * cg) / 255; bb = (b * cb) / 255; }
    else if (m === 2) { br = 255 - ((255 - r) * (255 - cr)) / 255; bg = 255 - ((255 - g) * (255 - cg)) / 255; bb = 255 - ((255 - b) * (255 - cb)) / 255; }
    else if (m === 3) { br = r + cr; bg = g + cg; bb = b + cb; }
    else { br = r; bg = g; bb = b; }

    data[i] = clamp255(cr * co + (br - cr * co) * sa);
    data[i + 1] = clamp255(cg * co + (bg - cg * co) * sa);
    data[i + 2] = clamp255(cb * co + (bb - cb * co) * sa);
    // The solid is opaque wherever its own opacity says so, so coverage is the
    // union of the two rather than the source's alone.
    data[i + 3] = clamp255(255 * (sa + co - sa * co));
  }
  return data;
}

// ── Channel Combiner ────────────────────────────────────────────────

/**
 * Channel Combiner — reinterpret the channels through a conversion.
 *
 * `mode`: 0 RGB→HSL · 1 HSL→RGB · 2 RGB→YUV · 3 YUV→RGB · 4 Lightness→Alpha ·
 * 5 Alpha→Luminance · 6 Max RGB · 7 Min RGB.
 *
 * The round-trip pairs (0/1 and 2/3) are the useful part: converting to HSL
 * puts hue in the red channel, where an ordinary Curves or Levels can then bend
 * it, and converting back applies the result. That is a whole class of grade
 * that is otherwise unreachable, and it only works because the pair is exact —
 * which is why both directions ship together rather than just the forward one.
 */
export function channelCombinerData(data: Uint8ClampedArray, mode: number): Uint8ClampedArray {
  const m = Math.round(mode);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
    switch (m) {
      case 0: {
        const [h, s, l] = rgbToHsl(r, g, b);
        data[i] = clamp255(h * 255); data[i + 1] = clamp255(s * 255); data[i + 2] = clamp255(l * 255);
        break;
      }
      case 1: {
        const [nr, ng, nb] = hslToRgb(r / 255, g / 255, b / 255);
        data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
        break;
      }
      case 2: {
        const y = luma(r, g, b);
        // U and V are signed; biased by 128 so they survive an unsigned byte.
        data[i] = clamp255(y);
        data[i + 1] = clamp255((b - y) * 0.565 + 128);
        data[i + 2] = clamp255((r - y) * 0.713 + 128);
        break;
      }
      case 3: {
        const y = r, u = g - 128, v = b - 128;
        data[i] = clamp255(y + 1.403 * v);
        data[i + 1] = clamp255(y - 0.344 * u - 0.714 * v);
        data[i + 2] = clamp255(y + 1.770 * u);
        break;
      }
      case 4:
        data[i + 3] = clamp255(luma(r, g, b));
        break;
      case 5:
        data[i] = a; data[i + 1] = a; data[i + 2] = a; data[i + 3] = 255;
        break;
      case 6: {
        const v = Math.max(r, g, b);
        data[i] = v; data[i + 1] = v; data[i + 2] = v;
        break;
      }
      case 7: {
        const v = Math.min(r, g, b);
        data[i] = v; data[i + 1] = v; data[i + 2] = v;
        break;
      }
      default:
        break;
    }
  }
  return data;
}

// ── Remove Color Matting ────────────────────────────────────────────

/**
 * Remove Color Matting — unpremultiply against a background colour.
 *
 * Footage rendered premultiplied over black and then treated as straight alpha
 * shows a DARK FRINGE on every soft edge; over white, a light halo. The fix is
 * exact rather than cosmetic: recover `straight = (premul − bg·(1−α)) / α`.
 *
 * Two details that a naive implementation gets wrong and that are the whole
 * reason this is worth shipping over "just blur the edge":
 *
 *   · **α = 0 must be skipped**, not divided. The division is undefined there
 *     and produces NaN, which `Uint8ClampedArray` silently stores as 0 — a
 *     transparent pixel turning black, invisible until it is composited over
 *     something light.
 *   · **Low alpha amplifies error.** At α = 0.02 the division multiplies by 50,
 *     so any noise in the source explodes. `threshold` leaves pixels below a
 *     coverage floor alone, which is what keeps the recovered edge clean.
 */
export function removeColorMattingData(
  data: Uint8ClampedArray,
  bg: [number, number, number],
  threshold: number,
  amount: number,
): Uint8ClampedArray {
  const floor = clamp01(threshold / 100);
  const strength = clamp01(amount / 100);
  if (strength <= 0) return data;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a <= floor || a >= 1) continue;
    const inv = 1 - a;
    for (let c = 0; c < 3; c++) {
      const premul = data[i + c]!;
      const straight = (premul - bg[c]! * inv) / a;
      data[i + c] = clamp255(premul + (straight - premul) * strength);
    }
  }
  return data;
}
