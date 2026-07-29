/**
 * Depth: layered shadow stacks, elevation, glass.
 *
 * ## One shadow looks like CSS
 *
 * A single `drop-shadow` is the default and it is why generated cards look like
 * generated cards. Real depth is a *stack* of at least three:
 *
 *   • **contact** — tight, dark, barely offset. Where the object meets the
 *     surface. This is the one that makes it look *placed* rather than pasted.
 *   • **mid** — the readable shadow, offset by roughly the elevation.
 *   • **ambient** — wide, very soft, very faint. Fills the room.
 *
 * ## Shadows are not black
 *
 * A shadow is unlit surface, and unlit surface still reflects ambient light from
 * its surroundings. So a shadow on a blue-tinted background is a dark blue, not a
 * dark grey. Neutral-black shadows are, along with pure-black backgrounds, one of
 * the two strongest "made by a program" tells — and unlike most such tells it is a
 * one-line fix.
 *
 * Pure.
 */

import { hexToOklch, oklchToHex } from './color';

export interface ShadowLayer {
  /** Offset distance, px. */
  distance: number;
  /** Offset direction, degrees. 90 = straight down. */
  angle: number;
  /** Blur radius, px. */
  softness: number;
  /** 0..100. */
  opacity: number;
  color: string;
}

/**
 * Elevation levels. 0 is flush; 5 is a modal floating over everything.
 *
 * Discrete levels rather than a free `elevation: number` on purpose: an interface
 * with four arbitrary shadow depths reads as inconsistent, and consistency is
 * most of what a depth system buys.
 */
export type Elevation = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Per-level geometry, before tinting.
 *
 * The pattern across levels is deliberate: offset and blur grow roughly
 * geometrically while opacity grows only slightly. That is how real light works —
 * lifting an object spreads its shadow much faster than it darkens it. Growing
 * opacity with height instead is the classic mistake, and it makes high
 * elevations look like dark smudges.
 */
const ELEVATION_GEOMETRY: Record<Elevation, { d: number; b: number; o: number }[]> = {
  0: [],
  1: [
    { d: 1, b: 2, o: 5 },
    { d: 1, b: 3, o: 4 },
  ],
  2: [
    { d: 1, b: 2, o: 5 },
    { d: 2, b: 6, o: 6 },
    { d: 6, b: 14, o: 5 },
  ],
  3: [
    { d: 1, b: 2, o: 5 },
    { d: 4, b: 8, o: 7 },
    { d: 14, b: 30, o: 9 },
  ],
  4: [
    { d: 1, b: 3, o: 6 },
    { d: 8, b: 16, o: 8 },
    { d: 24, b: 48, o: 12 },
  ],
  5: [
    { d: 2, b: 4, o: 7 },
    { d: 14, b: 28, o: 10 },
    { d: 40, b: 80, o: 15 },
  ],
};

/**
 * A shadow colour derived from the surface it falls on.
 *
 * Keeps the background's hue, drops its lightness hard, and keeps a *little* of
 * its chroma. Dropping chroma to zero would give a neutral grey, which is the
 * thing this exists to avoid; keeping it all would give a saturated coloured
 * shadow that reads as a glow.
 */
export function shadowColorFor(backgroundHex: string): string {
  const bg = hexToOklch(backgroundHex);
  return oklchToHex({ l: 0.08, c: Math.min(0.05, bg.c * 0.7), h: bg.h });
}

export interface ElevationOptions {
  /** The surface the shadow falls on. Drives the tint. */
  background: string;
  /** Light direction, degrees. 90 = from above. One direction per composition. */
  angle?: number;
  /** Scale the whole stack — for a frame much larger or smaller than 1080p. */
  scale?: number;
}

/**
 * The shadow stack for an elevation level.
 *
 * Feed straight into `set_shadow_stack`. Returns an empty array at level 0, which
 * is a real answer: a flush element should have no shadow at all rather than a
 * token one.
 */
export function elevation(level: Elevation, o: ElevationOptions): ShadowLayer[] {
  const color = shadowColorFor(o.background);
  const angle = o.angle ?? 90;
  const scale = o.scale ?? 1;
  return ELEVATION_GEOMETRY[level].map((g) => ({
    distance: Math.round(g.d * scale * 10) / 10,
    angle,
    softness: Math.round(g.b * scale * 10) / 10,
    opacity: g.o,
    color,
  }));
}

// ── Glass ─────────────────────────────────────────────────────────────

export interface GlassSurface {
  /** Layer fill, including alpha where the engine accepts it. */
  fill: string;
  /** px for `update_layer.backdropBlur`. */
  backdropBlur: number;
  /** 0..100 layer opacity. */
  opacity: number;
  /** Hairline border colour — glass without an edge reads as a blurry hole. */
  border: string;
}

/**
 * A glass surface over a given background.
 *
 * Three things make glass read as glass, and generated versions usually have only
 * the first:
 *   1. the backdrop is blurred;
 *   2. the panel carries a faint *light* fill, because real frosted glass
 *      scatters light forward and is never neutrally transparent;
 *   3. there is a hairline edge, brighter than the fill, along the lit side.
 */
export function glass(background: string, strength = 1): GlassSurface {
  const bg = hexToOklch(background);
  const dark = bg.l < 0.5;
  const fill = oklchToHex({
    l: dark ? Math.min(0.95, bg.l + 0.5) : Math.max(0.05, bg.l - 0.05),
    c: bg.c * 0.5,
    h: bg.h,
  });
  const border = oklchToHex({
    l: dark ? 0.98 : 0.35,
    c: bg.c * 0.4,
    h: bg.h,
  });
  return {
    fill,
    backdropBlur: Math.round(18 * strength),
    // Low enough that the blurred backdrop reads through, high enough that the
    // forward scatter is visible.
    opacity: dark ? 12 : 55,
    border,
  };
}

// ── Ambient occlusion ─────────────────────────────────────────────────

/**
 * The faint dark line where two surfaces meet.
 *
 * Distinct from a drop shadow: it does not follow the light direction, because it
 * is contact darkening rather than cast shadow. A very tight, very soft, angle-
 * agnostic shadow is a good enough approximation for a 2.5D compositor, and its
 * absence is why abutting panels look pasted onto each other.
 */
export function ambientOcclusion(background: string): ShadowLayer {
  return {
    distance: 0,
    angle: 90,
    softness: 3,
    opacity: 8,
    color: shadowColorFor(background),
  };
}

/** True when a stack is a single shadow — i.e. the CSS default look. */
export function isSingleShadow(stack: readonly ShadowLayer[]): boolean {
  return stack.length === 1;
}
