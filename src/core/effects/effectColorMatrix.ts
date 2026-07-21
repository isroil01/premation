/**
 * Composes the color-grade subset of an effect stack into a single 3×3 color
 * matrix + offset (`out = M·rgb + offset`), matching CSS `filter` semantics.
 * The GPU path can't use CSS filters, so it applies this matrix instead — to a
 * solid color on the CPU, or per-pixel in a textured shader.
 *
 * Only per-pixel color effects compose here; spatial effects (blur, glow,
 * drop-shadow) need neighbouring pixels and are handled by separate passes.
 */

import type { Effect, EffectType } from './effects';
import { effectNumber, effectParam, primaryParamKey } from './effects';

/** `#rrggbb` → [r,g,b] in 0..1 (unknown/invalid → black). */
function hex01(v: unknown): [number, number, number] {
  const m = typeof v === 'string' ? /^#?([0-9a-f]{6})$/i.exec(v.trim()) : null;
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface ColorMatrix {
  /** Row-major 3×3 applied to linear-ish rgb. */
  m: [number, number, number, number, number, number, number, number, number];
  /** Added after the matrix. */
  offset: [number, number, number];
}

export const IDENTITY_COLOR_MATRIX: ColorMatrix = {
  m: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  offset: [0, 0, 0],
};

/** Effect types that are expressible as an affine color transform. */
const COLOR_EFFECTS: ReadonlySet<EffectType> = new Set<EffectType>([
  'brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'hue-rotate', 'invert', 'hue-saturation',
  'tint', 'channel-mixer',
]);

export function isColorEffect(type: EffectType): boolean {
  return COLOR_EFFECTS.has(type);
}

type M3 = ColorMatrix['m'];

const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul(a: M3, b: M3): M3 {
  const r = new Array(9) as unknown as M3;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      r[row * 3 + col] =
        a[row * 3]! * b[col]! + a[row * 3 + 1]! * b[3 + col]! + a[row * 3 + 2]! * b[6 + col]!;
    }
  }
  return r;
}

function apply3(a: M3, v: readonly [number, number, number]): [number, number, number] {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}

// Luma coefficients (Rec.709), shared by saturate / grayscale / hue-rotate.
const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

/** SVG/CSS `saturate(s)` matrix (s=1 → identity, s=0 → luminance). */
function saturateMatrix(s: number): M3 {
  return [
    LR + (1 - LR) * s, LG - LG * s, LB - LB * s,
    LR - LR * s, LG + (1 - LG) * s, LB - LB * s,
    LR - LR * s, LG - LG * s, LB + (1 - LB) * s,
  ];
}

/** CSS `sepia(p)` — lerp identity → sepia matrix. */
function sepiaMatrix(p: number): M3 {
  const S: M3 = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
  return I3.map((v, i) => v * (1 - p) + S[i]! * p) as M3;
}

/** CSS `hue-rotate(deg)` rotation matrix. */
function hueRotateMatrix(deg: number): M3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    LR + c * (1 - LR) + s * -LR, LG + c * -LG + s * -LG, LB + c * -LB + s * (1 - LB),
    LR + c * -LR + s * 0.143, LG + c * (1 - LG) + s * 0.14, LB + c * -LB + s * -0.283,
    LR + c * -LR + s * -(1 - LR), LG + c * -LG + s * LG, LB + c * (1 - LB) + s * LB,
  ];
}

/** Scalar multiply (brightness/lightness) as a matrix. */
function scaleMatrix(b: number): M3 {
  return [b, 0, 0, 0, b, 0, 0, 0, b];
}

/**
 * Build the {matrix, offset} for one colour effect.
 *
 * Takes the whole effect (not a lone scalar) so multi-param colour effects —
 * Hue/Saturation's hue + saturation + lightness — compose here on the GPU path
 * the same way they do as a CSS filter string on Canvas2D.
 */
function effectToMatrix(effect: Effect): ColorMatrix {
  const type = effect.type;
  const amt = effectNumber(effect, primaryParamKey(type) ?? 'amount');
  switch (type) {
    case 'brightness':
      return { m: scaleMatrix(amt / 100), offset: [0, 0, 0] };
    case 'contrast': {
      const c = amt / 100;
      const o = 0.5 * (1 - c);
      return { m: [c, 0, 0, 0, c, 0, 0, 0, c], offset: [o, o, o] };
    }
    case 'saturate':
      return { m: saturateMatrix(amt / 100), offset: [0, 0, 0] };
    case 'grayscale':
      return { m: saturateMatrix(1 - amt / 100), offset: [0, 0, 0] };
    case 'sepia':
      return { m: sepiaMatrix(amt / 100), offset: [0, 0, 0] };
    case 'hue-rotate':
      return { m: hueRotateMatrix(amt), offset: [0, 0, 0] };
    case 'hue-saturation': {
      // Hue rotate, then saturation, then lightness — matching the CSS order.
      const hue = hueRotateMatrix(effectNumber(effect, 'hue'));
      const sat = saturateMatrix((100 + effectNumber(effect, 'saturation')) / 100);
      const light = scaleMatrix((100 + effectNumber(effect, 'lightness')) / 100);
      return { m: mul(light, mul(sat, hue)), offset: [0, 0, 0] };
    }
    case 'invert': {
      const i = amt / 100;
      const k = 1 - 2 * i;
      return { m: [k, 0, 0, 0, k, 0, 0, 0, k], offset: [i, i, i] };
    }
    case 'tint': {
      // Map black→mapBlack and white→mapWhite along luminance, then blend by amount.
      const b = hex01(effectParam(effect, 'mapBlack') ?? '#000000');
      const w = hex01(effectParam(effect, 'mapWhite') ?? '#ffffff');
      const a = amt / 100; // primaryParamKey('tint') === 'amount'
      const row = (i: number): [number, number, number] => {
        const d = w[i]! - b[i]!;
        return [d * LR, d * LG, d * LB];
      };
      const tint: M3 = [...row(0), ...row(1), ...row(2)] as M3;
      // final = (1−a)·I + a·tint ; offset = a·mapBlack
      const m = I3.map((v, i) => v * (1 - a) + tint[i]! * a) as M3;
      return { m, offset: [b[0] * a, b[1] * a, b[2] * a] };
    }
    case 'channel-mixer': {
      // Per-output-channel weighted mix (percentages; 100 = full contribution).
      const p = (k: string): number => effectNumber(effect, k) / 100;
      const rr = p('redRed'), rg = p('redGreen'), rb = p('redBlue');
      const gr = p('greenRed'), gg = p('greenGreen'), gb = p('greenBlue');
      const br = p('blueRed'), bg = p('blueGreen'), bb = p('blueBlue');
      const mono = effectParam(effect, 'monochrome') === true;
      const m: M3 = mono
        ? [rr, rg, rb, rr, rg, rb, rr, rg, rb]
        : [rr, rg, rb, gr, gg, gb, br, bg, bb];
      return { m, offset: [p('redConst'), p('greenConst'), p('blueConst')] };
    }
    default:
      return IDENTITY_COLOR_MATRIX;
  }
}

/**
 * Compose the (enabled) color effects of a stack, in order, into one transform.
 * Each effect applies after the previous: out = Mₙ·(…M₁·rgb + o₁…) + oₙ.
 */
export function effectColorMatrix(effects: ReadonlyArray<Effect>): ColorMatrix {
  let m: M3 = I3;
  let offset: [number, number, number] = [0, 0, 0];
  let touched = false;
  for (const e of effects) {
    if (e.enabled === false || !COLOR_EFFECTS.has(e.type)) continue;
    const { m: em, offset: eo } = effectToMatrix(e);
    m = mul(em, m);
    offset = [
      em[0] * offset[0] + em[1] * offset[1] + em[2] * offset[2] + eo[0],
      em[3] * offset[0] + em[4] * offset[1] + em[5] * offset[2] + eo[1],
      em[6] * offset[0] + em[7] * offset[1] + em[8] * offset[2] + eo[2],
    ];
    touched = true;
  }
  return touched ? { m, offset } : IDENTITY_COLOR_MATRIX;
}

/** Apply a color matrix to an rgb triple (0..1), clamped to [0,1]. */
export function applyColorMatrix(cm: ColorMatrix, rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = apply3(cm.m, rgb);
  const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
  return [clamp(r + cm.offset[0]), clamp(g + cm.offset[1]), clamp(b + cm.offset[2])];
}

/**
 * Apply a color matrix in place to RGBA8 pixel data (straight, non-premultiplied
 * — as `getImageData` returns). RGB is transformed; alpha is left untouched.
 * This is the Canvas2D render path for matrix colour effects (Tint, Channel
 * Mixer) that have no CSS-filter form.
 */
export function applyColorMatrixImage(data: Uint8ClampedArray, cm: ColorMatrix): void {
  const { m, offset } = cm;
  const [o0, o1, o2] = offset;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]! / 255;
    const g = data[i + 1]! / 255;
    const b = data[i + 2]! / 255;
    // data is Uint8ClampedArray, so assignment clamps to [0,255] for us.
    data[i] = (m[0] * r + m[1] * g + m[2] * b + o0) * 255;
    data[i + 1] = (m[3] * r + m[4] * g + m[5] * b + o1) * 255;
    data[i + 2] = (m[6] * r + m[7] * g + m[8] * b + o2) * 255;
  }
}
