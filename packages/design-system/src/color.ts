/**
 * Colour, in OKLCH.
 *
 * ## Why not sRGB
 *
 * Two reasons, and both are visible rather than theoretical.
 *
 * **Ramps.** A designer's palette feels coherent because its steps are
 * *perceptually* even — each one looks a fixed amount lighter than the last.
 * Stepping lightness in sRGB does not do that: the same numeric step is a large
 * perceptual jump in the shadows and a tiny one in the highlights, so a
 * generated ramp has a muddy bottom and a washed-out top. OKLCH's L is
 * perceptual, so holding C and stepping L produces the ramp a human would pick.
 *
 * **Gradients.** Interpolating between two saturated hues in sRGB passes through
 * the middle of the RGB cube, which is desaturated and dark. That grey
 * dead-zone in the centre is the single most recognisable feature of an amateur
 * gradient. OKLCH interpolation keeps chroma up across the transition.
 *
 * ## Why the conversion is written out here
 *
 * `oklch()` exists in CSS, but nothing downstream of this package speaks CSS
 * colour: the tool schemas take hex, `buildSnapshot` reads hex, and the
 * rasterizer wants concrete channel values. So the maths lives here and every
 * public function returns a plain `#rrggbb`.
 *
 * Pure and dependency-free.
 */

// ── Types ─────────────────────────────────────────────────────────────

/** Perceptual colour. L 0..1, C 0..~0.4, H degrees 0..360. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export interface Palette {
  /** Deepest surface. Never `#000000`. */
  bg: string;
  /** A second surface, one step up — cards, panels, raised areas. */
  surface: string;
  /** Primary text/graphic colour. Never `#FFFFFF`. */
  fg: string;
  /** Secondary text — the same hue as fg, lower contrast. */
  muted: string;
  /**
   * The single loud colour. Used on ≤15% of frame area, and legible as LARGE
   * text (3:1) — which is the bar for a headline or a fill, not for a caption.
   */
  accent: string;
  /**
   * The accent, walked until it clears **4.5:1** — the bar small text has to
   * meet.
   *
   * A separate field rather than one accent held to the stricter bar, because
   * those are genuinely different colours: forcing the fill colour to 4.5:1 would
   * wash out every accent-filled button and rule in the piece. The design linter
   * caught the other half of this on real output — accent-coloured overlines
   * failing contrast in five packs at once, because they were using the 3:1
   * value at 11px.
   */
  accentText: string;
  /** A supporting colour, harmonically related to the accent. */
  support: string;
  /** Hairline / divider. */
  line: string;
}

// ── sRGB ⇄ OKLab ⇄ OKLCH ──────────────────────────────────────────────

/*
 * The one `clamp01` that STAYS a copy.
 *
 * `@utils/lang` holds the canonical one and everything under `src/` now uses
 * it. This file cannot: `packages/design-system` declares no dependencies and
 * is consumed BY the app, so importing an app util would invert that direction
 * and make a standalone package depend on the thing that depends on it.
 *
 * One line of duplication is the cheaper of the two costs. Written down so the
 * next sweep does not have to rediscover why this one survived.
 */
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** sRGB transfer function (gamma → linear). */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear → gamma-encoded sRGB. */
function toGamma(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number): string =>
    Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** sRGB hex → OKLab. Björn Ottosson's matrices. */
function hexToOklab(hex: string): { L: number; a: number; b: number } {
  const { r, g, b } = hexToRgb(hex);
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** OKLab → linear sRGB, unclamped, so gamut membership can be tested. */
function oklabToLinearRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** A hair of slack, so a colour exactly on the gamut boundary is not walked in. */
const GAMUT_EPSILON = 1e-4;

function inGamut([r, g, b]: [number, number, number]): boolean {
  return (
    r >= -GAMUT_EPSILON && r <= 1 + GAMUT_EPSILON &&
    g >= -GAMUT_EPSILON && g <= 1 + GAMUT_EPSILON &&
    b >= -GAMUT_EPSILON && b <= 1 + GAMUT_EPSILON
  );
}

function oklabToHex(L: number, a: number, b: number): string {
  const [lr, lg, lb] = oklabToLinearRgb(L, a, b);
  return rgbToHex(toGamma(lr), toGamma(lg), toGamma(lb));
}

export function hexToOklch(hex: string): Oklch {
  const { L, a, b } = hexToOklab(hex);
  const c = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/**
 * OKLCH → hex, **gamut-mapped** rather than per-channel clipped.
 *
 * This distinction is not academic. Naive clipping (`min(1, max(0, channel))`)
 * changes the ratios *between* channels, which means it changes hue and
 * lightness, not just saturation. Concretely, it broke two invariants this
 * package advertises:
 *
 *  • an OKLCH-interpolated gradient dipped BELOW the chroma of its less-saturated
 *    endpoint at the midpoint — recreating a milder version of the very sRGB
 *    dead-zone the OKLCH path exists to remove;
 *  • a "perceptually even" ramp came back uneven, because clipped mid-ramp steps
 *    landed at a different L than they were computed at.
 *
 * The fix is standard gamut mapping: hold L and H exactly, binary-search C down
 * to the largest value that is representable in sRGB. Every returned colour is
 * then the most saturated colour of the requested hue and lightness that the
 * display can actually show — which is what a designer picking by eye converges
 * on anyway.
 */
export function oklchToHex({ l, c, h }: Oklch): string {
  const rad = (h * Math.PI) / 180;
  const at = (chroma: number): [number, number, number] =>
    oklabToLinearRgb(l, Math.cos(rad) * chroma, Math.sin(rad) * chroma);

  if (inGamut(at(c))) return oklabToHex(l, Math.cos(rad) * c, Math.sin(rad) * c);

  // L itself may be out of range (a caller asking for l > 1); nothing can rescue
  // that, so fall through to the clipping path rather than searching forever.
  if (!inGamut(at(0))) return oklabToHex(l, Math.cos(rad) * c, Math.sin(rad) * c);

  let lo = 0;
  let hi = c;
  // 24 halvings resolves chroma to ~1e-7 — far finer than 8-bit output needs.
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(at(mid))) lo = mid;
    else hi = mid;
  }
  return oklabToHex(l, Math.cos(rad) * lo, Math.sin(rad) * lo);
}

// ── Ramps ─────────────────────────────────────────────────────────────

/**
 * The lightness endpoints of every generated ramp.
 *
 * **Never 0 and never 1.** Pure black and pure white are the strongest
 * "generated by a program" tells there are — physical surfaces do not reach
 * either, and a designer picking a dark background reaches for something like
 * `#0A0A0C`, not `#000000`. The design linter treats a literal `#000000` or
 * `#FFFFFF` anywhere as an error, so these bounds are what keep the ramps on the
 * right side of it.
 */
export const RAMP_L_MIN = 0.06;
export const RAMP_L_MAX = 0.97;

/**
 * A perceptually-even ramp of `steps` colours at constant hue.
 *
 * Chroma is *not* constant: it tapers toward both ends, because a very dark or
 * very light colour cannot hold high chroma without leaving sRGB — pushing it
 * anyway produces the clipped, plasticky look of a naive ramp. The taper is what
 * makes step 1 and step 10 still read as the same family.
 */
export function ramp(base: string, steps = 10): string[] {
  const { c, h } = hexToOklch(base);
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const l = RAMP_L_MIN + t * (RAMP_L_MAX - RAMP_L_MIN);
    // Triangular taper peaking mid-ramp — max chroma where sRGB has room for it.
    const headroom = 1 - Math.abs(t - 0.5) * 2;
    out.push(oklchToHex({ l, c: c * (0.35 + 0.65 * headroom), h }));
  }
  return out;
}

/**
 * Interpolate two colours **in OKLCH**, the fix for the grey dead-zone.
 *
 * Hue takes the short way round the wheel. Without that, blue → yellow
 * (240° → 100°) interpolates the long way through red instead of green, which is
 * not the transition anyone asked for.
 */
export function mix(a: string, b: string, t: number): string {
  const A = hexToOklch(a);
  const B = hexToOklch(b);
  let dh = B.h - A.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return oklchToHex({
    l: A.l + (B.l - A.l) * t,
    c: A.c + (B.c - A.c) * t,
    h: A.h + dh * t,
  });
}

/**
 * Gradient stops that actually reach the destination without going grey.
 *
 * The whole point of returning intermediate stops rather than just the endpoints
 * is that the renderer's gradient ramps blend in sRGB. Handing it explicit
 * OKLCH-computed midpoints means the sRGB blend only ever has to cover a short
 * span, where its error is invisible. Two stops in, three or four out.
 */
export function gradientStops(from: string, to: string, count = 3): string[] {
  const n = Math.max(2, Math.min(4, count));
  return Array.from({ length: n }, (_, i) => mix(from, to, i / (n - 1)));
}

// ── Contrast ──────────────────────────────────────────────────────────

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Text of this size and weight needs at least this contrast ratio. */
export function requiredContrast(fontSizePx: number, fontWeight: number): number {
  // WCAG's "large text" threshold: 18.66px bold or 24px regular.
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  return large ? 3 : 4.5;
}

/**
 * Nudge `fg` along its own lightness axis until it clears `ratio` against `bg`.
 *
 * Walks lightness rather than falling back to black or white, so a brand accent
 * used as text stays recognisably itself instead of being replaced. Direction is
 * chosen by which side of the background has more room — the reason a
 * pick-the-nearest-endpoint approach fails is that on a mid-grey background both
 * directions are viable and only one has enough headroom.
 */
export function enforceContrast(fg: string, bg: string, ratio = 4.5): string {
  if (contrast(fg, bg) >= ratio) return fg;
  const target = hexToOklch(fg);
  const bgL = hexToOklch(bg).l;
  const up = bgL < 0.5;

  let best = fg;
  let bestRatio = contrast(fg, bg);
  for (let i = 1; i <= 40; i++) {
    const l = up
      ? Math.min(RAMP_L_MAX, target.l + i * 0.02)
      : Math.max(RAMP_L_MIN, target.l - i * 0.02);
    // Very light and very dark colours cannot hold chroma; letting it ride
    // unchanged produces an out-of-gamut clip that reads as a different hue.
    const c = target.c * (1 - Math.abs(l - 0.5) * 0.6);
    const candidate = oklchToHex({ l, c, h: target.h });
    const r = contrast(candidate, bg);
    if (r > bestRatio) {
      bestRatio = r;
      best = candidate;
    }
    if (r >= ratio) return candidate;
  }
  // Could not reach the target within the ramp bounds — return the best attempt
  // rather than pure black/white, and let the design linter report the shortfall.
  return best;
}

// ── Harmony ───────────────────────────────────────────────────────────

export type HarmonyKind = 'analogous' | 'complementary' | 'split' | 'triad' | 'mono';

/** Hue offsets, in degrees, for each harmony. */
const HARMONY_OFFSETS: Record<HarmonyKind, number[]> = {
  mono: [0],
  analogous: [0, 28],
  complementary: [0, 180],
  split: [0, 150, 210],
  triad: [0, 120, 240],
};

/** A support colour harmonically related to `accent`. */
export function harmonize(accent: string, kind: HarmonyKind): string {
  const a = hexToOklch(accent);
  const offset = HARMONY_OFFSETS[kind][1] ?? 0;
  // Support sits slightly quieter than the accent by construction — two colours
  // at equal chroma fight, and "which one is the accent" stops being legible.
  return oklchToHex({ l: a.l, c: a.c * 0.72, h: (a.h + offset) % 360 });
}

// ── Palette generation ────────────────────────────────────────────────

export interface PaletteOptions {
  accent: string;
  mode?: 'dark' | 'light';
  harmony?: HarmonyKind;
  /**
   * How much of the accent's hue bleeds into the neutrals. 0 = truly neutral
   * greys; 0.03–0.06 = the tinted neutrals real design systems use, which is
   * what makes a palette read as designed rather than as "a colour on grey".
   */
  neutralTint?: number;
}

/**
 * Build a full palette from a single accent colour.
 *
 * The accent is the only required input on purpose: it is the one thing a brief
 * actually specifies, and everything else is derivable. Deriving it here rather
 * than asking a model to invent six more hexes is the difference between a
 * coherent palette and six colours that happen to co-occur.
 */
export function buildPalette(o: PaletteOptions): Palette {
  const accent = o.accent;
  const mode = o.mode ?? 'dark';
  const tint = o.neutralTint ?? 0.045;
  const a = hexToOklch(accent);

  // Neutrals carry a trace of the accent hue — see `neutralTint`.
  const neutral = (l: number, chromaScale = 1): string =>
    oklchToHex({ l, c: tint * chromaScale, h: a.h });

  const dark = mode === 'dark';
  const bg = dark ? neutral(0.14) : neutral(0.975, 0.5);
  const surface = dark ? neutral(0.2) : neutral(0.93, 0.6);
  const fgRaw = dark ? neutral(0.965, 0.4) : neutral(0.16);
  const fg = enforceContrast(fgRaw, bg, 7);
  const muted = enforceContrast(
    oklchToHex({ l: dark ? 0.66 : 0.45, c: tint * 1.4, h: a.h }),
    bg,
    4.5,
  );

  return {
    bg,
    surface,
    fg,
    muted,
    // The accent must be legible ON the background, or every accent-coloured
    // label in the piece is a contrast failure the linter will flag one by one.
    accent: enforceContrast(accent, bg, 3),
    accentText: enforceContrast(accent, bg, 4.5),
    support: harmonize(accent, o.harmony ?? 'analogous'),
    line: dark ? neutral(0.28) : neutral(0.86, 0.7),
  };
}

// ── Dominance ─────────────────────────────────────────────────────────

/**
 * The 60/30/10 rule as a checkable number.
 *
 * Background dominates, a support tone carries structure, and the accent is a
 * *spot*. Above roughly 15% of frame area an accent stops reading as emphasis
 * and starts reading as noise — which is why the design linter warns on it
 * rather than leaving it to taste.
 */
export const DOMINANCE = { background: 0.6, support: 0.3, accent: 0.1 } as const;

/** Accent area above this fraction of the frame reads as noise. */
export const ACCENT_AREA_LIMIT = 0.15;

/** True when `hex` is literally pure black or pure white. */
export function isPureBlackOrWhite(hex: string): boolean {
  const h = hex.replace('#', '').toLowerCase();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return full === '000000' || full === 'ffffff';
}
