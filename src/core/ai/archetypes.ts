/**
 * Entrance archetypes — the de-templating layer for the compose recipes.
 *
 * Every compose tool used to funnel through ONE entrance (fade + rise + rotX),
 * so different prompts produced near-identical videos. This module makes the
 * entrance a PARAMETER: six distinct archetypes, each a keyframe/easing
 * generator, selected by element role + style personality + a per-run
 * variation seed — so two runs of the same prompt differ, and different
 * prompts differ more. Compose tools can also request one explicitly via
 * their optional `entrance` param.
 *
 * The keyframe math lives in PURE functions (`entranceTrackPlans`,
 * `pickEntranceArchetype`, `nonUniformStagger`) so it is unit-testable without
 * a scene graph; `applyEntrance` is the thin impure applicator.
 */

import type { ToolContext } from '@motion/ai-tools';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { set3DEnabled } from '@core/scene/threeD';
import { addTextAnimator, updateAnimator, readAnimatorData } from '@core/text/textAnimators';
import { PHYSICS, type Bezier, type MotionStyle } from './design';

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
  easing?: string;
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

// ── Deterministic per-run variation ────────────────────────────────

let runSeed = 1;

/** Set the variation seed for this AI run (called from createToolContext). */
export function setEntranceSeed(seed: number): void {
  runSeed = seed >>> 0 || 1;
}

export function currentEntranceSeed(): number {
  return runSeed;
}

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
}): EntranceArchetype {
  const weights = STYLE_WEIGHTS[opts.styleName ?? ''] ?? STYLE_WEIGHTS.premium!;
  const allowed = ROLE_ALLOWED[opts.role];
  const entries = allowed
    .map((a) => [a, weights[a] ?? 1] as const)
    .filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = hashFrac(opts.seed ?? runSeed, opts.role, opts.index ?? 0) * total;
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
export function nonUniformStagger(count: number, staggerSec: number, seed: number = runSeed): number[] {
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

// ── Impure applicator ──────────────────────────────────────────────

export interface ApplyEntranceOptions {
  /** Explicit archetype (from the tool's `entrance` param). Omit = varied auto-pick. */
  archetype?: EntranceArchetype;
  role?: EntranceRole;
  /** Sibling index — feeds the pick hash so a row varies deliberately. */
  index?: number;
  /** Accent multiplier on travel (deliberate asymmetry: one element pops more). */
  travelScale?: number;
}

/** Coerce a requested archetype away from targets it cannot work on. */
function resolveArchetype(ctx: ToolContext, id: string, opts: ApplyEntranceOptions, s: MotionStyle): EntranceArchetype {
  const role = opts.role ?? 'generic';
  let arch =
    opts.archetype ??
    pickEntranceArchetype({ role, styleName: s.name, seed: runSeed, index: opts.index ?? 0 });
  const isText = ctx.scene.get(id)?.kind === 'text';
  if (arch === 'char_cascade' && !isText) arch = 'scale_pop';
  return arch;
}

function setKfs(ctx: ToolContext, id: string, plans: EntranceTrackPlan[]): void {
  for (const plan of plans) {
    for (const pt of plan.points) {
      const lt = ctx.time.toLayerTime(id, pt.t);
      ctx.anim.setKeyframe(id, plan.prop, lt, pt.value, pt.easing ?? 'easeOut');
      if (pt.easing === 'bezier' && pt.bezier) ctx.anim.setBezier(id, plan.prop, lt, pt.bezier);
    }
  }
}

/**
 * Apply an entrance to a layer. Replaces the old always-rise `entranceRise3D`:
 * same contract (start + style + resting centre), but the archetype varies.
 */
export function applyEntrance(
  ctx: ToolContext,
  id: string,
  start: number,
  s: MotionStyle,
  cy: number,
  opts: ApplyEntranceOptions = {},
): EntranceArchetype {
  const arch = resolveArchetype(ctx, id, opts, s);
  const node = ctx.scene.get(id);
  const cx = node?.x ?? 0;
  const travelPx = s.travelPx * (opts.travelScale ?? 1);
  const direction = (['left', 'right', 'up', 'down'] as const)[
    hash32(runSeed, 'dir', opts.index ?? 0, id) % 4
  ];
  const params: EntranceParams = { start, dur: s.entranceDur, travelPx, cy, cx, curve: s.entranceCurve, direction };

  if (arch === 'rise') set3DEnabled(id, true);
  setKfs(ctx, id, entranceTrackPlans(arch, params));

  if (arch === 'blur_resolve') {
    const fx = ctx.scene.addEffect(id, 'blur');
    if (fx) {
      setKfs(ctx, id, [{ prop: `effect.${fx}`, points: blurResolvePoints(start, s.entranceDur) }]);
    }
  }

  if (arch === 'char_cascade') {
    const raw = defaultSceneGraph.getNode(id);
    if (raw) {
      addTextAnimator(id);
      const idx = readAnimatorData(raw).length - 1;
      // Covered glyphs are invisible and offset down; sweeping the selector
      // window off the string (offset 0 → 100) reveals characters left→right.
      updateAnimator(id, idx, { basedOn: 'characters', shape: 'rampUp', start: 0, end: 100, opacity: 0, y: 16, scale: 88 });
      setKfs(ctx, id, [
        { prop: `ta.${idx}.offset`, points: charCascadePoints(start, Math.max(0.4, s.entranceDur * 1.1)) },
      ]);
    }
  }

  return arch;
}
