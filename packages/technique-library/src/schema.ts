/**
 * `TechniqueDef` — the unit of motion craft.
 *
 * ## The inversion this type encodes
 *
 * The LLM's job stops at **casting**: it sees an id, a one-line intent, some
 * tags, an energy range and a narrow parameter surface, and it picks. It never
 * sees a keyframe, never chooses a bezier, never decides a stagger interval.
 * `emit()` does all of that, deterministically, in hand-written code.
 *
 * That is the whole thesis. Craft lives in the library, not in the model — which
 * is why "run the caster on a weak model and the linter still passes" is the
 * project's key acceptance test. If that fails, the craft was never in here.
 *
 * ## The bar for `emit()`
 *
 * Every technique must exhibit **at least four** of the eight craft markers in
 * `CRAFT_MARKERS` below. A technique that does not is a recipe, not a technique,
 * and `assertCraftFloor` in the test suite rejects it. The distinction matters:
 * the thirteen `compose` recipes this library replaces each hit roughly one
 * marker, which is exactly why their output read as generated.
 *
 * Pure. No DOM, no engine, no `Math.random`.
 */

import type { ToolCall } from '@motion/design-system';

export type TechniqueCategory =
  | 'entrance'
  | 'kinetic_type'
  | 'transition'
  | 'camera'
  | 'background'
  | 'emphasis'
  | 'exit';

/**
 * The eight markers. A technique declares which it exhibits, and the test suite
 * VERIFIES the declaration against the emitted calls rather than trusting it —
 * a self-reported marker is worth nothing.
 */
export const CRAFT_MARKERS = [
  /** Minimum 3 keyframes on any hero move: 0.94 → 1.03 → 1.00, never 2. */
  'overshoot',
  /** A small counter-move before the main move, 2–4 frames. */
  'anticipation',
  /** Scale leads opacity by 2f; position lags rotation by 1f. Never all at once. */
  'cross_property_offset',
  /** Subordinate elements continue after the primary settles. */
  'follow_through',
  /** Four explicit floats per property, different per property. Never a preset name. */
  'explicit_bezier',
  /** Accelerating or decelerating across a group, never a fixed interval. */
  'nonuniform_stagger',
  /** Motion blur where velocity crosses a threshold. */
  'motion_blur',
  /** Hold frames, sub-frame timing on fast moves. */
  'subframe_care',
] as const;

export type CraftMarker = (typeof CRAFT_MARKERS)[number];

/** Which layout slot roles a technique knows how to animate. */
export type AnimatableRole =
  | 'headline' | 'subhead' | 'support' | 'overline'
  | 'media' | 'mark' | 'stat' | 'quote' | 'list' | 'cta' | 'rule'
  | 'background' | 'camera';

/**
 * Composition guards — enforced by the sequencer, never by the model.
 *
 * Asking an LLM "would a crash zoom twice in fifteen seconds be amateur?" gets a
 * yes and then a plan with two crash zooms. Encoding it here means the constraint
 * holds regardless of what the model says.
 */
export interface Antipatterns {
  /** Technique ids that clash with this one in the same composition. */
  neverWith?: readonly string[];
  /** Below this duration the technique cannot read at all. */
  neverUnderMs?: number;
  /** More than this many instances reads as a tic. */
  maxPerComposition?: number;
  /** Needs this much quiet before it lands. */
  requiresBreathingRoomMs?: number;
}

/** What an emitter is told about where it sits. */
export interface EmitContext {
  /** Composition seconds × 1000 at which this instance begins. */
  startMs: number;
  /** How long this instance has. */
  durationMs: number;
  /** One frame, in ms. Cross-property offsets are expressed in frames. */
  frameMs: number;
  /** Frame size, for travel distances that should scale with it. */
  width: number;
  height: number;
  /** The resolved LookPack — palette, type, pacing, motion signature. */
  pack: ResolvedPackLike;
  /**
   * Layer ids this instance animates, by slot role.
   *
   * Supplied by the layout that ran first. A technique NEVER creates the content
   * it animates — motion animates a design. A technique that had to invent its
   * own layers would encode assumptions about what is being moved, and those
   * assumptions would be "a rectangle".
   */
  targets: Partial<Record<AnimatableRole, readonly string[]>>;
  /** Prefix for any helper layers the technique does need to create. */
  idPrefix: string;
}

/**
 * The slice of `ResolvedPack` a technique actually reads.
 *
 * Structural rather than an import of the concrete type, so this package does not
 * force a dependency direction that would stop the design system evolving.
 */
export interface ResolvedPackLike {
  palette: { bg: string; surface: string; fg: string; muted: string; accent: string; accentText: string; support: string; line: string };
  pack: {
    id: string;
    pacing: { baseBeatMs: number; staggerCurve: number; cutBias: number };
    motionSignature: { overshootBias: number; blurBias: number; easeFamily: string };
  };
}

/** A minimal runtime validator for a technique's params. Zod is not a dependency. */
export interface ParamSpec {
  [key: string]:
    | { kind: 'string'; required?: boolean; default?: string }
    | { kind: 'number'; required?: boolean; default?: number; min?: number; max?: number }
    | { kind: 'boolean'; required?: boolean; default?: boolean }
    | { kind: 'stringArray'; required?: boolean; minItems?: number; maxItems?: number }
    | { kind: 'enum'; required?: boolean; values: readonly string[]; default?: string };
}

export interface TechniqueDef {
  /** e.g. 'kinetic_type.hard_cut_stack'. Category prefix is load-bearing. */
  id: string;
  category: TechniqueCategory;
  displayName: string;
  /** Cast-time metadata. Short and evocative — this is what the LLM sees. */
  intent: string;
  tags: readonly string[];
  /** [0..1] range of energy this technique reads as. */
  energy: [number, number];
  dimensionality: '2d' | '2.5d' | '3d';
  /** Narrow and semantic. Never raw keyframes. */
  params: ParamSpec;
  /** Which layout slot roles it can animate. Casting is a constrained match. */
  roles: readonly AnimatableRole[];
  /**
   * A scene resource this technique claims EXCLUSIVELY for the composition.
   *
   * `'camera'` is the one that matters today. All five camera techniques emit
   * their own `create_layer { kind: 'camera' }`, and `readSceneCamera` returns
   * the FIRST camera in the graph — so casting two of them leaves a stray camera
   * whose entire animation is silently ignored. There is no visual symptom: the
   * second move simply never happens.
   *
   * Pairwise `neverWith` covered four of the ten camera pairs and missed
   * `crash_zoom + whip_pan` and `drift_parallax + handheld_float`. Same lesson as
   * the pack `forbid` list — a hand-maintained list of pairs is correct until
   * someone adds the sixth technique.
   */
  exclusiveResource?: string;
  /** Registry tool names it needs. Validated against the live registry at boot. */
  requires: readonly string[];
  minDurationMs: number;
  maxDurationMs: number;
  approxLayerCount: number;
  approxToolCalls: number;
  antipatterns: Antipatterns;
  /** Deterministic variation. Same seed = same output, always. */
  variants: number;
  /** The craft markers this technique claims. Verified, not trusted. */
  markers: readonly CraftMarker[];
  emit(ctx: EmitContext, params: Record<string, unknown>, seed: number): ToolCall[];
}

// ── Param validation ──────────────────────────────────────────────────

export interface CoerceResult {
  ok: boolean;
  value: Record<string, unknown>;
  errors: string[];
}

/**
 * Validate and fill defaults for cast parameters.
 *
 * Coercion is deliberately forgiving on TYPE and strict on RANGE. A model that
 * sends `"3"` for a number meant 3 and the run should not fail over it; a model
 * that sends `intensity: 4` on a 0–1 scale meant something this technique cannot
 * express, and silently clamping would produce output nobody asked for. So the
 * first is fixed and the second is reported.
 *
 * **A rejected value always falls back to its default.** Reporting the error and
 * then omitting the key is the worst of both: the emitter reads `undefined`, does
 * arithmetic on it, and writes `NaN` keyframe times. That is exactly what happened
 * with a hostile `intensity: 99` — the range check fired correctly and the piece
 * came out with three NaN-timed tracks the timing linter then reported as popping.
 * The error is still returned; the emitter is just never handed a hole.
 */
export function coerceParams(spec: ParamSpec, raw: Record<string, unknown>): CoerceResult {
  const value: Record<string, unknown> = {};
  const errors: string[] = [];

  /** Record the error, then substitute the default so no emitter sees a hole. */
  const reject = (key: string, def: ParamSpec[string], message: string): void => {
    errors.push(message);
    if ('default' in def && def.default !== undefined) value[key] = def.default;
  };

  for (const [key, def] of Object.entries(spec)) {
    const v = raw[key];

    if (v === undefined || v === null) {
      if ('default' in def && def.default !== undefined) value[key] = def.default;
      else if (def.required) errors.push(`'${key}' is required`);
      continue;
    }

    switch (def.kind) {
      case 'string':
        value[key] = String(v);
        break;
      case 'boolean':
        value[key] = typeof v === 'boolean' ? v : v === 'true';
        break;
      case 'number': {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) {
          reject(key, def, `'${key}' must be a number, got ${JSON.stringify(v)}`);
          break;
        }
        if (def.min !== undefined && n < def.min) {
          reject(key, def, `'${key}' is ${n} but the minimum is ${def.min}`);
          break;
        }
        if (def.max !== undefined && n > def.max) {
          reject(key, def, `'${key}' is ${n} but the maximum is ${def.max}`);
          break;
        }
        value[key] = n;
        break;
      }
      case 'stringArray': {
        if (!Array.isArray(v)) {
          reject(key, def, `'${key}' must be an array of strings`);
          break;
        }
        const arr = v.map(String);
        if (def.minItems !== undefined && arr.length < def.minItems) {
          reject(key, def, `'${key}' needs at least ${def.minItems} item(s), got ${arr.length}`);
          break;
        }
        value[key] = def.maxItems !== undefined ? arr.slice(0, def.maxItems) : arr;
        break;
      }
      case 'enum': {
        const s = String(v);
        if (!def.values.includes(s)) {
          reject(key, def, `'${key}' must be one of ${def.values.join(' | ')}, got '${s}'`);
          break;
        }
        value[key] = s;
        break;
      }
    }
  }

  // Unknown keys are dropped rather than rejected: a model adding a plausible
  // extra field should not fail the whole cast, and the emitter would ignore it
  // anyway. They are reported so the mistake is visible.
  for (const key of Object.keys(raw)) {
    if (!(key in spec)) errors.push(`'${key}' is not a parameter of this technique (ignored)`);
  }

  return { ok: errors.every((e) => e.endsWith('(ignored)')), value, errors };
}
