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

/** A cubic-bezier easing curve [x1,y1,x2,y2]. */
export type Bezier = [number, number, number, number];

/** Named motion-physics curves — how things move, with weight and life. */
export const PHYSICS = {
  /** Confident pop with a little overshoot — entrances with character. */
  overshoot: [0.34, 1.56, 0.64, 1] as Bezier,
  /** Strong, smooth deceleration (easeOutQuint) — premium arrivals. */
  softOut: [0.22, 1, 0.36, 1] as Bezier,
  /** Snappy UI move. */
  snappy: [0.4, 0, 0.2, 1] as Bezier,
  /** Gentle in/out for holds and settles. */
  smooth: [0.45, 0, 0.55, 1] as Bezier,
} as const;

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
    entranceCurve: PHYSICS.overshoot,
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
};

export function resolveStyle(name?: string): MotionStyle {
  if (!name) return STYLES.premium!;
  const key = name.toLowerCase().trim();
  return STYLES[key] ?? STYLES[STYLE_ALIASES[key] ?? ''] ?? STYLES.premium!;
}

export const STYLE_NAMES = Object.keys(STYLES);
