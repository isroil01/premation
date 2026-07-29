/**
 * Typography: pairings, a modular scale, and the tracking curve.
 *
 * ## Hierarchy is contrast, not size
 *
 * The default failure is a headline at 48px and a subhead at 40px: technically a
 * hierarchy, perceptually one blob. Two levels need to differ by *either* a
 * clear size ratio (≥1.25×) *or* a clear weight step (≥400 units) — and
 * preferably both. Nothing here lets a template produce two adjacent levels that
 * differ by neither; the design linter enforces the same rule on the output.
 *
 * ## The tracking curve is the biggest single lever
 *
 * A font's default letter-spacing is drawn for body text. At display sizes the
 * same spacing looks loose and unresolved; at caption sizes it looks cramped.
 * Real typesetting therefore tightens display type (−2 to −4%) and opens up
 * small type (+2 to +6%). Applying that one curve does more for "looks typeset"
 * than any other single rule in this package, and it is nearly always absent from
 * generated output — a model asked for a headline emits `letterSpacing: 0`.
 *
 * Pure.
 */

export interface FontSpec {
  family: string;
  weight: number;
  /** Fallback stack, so a missing font degrades to the same *category*. */
  fallback: string;
}

export type TypeRole = 'display' | 'headline' | 'title' | 'body' | 'caption' | 'mono' | 'overline';

export interface TypeStyle {
  role: TypeRole;
  family: string;
  fontSizePx: number;
  fontWeight: number;
  /** Letter-spacing in px (the engine's unit), already through the curve. */
  letterSpacingPx: number;
  /** Multiplier, not px. */
  lineHeight: number;
}

// ── Modular scale ─────────────────────────────────────────────────────

/**
 * The three ratios worth using.
 *
 * `minorThird` for dense, information-heavy layouts; `perfectFourth` for
 * editorial work where the display size should dominate; `perfectFifth` only when
 * there are two levels and they should be violently different.
 */
export const SCALE_RATIOS = {
  minorThird: 1.2,
  majorThird: 1.25,
  perfectFourth: 1.333,
  perfectFifth: 1.5,
} as const;

export type ScaleRatio = keyof typeof SCALE_RATIOS;

/**
 * Size for `step` rungs above (or below) the base.
 *
 * Sizes come from the ratio, never from a designer's arbitrary pick. That is what
 * makes a set of sizes look related rather than merely different.
 */
export function scaleStep(basePx: number, ratio: ScaleRatio, step: number): number {
  return Math.round(basePx * SCALE_RATIOS[ratio] ** step);
}

// ── Tracking curve ────────────────────────────────────────────────────

/**
 * Letter-spacing as a fraction of font size, by size.
 *
 * Anchor points, linearly interpolated. Negative above ~40px, positive below
 * ~16px, effectively zero for body copy in between — which is exactly where a
 * font's own metrics are already correct.
 */
const TRACKING_ANCHORS: readonly [px: number, em: number][] = [
  [10, 0.06],
  [14, 0.03],
  [18, 0.008],
  [24, 0],
  [40, -0.018],
  [72, -0.03],
  [140, -0.04],
];

/**
 * Optical letter-spacing in px for a given size.
 *
 * `weightBias` tightens heavier weights a touch further: a 900-weight display
 * face has more ink per glyph, so the same spacing reads looser.
 */
export function tracking(fontSizePx: number, fontWeight = 400): number {
  const a = TRACKING_ANCHORS;
  let em: number;
  if (fontSizePx <= a[0]![0]) em = a[0]![1];
  else if (fontSizePx >= a[a.length - 1]![0]) em = a[a.length - 1]![1];
  else {
    em = 0;
    for (let i = 1; i < a.length; i++) {
      const [px1, em1] = a[i]!;
      const [px0, em0] = a[i - 1]!;
      if (fontSizePx <= px1) {
        em = em0 + ((em1 - em0) * (fontSizePx - px0)) / (px1 - px0);
        break;
      }
    }
  }
  const weightBias = fontWeight >= 700 ? 0.9 : fontWeight <= 300 ? 1.08 : 1;
  return Number((fontSizePx * em * weightBias).toFixed(2));
}

/** Display type at zero tracking is the tell this catches. */
export function isDisplaySize(fontSizePx: number): boolean {
  return fontSizePx >= 40;
}

// ── Line height ───────────────────────────────────────────────────────

/**
 * Line-height multiplier by role.
 *
 * Display type sits TIGHT — often below 1.0, because at 96px the natural gap
 * between two lines is already larger than the eye wants. Body copy needs
 * 1.4–1.6 to be readable. A single line-height across both is the other half of
 * the "one blob" problem.
 */
const LINE_HEIGHTS: Record<TypeRole, number> = {
  display: 0.94,
  headline: 1.04,
  title: 1.15,
  body: 1.5,
  caption: 1.4,
  mono: 1.45,
  overline: 1.2,
};

// ── Pairings ──────────────────────────────────────────────────────────

/**
 * Curated pairings, never "pick a font".
 *
 * Each entry names a display face, a body face and a mono face that are known to
 * work together. `weightContrast` is the *minimum* weight gap the pairing can
 * carry — a family with only 400 and 700 cannot deliver a 500-unit step, so a
 * template asking for one on that pairing must be told rather than silently given
 * 300.
 */
export interface TypePairing {
  id: string;
  display: FontSpec;
  body: FontSpec;
  mono: FontSpec;
  ratio: ScaleRatio;
  /** Largest weight gap this pairing can express. */
  weightContrast: number;
}

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export const TYPE_PAIRINGS: readonly TypePairing[] = [
  {
    id: 'grotesque',
    display: { family: 'Inter', weight: 800, fallback: SANS },
    body: { family: 'Inter', weight: 400, fallback: SANS },
    mono: { family: 'JetBrains Mono', weight: 400, fallback: MONO },
    ratio: 'perfectFourth',
    weightContrast: 500,
  },
  {
    id: 'swiss',
    display: { family: 'Helvetica Neue', weight: 700, fallback: SANS },
    body: { family: 'Helvetica Neue', weight: 400, fallback: SANS },
    mono: { family: 'IBM Plex Mono', weight: 400, fallback: MONO },
    ratio: 'perfectFifth',
    weightContrast: 400,
  },
  {
    id: 'editorial',
    display: { family: 'Playfair Display', weight: 700, fallback: SERIF },
    body: { family: 'Inter', weight: 400, fallback: SANS },
    mono: { family: 'IBM Plex Mono', weight: 400, fallback: MONO },
    ratio: 'perfectFourth',
    weightContrast: 400,
  },
  {
    id: 'geometric',
    display: { family: 'Poppins', weight: 700, fallback: SANS },
    body: { family: 'Inter', weight: 400, fallback: SANS },
    mono: { family: 'JetBrains Mono', weight: 400, fallback: MONO },
    ratio: 'majorThird',
    weightContrast: 400,
  },
  {
    id: 'technical',
    display: { family: 'JetBrains Mono', weight: 700, fallback: MONO },
    body: { family: 'Inter', weight: 400, fallback: SANS },
    mono: { family: 'JetBrains Mono', weight: 400, fallback: MONO },
    ratio: 'minorThird',
    weightContrast: 400,
  },
  {
    id: 'humanist',
    display: { family: 'Söhne', weight: 600, fallback: SANS },
    body: { family: 'Söhne', weight: 400, fallback: SANS },
    mono: { family: 'Söhne Mono', weight: 400, fallback: MONO },
    ratio: 'majorThird',
    weightContrast: 400,
  },
] as const;

export function pairing(id: string): TypePairing {
  return TYPE_PAIRINGS.find((p) => p.id === id) ?? TYPE_PAIRINGS[0]!;
}

// ── Building a style ──────────────────────────────────────────────────

/**
 * Scale rungs per role, relative to the base body size.
 *
 * `title` is TWO rungs above body and `overline` two below, not one each. At one
 * rung the gap is the raw scale ratio — 1.2 on `minorThird`, 1.25 on
 * `majorThird` — which lands exactly at or below the 1.25 hierarchy-contrast
 * threshold. The design linter caught this on real output: `title` vs `body` and
 * `overline` vs `body` both failed `WEAK_TYPE_CONTRAST` in every pack using a
 * tight ratio, because a 1.24× step with a 200-unit weight gap genuinely does
 * read as one block. Two rungs gives ≥1.44× on the tightest ratio.
 */
const ROLE_STEPS: Record<TypeRole, number> = {
  display: 5,
  // 4, not 3 — `title` moved to 2, and one rung apart is the same 1.2–1.25 gap
  // that failed for title/body. Integer rounding makes it worse than the ratio
  // suggests: at a 17px base, 3 rungs is 33px and 2 rungs is 27px, a real ratio
  // of 1.22. The linter caught it on `grid.feature_tiles` and
  // `list.numbered_steps`, where a section headline sits directly above a card
  // title and the two read as one size.
  headline: 4,
  title: 2,
  body: 0,
  caption: -1,
  mono: 0,
  overline: -2,
};

export interface TypeScaleOptions {
  pairing: TypePairing;
  /** Body size in px. Scale with the frame, not a fixed 16. */
  basePx: number;
}

/**
 * A concrete style for a role — the tracking curve and role line-height applied.
 *
 * This is the only function a template should use to size text. Setting
 * `fontSize` directly bypasses both the scale and the tracking curve, which is
 * how display type ends up at zero tracking.
 */
export function typeStyle(o: TypeScaleOptions, role: TypeRole, weightOverride?: number): TypeStyle {
  const p = o.pairing;
  const isDisplayRole = role === 'display' || role === 'headline';
  const spec = role === 'mono' ? p.mono : isDisplayRole ? p.display : p.body;
  const fontSizePx = Math.max(9, scaleStep(o.basePx, p.ratio, ROLE_STEPS[role]));
  // An overline is small, so weight is the only lever it has to hold its own
  // against body copy — 600 was not enough to clear the 400-unit contrast bar
  // against a 400-weight body.
  const fontWeight = weightOverride ?? (role === 'overline' ? 700 : spec.weight);
  return {
    role,
    family: spec.family,
    fontSizePx,
    fontWeight,
    letterSpacingPx: role === 'overline'
      // Overlines are the one place generous positive tracking is correct at any
      // size — it is what makes a small all-caps label read as a label.
      ? Number((fontSizePx * 0.12).toFixed(2))
      : tracking(fontSizePx, fontWeight),
    lineHeight: LINE_HEIGHTS[role],
  };
}

/** Body size that suits a frame — 16px at 1080p, scaled proportionally. */
export function baseSizeFor(frameHeight: number): number {
  return Math.max(11, Math.round((frameHeight / 1080) * 17));
}

// ── Hierarchy validation ──────────────────────────────────────────────

/** Minimum weight gap between adjacent hierarchy levels. */
export const MIN_WEIGHT_CONTRAST = 400;
/** Minimum size ratio between adjacent hierarchy levels. */
export const MIN_SIZE_RATIO = 1.25;

/**
 * Do two adjacent levels read as distinct?
 *
 * Either lever is sufficient; neither is not. Two weights of one family beat two
 * families, which is why weight is checked first.
 */
export function hasHierarchyContrast(
  a: { fontSizePx: number; fontWeight: number },
  b: { fontSizePx: number; fontWeight: number },
): boolean {
  const weightGap = Math.abs(a.fontWeight - b.fontWeight);
  const ratio = Math.max(a.fontSizePx, b.fontSizePx) / Math.max(1, Math.min(a.fontSizePx, b.fontSizePx));
  return weightGap >= MIN_WEIGHT_CONTRAST || ratio >= MIN_SIZE_RATIO;
}

// ── Line breaking ─────────────────────────────────────────────────────

/**
 * Break a headline into lines with no widow.
 *
 * A widow — a last line holding one short word — is the most common typographic
 * fault in generated output, because naive greedy wrapping produces one whenever
 * the text length lands badly. When the last line would be a single word, a word
 * is pulled down from the line above.
 *
 * `maxPerLine` is in characters, which is a rough proxy for width; templates that
 * know the real measure can pass a tighter number.
 */
export function breakLines(text: string, maxPerLine: number, maxLines = 4): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxPerLine && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  // Widow control: a final line of one word gets a companion from above.
  if (lines.length >= 2) {
    const last = lines[lines.length - 1]!;
    if (!last.includes(' ')) {
      const prev = lines[lines.length - 2]!;
      const idx = prev.lastIndexOf(' ');
      if (idx > 0) {
        lines[lines.length - 2] = prev.slice(0, idx);
        lines[lines.length - 1] = `${prev.slice(idx + 1)} ${last}`;
      }
    }
  }

  // Over the line budget: fold the tail into the last allowed line rather than
  // silently dropping text — losing a word from a headline is worse than a long
  // line, and the caller can see the length and re-break.
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    kept.push(lines.slice(maxLines - 1).join(' '));
    return kept;
  }
  return lines;
}
