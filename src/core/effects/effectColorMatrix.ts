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
  'brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'hue-rotate', 'invert',
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

/** Build the {matrix, offset} for one color effect (amount in its own unit). */
function effectToMatrix(type: EffectType, amount: number): ColorMatrix {
  switch (type) {
    case 'brightness': {
      const b = amount / 100;
      return { m: [b, 0, 0, 0, b, 0, 0, 0, b], offset: [0, 0, 0] };
    }
    case 'contrast': {
      const c = amount / 100;
      const o = 0.5 * (1 - c);
      return { m: [c, 0, 0, 0, c, 0, 0, 0, c], offset: [o, o, o] };
    }
    case 'saturate':
      return { m: saturateMatrix(amount / 100), offset: [0, 0, 0] };
    case 'grayscale':
      return { m: saturateMatrix(1 - amount / 100), offset: [0, 0, 0] };
    case 'sepia':
      return { m: sepiaMatrix(amount / 100), offset: [0, 0, 0] };
    case 'hue-rotate':
      return { m: hueRotateMatrix(amount), offset: [0, 0, 0] };
    case 'invert': {
      const i = amount / 100;
      const k = 1 - 2 * i;
      return { m: [k, 0, 0, 0, k, 0, 0, 0, k], offset: [i, i, i] };
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
    const { m: em, offset: eo } = effectToMatrix(e.type, e.amount);
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
