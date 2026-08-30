/**
 * Entrance archetypes — the pure keyframe craft behind "make this animate in".
 *
 * Six distinct entrances, each a keyframe generator, chosen by element role and
 * a variation seed. It exists because ONE entrance applied to everything is
 * what makes motion look templated: every element rising and fading the same
 * way reads as a slideshow, not as design.
 *
 * Everything here is PURE — plans in terms of property names, times and values,
 * with no scene graph, no animation engine and no tool context anywhere. That
 * is what lets the same craft serve two very different callers: the AI recipes
 * in `core/ai/` (which had it first, and still re-export it) and the editor's
 * own choreography commands in `choreography.ts`, where a person selects some
 * layers and asks for them to animate in.
 *
 * The seed matters. Perfectly even stagger and one fixed entrance are both
 * tells of machine-made motion; `nonUniformStagger` and the weighted pick are
 * how the output gets a rhythm instead of a metronome.
 */

import type { EasingKind } from '@motion/animation';
import { PHYSICS, type Bezier } from './motionCurves';

export const ENTRANCE_ARCHETYPES = [
  'rise',
  'scale_pop',
  'blur_resolve',
  'slide_settle',
  'mask_wipe',
  'char_cascade',
] as const;
export type EntranceArchetype = (typeof ENTRANCE_ARCHETYPES)[number];

/** The roles the picker knows about — coarse on purpose. */
export type EntranceRole = 'title' | 'subtitle' | 'tagline' | 'card' | 'emblem' | 'word' | 'generic';

export interface EntrancePoint {
  t: number;
  value: number;
  /** Typed against the engine's own union rather than `string`: these plans
   *  are written straight into keyframes, so a typo belongs at compile time. */
  easing?: EasingKind;
  bezier?: Bezier;
}

export interface EntranceTrackPlan {
  prop: string;
  points: EntrancePoint[];
}

export interface EntranceParams {
  /** Entrance start, composition seconds. */
  start: number;
  /** Entrance duration, seconds. */
  dur: number;
  /** Travel distance in px (style token; may be scaled for an accent element). */
  travelPx: number;
  /** Resting centre Y of the element. */
  cy: number;
  /** Resting centre X — needed by the horizontal archetypes. */
  cx: number;
  /** The style's entrance curve. */
  curve: Bezier;
  /** Slide direction for slide_settle. */
  direction?: 'left' | 'right' | 'up' | 'down';
}

// ── Deterministic variation ────────────────────────────────────────

/** Small fast integer hash (xorshift-style) — deterministic, no Math.random. */
export function hash32(...parts: (number | string)[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Uniform [0,1) from a hash — the building block for controlled variation. */
export function hashFrac(...parts: (number | string)[]): number {
  return hash32(...parts) / 0x100000000;
}

// ── Archetype selection ────────────────────────────────────────────

/**
 * Weighted pick per style personality. Weights are craft judgements: premium
 * favours restraint (blur/rise), bold and playful favour pop and travel,
 * cyberpunk favours wipes and snap. `rise` is never the only option — the
 * whole point is that the default is VARIED, not always-rise.
 */
const STYLE_WEIGHTS: Record<string, Partial<Record<EntranceArchetype, number>>> = {
  premium: { rise: 3, blur_resolve: 3, scale_pop: 1, slide_settle: 2, mask_wipe: 1, char_cascade: 2 },
  minimal: { rise: 3, blur_resolve: 2, slide_settle: 2, mask_wipe: 2, scale_pop: 1, char_cascade: 1 },
  bold: { scale_pop: 3, slide_settle: 3, rise: 1, mask_wipe: 2, blur_resolve: 1, char_cascade: 2 },
  playful: { scale_pop: 4, slide_settle: 2, rise: 1, char_cascade: 2, mask_wipe: 1, blur_resolve: 1 },
  cyberpunk: { mask_wipe: 3, slide_settle: 2, scale_pop: 2, char_cascade: 2, rise: 1, blur_resolve: 1 },
  saas: { rise: 2, blur_resolve: 2, scale_pop: 2, slide_settle: 2, mask_wipe: 1, char_cascade: 1 },
};

/** Which archetypes make sense for which roles. */
const ROLE_ALLOWED: Record<EntranceRole, readonly EntranceArchetype[]> = {
  title: ENTRANCE_ARCHETYPES,
  subtitle: ['rise', 'blur_resolve', 'slide_settle', 'char_cascade', 'mask_wipe'],
  tagline: ['rise', 'blur_resolve', 'slide_settle', 'mask_wipe'],
  card: ['rise', 'scale_pop', 'slide_settle', 'blur_resolve', 'mask_wipe'],
  emblem: ['scale_pop', 'blur_resolve', 'rise', 'mask_wipe'],
  word: ['scale_pop', 'rise', 'slide_settle'],
  generic: ['rise', 'scale_pop', 'blur_resolve', 'slide_settle', 'mask_wipe'],
};

export function pickEntranceArchetype(opts: {
  role: EntranceRole;
  styleName?: string;
  seed?: number;
  index?: number;
  /**
   * Narrow the pick further than the role does. A caller that cannot perform
   * every archetype — the editor command installs no effects or text
   * animators, so it cannot do `blur_resolve` or `char_cascade` — says so here
   * rather than picking one and quietly substituting another, which would skew
   * the distribution toward whatever the fallback happens to be.
   */
  allowed?: readonly EntranceArchetype[];
}): EntranceArchetype {
  const weights = STYLE_WEIGHTS[opts.styleName ?? ''] ?? STYLE_WEIGHTS.premium!;
  const roleAllowed = ROLE_ALLOWED[opts.role];
  const allowed = opts.allowed
    ? roleAllowed.filter((a) => opts.allowed!.includes(a))
    : roleAllowed;
  if (allowed.length === 0) return opts.allowed?.[0] ?? 'rise';
  const entries = allowed
    .map((a) => [a, weights[a] ?? 1] as const)
    .filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = hashFrac(opts.seed ?? 1, opts.role, opts.index ?? 0) * total;
  for (const [a, w] of entries) {
    r -= w;
    if (r <= 0) return a;
  }
  return entries[entries.length - 1]?.[0] ?? 'rise';
}

/**
 * Monotonic but NON-uniform stagger offsets: each gap is 0.7–1.3× the style's
 * stagger, driven by the seed. Perfectly even staggers read as mechanical; a
 * human animator's rhythm breathes.
 */
export function nonUniformStagger(count: number, staggerSec: number, seed = 1): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    out.push(t);
    t += staggerSec * (0.7 + 0.6 * hashFrac(seed, 'stagger', i));
  }
  return out;
}

// ── Pure keyframe generation ───────────────────────────────────────

/**
 * The keyframe plans for one archetype. `char_cascade` and the blur track of
 * `blur_resolve` need runtime ids (text-animator index / effect id) — those are
 * layered on by `applyEntrance`; this returns the id-free tracks.
 */
export function entranceTrackPlans(archetype: EntranceArchetype, p: EntranceParams): EntranceTrackPlan[] {
  const { start, dur, cy, cx, curve } = p;
  const fadeIn = (frac: number): EntranceTrackPlan => ({
    prop: 'opacity',
    points: [
      { t: start, value: 0, easing: 'easeOut' },
      { t: start + dur * frac, value: 100, easing: 'easeOut' },
    ],
  });

  switch (archetype) {
    case 'rise':
      return [
        fadeIn(0.55),
        {
          prop: 'y',
          points: [
            { t: start, value: cy + p.travelPx, easing: 'bezier', bezier: curve },
            { t: start + dur, value: cy, easing: 'bezier', bezier: curve },
          ],
        },
        {
          prop: 'rotationX',
          points: [
            { t: start, value: 15, easing: 'bezier', bezier: curve },
            { t: start + dur, value: 0, easing: 'bezier', bezier: curve },
          ],
        },
      ];

    case 'scale_pop':
      return [
        fadeIn(0.35),
        {
          prop: 'scale',
          points: [
            { t: start, value: 0.85, easing: 'bezier', bezier: PHYSICS.overshoot },
            { t: start + dur, value: 1, easing: 'bezier', bezier: PHYSICS.overshoot },
          ],
        },
        {
          prop: 'y',
          points: [
            { t: start, value: cy + Math.min(10, p.travelPx * 0.25), easing: 'bezier', bezier: PHYSICS.overshoot },
            { t: start + dur, value: cy, easing: 'bezier', bezier: PHYSICS.overshoot },
          ],
        },
      ];

    case 'blur_resolve':
      // The blur track itself (effect.<id>) is added by applyEntrance.
      return [
        fadeIn(0.6),
        {
          prop: 'scale',
          points: [
            { t: start, value: 1.04, easing: 'bezier', bezier: PHYSICS.softOut },
            { t: start + dur, value: 1, easing: 'bezier', bezier: PHYSICS.softOut },
          ],
        },
      ];

    case 'slide_settle': {
      const dirn = p.direction ?? 'left';
      const travel = Math.max(40, Math.min(80, p.travelPx * 1.6));
      const horizontal = dirn === 'left' || dirn === 'right';
      const sign = dirn === 'left' || dirn === 'up' ? -1 : 1;
      return [
        fadeIn(0.45),
        {
          prop: horizontal ? 'x' : 'y',
          points: [
            { t: start, value: (horizontal ? cx : cy) + sign * travel, easing: 'bezier', bezier: PHYSICS.overshoot },
            { t: start + dur, value: horizontal ? cx : cy, easing: 'bezier', bezier: PHYSICS.overshoot },
          ],
        },
      ];
    }

    case 'mask_wipe':
      // Clip-style centre-out reveal: the element expands horizontally from a
      // sliver while opacity snaps up — reads as a wipe without needing an
      // animated mask path (which the engine cannot keyframe).
      return [
        fadeIn(0.22),
        {
          prop: 'scaleX',
          points: [
            { t: start, value: 0.02, easing: 'bezier', bezier: PHYSICS.softOut },
            { t: start + dur * 0.85, value: 1, easing: 'bezier', bezier: PHYSICS.softOut },
          ],
        },
      ];

    case 'char_cascade':
      // Base track only — the per-character sweep (ta.<i>.offset) is authored
      // by applyEntrance once the animator index exists. Non-text layers are
      // re-routed to scale_pop before we get here.
      return [fadeIn(0.3)];
  }
}

/** The blur values for blur_resolve's effect track (prop id supplied later). */
export function blurResolvePoints(start: number, dur: number): EntrancePoint[] {
  return [
    { t: start, value: 12, easing: 'easeOut' },
    { t: start + dur, value: 0, easing: 'easeOut' },
  ];
}

/** The offset sweep for char_cascade's text animator (ta.<i>.offset). */
export function charCascadePoints(start: number, dur: number): EntrancePoint[] {
  return [
    { t: start, value: 0, easing: 'easeOut' },
    { t: start + dur, value: 100, easing: 'easeOut' },
  ];
}
