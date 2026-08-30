/**
 * The design system the AI composes from (Phase A of the intelligence system).
 *
 * The model produces amateur work when it invents colours, sizes, durations and
 * eases per element. A pro works from a SYSTEM: a curated palette, a type scale,
 * spacing rhythm, and a small set of motion tokens (durations + easing curves).
 * This file is that system. Recipes (see recipes.ts) read a resolved style and
 * emit motion with these numbers, so every result is tasteful and consistent by
 * construction instead of by luck.
 */

// The easing curves moved to `core/animation/motionCurves.ts` — the editor's
// own animation commands need them, and they should not have to import the
// AI's design system to get an ease. Re-exported so every `from './design'`
// import in the recipe layer still resolves.
export { PHYSICS, type Bezier } from '@core/animation/motionCurves';
import type { Bezier } from '@core/animation/motionCurves';
import { PHYSICS } from '@core/animation/motionCurves';

export interface MotionStyle {
  name: string;
  palette: {
    /** Deep background. */
    bg: string;
    /** A second background tone for depth/gradients. */
    bgAccent: string;
    /** Card / panel surface — clearly lighter than the background. */
    card: string;
    /** Primary foreground / title colour. */
    fg: string;
    /** The single bright accent. */
    accent: string;
    /** Muted secondary text. */
    muted: string;
  };
  type: {
    titlePx: number;
    subtitlePx: number;
    taglinePx: number;
    weightTitle: number;
    weightBody: number;
  };
  /** Entrance duration in seconds. */
  entranceDur: number;
  /** Stagger between successive elements, seconds. */
  staggerSec: number;
  /** Entrance travel distance in px. */
  travelPx: number;
  /** Curve for entrances (positions/scales). */
  entranceCurve: Bezier;
  /** Whether hero elements get a glow. */
  glow: boolean;
}

/**
 * The curated styles. Numbers here are deliberate craft, not placeholders —
 * they are the difference between "elegant" as a word and "elegant" as motion.
 */
const STYLES: Record<string, MotionStyle> = {
  premium: {
    name: 'premium',
    palette: { bg: '#0a0e1a', bgAccent: '#0e1730', card: '#1b2540', fg: '#f5f7fa', accent: '#2f81ff', muted: '#8a93a6' },
    type: { titlePx: 104, subtitlePx: 34, taglinePx: 22, weightTitle: 700, weightBody: 400 },
    entranceDur: 0.72,
    staggerSec: 0.11,
    travelPx: 30,
    entranceCurve: PHYSICS.softOut,
    glow: true,
  },
  minimal: {
    name: 'minimal',
    palette: { bg: '#0f1115', bgAccent: '#15181f', card: '#20242e', fg: '#fafafa', accent: '#e5e7eb', muted: '#9aa0aa' },
    type: { titlePx: 88, subtitlePx: 30, taglinePx: 20, weightTitle: 600, weightBody: 400 },
    entranceDur: 0.6,
    staggerSec: 0.09,
    travelPx: 22,
    entranceCurve: PHYSICS.softOut,
    glow: false,
  },
  bold: {
    name: 'bold',
    palette: { bg: '#0b0b10', bgAccent: '#1a1030', card: '#241640', fg: '#ffffff', accent: '#ff3d71', muted: '#b0a8c0' },
    type: { titlePx: 120, subtitlePx: 36, taglinePx: 24, weightTitle: 800, weightBody: 500 },
    entranceDur: 0.55,
    staggerSec: 0.08,
    travelPx: 44,
    entranceCurve: PHYSICS.overshoot,
    glow: true,
  },
  playful: {
    name: 'playful',
    palette: { bg: '#101828', bgAccent: '#1d2b53', card: '#243867', fg: '#fef3c7', accent: '#ffd23f', muted: '#a5b4d4' },
    type: { titlePx: 100, subtitlePx: 32, taglinePx: 22, weightTitle: 700, weightBody: 500 },
    entranceDur: 0.62,
    staggerSec: 0.13,
    travelPx: 40,
    entranceCurve: PHYSICS.elastic,
    glow: true,
  },
  cyberpunk: {
    name: 'cyberpunk',
    palette: { bg: '#05050e', bgAccent: '#0f0826', card: '#181035', fg: '#00ffcc', accent: '#ff007f', muted: '#707090' },
    type: { titlePx: 110, subtitlePx: 34, taglinePx: 22, weightTitle: 900, weightBody: 600 },
    entranceDur: 0.48,
    staggerSec: 0.07,
    travelPx: 50,
    entranceCurve: PHYSICS.snappy,
    glow: true,
  },
  saas: {
    name: 'saas',
    palette: { bg: '#090d16', bgAccent: '#111827', card: '#1f2937', fg: '#f8fafc', accent: '#6366f1', muted: '#94a3b8' },
    type: { titlePx: 96, subtitlePx: 32, taglinePx: 20, weightTitle: 700, weightBody: 400 },
    entranceDur: 0.65,
    staggerSec: 0.10,
    travelPx: 28,
    entranceCurve: PHYSICS.softOut,
    glow: true,
  },
};

/** Map loose user words to a curated style. */
const STYLE_ALIASES: Record<string, string> = {
  apple: 'premium',
  luxury: 'premium',
  elegant: 'premium',
  cinematic: 'premium',
  corporate: 'minimal',
  clean: 'minimal',
  swiss: 'minimal',
  startup: 'bold',
  energetic: 'bold',
  punchy: 'bold',
  fun: 'playful',
  cyberpunk: 'cyberpunk',
  futuristic: 'cyberpunk',
  neon: 'cyberpunk',
  saas: 'saas',
  app: 'saas',
  software: 'saas',
  product: 'saas',
};

/**
 * The run's custom style, defined at runtime from the brief (via the
 * `define_style` tool or automatic derivation from the prompt). When set, it
 * is what an unnamed / 'custom' / unknown style resolves to — so the palette
 * comes from THIS brief instead of snapping to one of the 6 anchors. Explicit
 * preset names (and their aliases) still win, so "make it cyberpunk" behaves.
 * Cleared per run by createToolContext.
 */
let runtimeStyle: MotionStyle | null = null;

export function setRuntimeStyle(style: MotionStyle | null): void {
  runtimeStyle = style;
}

export function getRuntimeStyle(): MotionStyle | null {
  return runtimeStyle;
}

export function resolveStyle(name?: string): MotionStyle {
  const key = name?.toLowerCase().trim();
  const isPreset = !!key && (key in STYLES || key in STYLE_ALIASES);
  if (runtimeStyle && (!key || key === 'custom' || key === runtimeStyle.name.toLowerCase() || !isPreset)) {
    return runtimeStyle;
  }
  if (!key) return STYLES.premium!;
  return STYLES[key] ?? STYLES[STYLE_ALIASES[key] ?? ''] ?? STYLES.premium!;
}

export const STYLE_NAMES = Object.keys(STYLES);

// ── Runtime palette derivation ────────────────────────────────────────────────

/** Easing personality names accepted by define_style. */
export const EASING_PERSONALITIES = ['soft', 'overshoot', 'snappy', 'smooth', 'elastic', 'anticipate'] as const;
export type EasingPersonality = (typeof EASING_PERSONALITIES)[number];

const PERSONALITY_CURVES: Record<EasingPersonality, Bezier> = {
  soft: PHYSICS.softOut,
  overshoot: PHYSICS.overshoot,
  snappy: PHYSICS.snappy,
  smooth: PHYSICS.smooth,
  elastic: PHYSICS.elastic,
  anticipate: PHYSICS.anticipate,
};

// Minimal HSL round-trip — enough to build tints/shades of a brand colour.
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let raw = m[1]!;
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  const f = (p: number, q: number, t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (sat === 0) {
    r = g = b = lig;
  } else {
    const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
    const p = 2 * lig - q;
    r = f(p, q, hue + 1 / 3);
    g = f(p, q, hue);
    b = f(p, q, hue - 1 / 3);
  }
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Build a full 6-slot palette around ONE brand colour: a deep background in
 * the brand hue, a slightly lifted second tone, a card surface, near-white
 * foreground and a muted tone tinted the same way — the standard "dark UI in
 * the brand's key" a designer would reach for.
 */
export function paletteFromBrand(accentHex: string): MotionStyle['palette'] | null {
  const hsl = hexToHsl(accentHex);
  if (!hsl) return null;
  const { h } = hsl;
  const s = Math.max(0.25, hsl.s * 0.8);
  return {
    bg: hslToHex(h, s * 0.55, 0.06),
    bgAccent: hslToHex(h, s * 0.6, 0.1),
    card: hslToHex(h, s * 0.45, 0.17),
    fg: hslToHex(h, 0.12, 0.96),
    accent: hslToHex(h, hsl.s, Math.min(0.72, Math.max(0.45, hsl.l))),
    muted: hslToHex(h, 0.12, 0.62),
  };
}

/** Mood/industry words → the anchor whose motion tokens (not palette) we inherit. */
const MOOD_ANCHORS: [RegExp, string][] = [
  [/\b(luxur|elegant|premium|cinematic|apple|sleek|sophistic)/i, 'premium'],
  [/\b(minimal|clean|swiss|corporate|calm|subtle)/i, 'minimal'],
  [/\b(bold|energetic|punchy|loud|hype|sport|extreme|aggressive)/i, 'bold'],
  [/\b(playful|fun|friendly|bubbly|cartoon|kids?)\b/i, 'playful'],
  [/\b(cyber|neon|futuristic|glitch|tech noir|synthwave)/i, 'cyberpunk'],
  [/\b(saas|software|startup|app|dashboard|api|dev tool)/i, 'saas'],
];

const HEX_RE = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;

/**
 * Derive a MotionStyle from the brief itself, or null when the brief carries
 * no colour signal. The palette comes from the FIRST brand colour mentioned
 * (a second becomes bgAccent); motion tokens and typography come from the
 * closest mood anchor, so the result is on-brief without abandoning craft.
 * Null keeps preset behaviour untouched — derivation is additive, not a
 * replacement for the anchors.
 */
export function deriveStyleFromBrief(brief: string): MotionStyle | null {
  const hexes = brief.match(HEX_RE) ?? [];
  if (!hexes.length) return null;
  const palette = paletteFromBrand(hexes[0]!);
  if (!palette) return null;
  if (hexes[1]) {
    const second = hexToHsl(hexes[1]);
    if (second) palette.bgAccent = hslToHex(second.h, Math.max(0.3, second.s * 0.6), 0.1);
  }
  const anchorName = MOOD_ANCHORS.find(([re]) => re.test(brief))?.[1] ?? 'premium';
  const anchor = STYLES[anchorName] ?? STYLES.premium!;
  return { ...anchor, name: 'custom', palette };
}

/** Everything define_style may pass — all optional, gaps fill from an anchor. */
export interface CustomStyleInput {
  name?: string;
  /** Free-text brief used to derive whatever fields are not explicit. */
  brief?: string;
  palette?: Partial<MotionStyle['palette']> & { accent?: string };
  titlePx?: number;
  subtitlePx?: number;
  taglinePx?: number;
  weightTitle?: number;
  weightBody?: number;
  easing?: EasingPersonality;
  entranceDur?: number;
  staggerSec?: number;
  travelPx?: number;
  glow?: boolean;
  /** Anchor preset supplying defaults for unspecified fields. */
  basedOn?: string;
}

/** Build a fully-specified MotionStyle from a partial spec (pure, testable). */
export function buildCustomStyle(input: CustomStyleInput): MotionStyle {
  const derived = input.brief ? deriveStyleFromBrief(input.brief) : null;
  const anchor =
    (input.basedOn ? STYLES[input.basedOn.toLowerCase()] ?? STYLES[STYLE_ALIASES[input.basedOn.toLowerCase()] ?? ''] : undefined) ??
    derived ??
    STYLES.premium!;
  const accentPalette = input.palette?.accent ? paletteFromBrand(input.palette.accent) : null;
  const palette: MotionStyle['palette'] = {
    ...anchor.palette,
    ...(accentPalette ?? {}),
    ...Object.fromEntries(Object.entries(input.palette ?? {}).filter(([, v]) => typeof v === 'string')),
  } as MotionStyle['palette'];
  return {
    name: input.name?.trim() || 'custom',
    palette,
    type: {
      titlePx: input.titlePx ?? anchor.type.titlePx,
      subtitlePx: input.subtitlePx ?? anchor.type.subtitlePx,
      taglinePx: input.taglinePx ?? anchor.type.taglinePx,
      weightTitle: input.weightTitle ?? anchor.type.weightTitle,
      weightBody: input.weightBody ?? anchor.type.weightBody,
    },
    entranceDur: input.entranceDur ?? anchor.entranceDur,
    staggerSec: input.staggerSec ?? anchor.staggerSec,
    travelPx: input.travelPx ?? anchor.travelPx,
    entranceCurve: input.easing ? PERSONALITY_CURVES[input.easing] : anchor.entranceCurve,
    glow: input.glow ?? anchor.glow,
  };
}
