/**
 * Colour-space conversions shared by the effect kernels.
 *
 * These lived privately in `aeColor.ts`, under a comment explaining that two
 * small functions beat a shared module "whose only caller is twenty lines above
 * it". That was right at the time and stopped being right here: Change Color,
 * Change To Color, Leave Color, Color Range, Spill Suppressor and Toner all
 * need the same pair, and six copies of a hue conversion is exactly how two of
 * them end up disagreeing about where red is.
 *
 * Everything is pure and works in 0–255 RGB / 0–1 HSL, matching what
 * `ImageData` hands over. Canvas `ImageData` is STRAIGHT alpha, not
 * premultiplied, so colour transforms apply to RGB directly — only spatial
 * kernels that average across pixels have to weight by alpha themselves.
 */

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Rec.709 luma. The same weights the rest of the effects tree uses — Find
 * Edges, Threshold and Luma Key all key off this, and a second set of weights
 * would make a luma-keyed matte disagree with the luminance the user sees in a
 * Threshold preview of the same footage.
 */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** RGB 0–255 → `[hue 0..1, saturation 0..1, lightness 0..1]`. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const mx = Math.max(rn, gn, bn);
  const mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  // Denominator flips at l = 0.5 because saturation is measured against the
  // distance to the nearer end of the range, not against the range itself.
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (mx === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

/** The inverse of {@link rgbToHsl}. Returns RGB 0–255. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = clamp255(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    clamp255(hueToChannel(p, q, h + 1 / 3) * 255),
    clamp255(hueToChannel(p, q, h) * 255),
    clamp255(hueToChannel(p, q, h - 1 / 3) * 255),
  ];
}

function hueToChannel(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/**
 * Shortest distance between two hues on the 0..1 wheel, in 0..0.5.
 *
 * The wrap is the whole point and the thing every hand-rolled version gets
 * wrong: red at 0.99 and red at 0.01 are 0.02 apart, not 0.98. A keying effect
 * built on the naive subtraction splits the red family in half and leaves a
 * ragged edge exactly where skin tones live.
 */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return d > 0.5 ? 1 - d : d;
}

/**
 * Smooth 0→1 ramp across `[edge0, edge1]`, clamped outside.
 *
 * Keying and colour-selection effects all need a soft shoulder rather than a
 * hard cut — a binary test produces the stair-stepped matte that reads as
 * "digital" and cannot be fixed downstream.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
