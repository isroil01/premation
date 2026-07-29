/**
 * The caster's data shapes.
 *
 * ## The pipeline
 *
 * ```
 * prompt
 *   ├─▶ [LLM 1: strong]  CREATIVE BRIEF
 *   ├─▶ [deterministic]  SEQUENCER          ← beats, continuity contract, budgets
 *   ├─▶ [LLM 2: strong]  CAST LAYOUT        ← template + params + seed, per beat
 *   ├─▶ [deterministic]  COMPOSE            ← static design; DESIGN LINTER runs
 *   ├─▶ [LLM 2: strong]  CAST MOTION        ← technique + params + seed, per slot
 *   ├─▶ [deterministic]  EMIT + VALIDATE    ← TIMING + UI linters run
 *   ├─▶ [existing]       EXECUTE            ← unchanged, inside aiTransaction
 *   └─▶ [LLM 3: optional] FIT CRITIC
 * ```
 *
 * Three LLM calls, down from roughly thirty. The model decides **what and why**;
 * code decides **how**, and "how" is where professionalism lives.
 *
 * ## What the LLM never sees
 *
 * A keyframe. A bezier. A stagger interval. A hex colour it did not supply. Those
 * are all produced by the libraries, deterministically, from an id plus a handful
 * of semantic parameters plus a seed.
 */

import type { SlotContent, SlotRole } from '@motion/design-system';

// ── Stage 1: the creative brief (LLM) ─────────────────────────────────

/**
 * What the first model call returns.
 *
 * Deliberately small. Every field is a *decision* rather than a specification —
 * which look, how much energy, what the beats are about. Nothing here describes
 * motion, because the model has no way to judge motion.
 */
export interface CreativeBrief {
  lookPackId: string;
  /** Brand accent, when the brief names one. Otherwise the pack's default. */
  accent?: string;
  mode?: 'dark' | 'light';
  /** 0..1. Drives which techniques are even offered. */
  energy: number;
  /** One line, for the record. Shown back to the user. */
  tone: string;
  totalDurationMs: number;
  beats: readonly BriefBeat[];
}

export interface BriefBeat {
  /** What this beat is FOR. Free text; the caster reads it as a tag hint. */
  purpose: string;
  /** Fraction of the total duration. Normalised by the sequencer. */
  weight: number;
  content: SlotContent;
  /**
   * Art direction for imagery in this beat — subject and treatment, no layout.
   *
   * The one thing in the brief that is genuinely the model's to decide and that
   * no library can supply: what the piece should be a picture OF. Everything
   * else here is a choice among authored options; this is the only field whose
   * value cannot be enumerated in advance.
   *
   * It exists because of a measured ceiling. The design linter has always had a
   * `PRIMITIVE_ONLY` rule reading, in full: "Nothing in this composition is an
   * imported or generated asset — it is entirely rectangles and text. That is
   * the ceiling on how designed it can look." It fired on 100% of output, and no
   * template could satisfy it, because nothing in the pipeline could produce an
   * image. The rule was right and had nowhere to go.
   *
   * Absent means no imagery, which is correct for a product-UI beat and for any
   * look built on type and space alone. Present means the emitter turns this
   * beat's media slot into a real generated picture.
   */
  art?: string;
}

/**
 * The `mediaAssetId` sentinel meaning "art direction, not a library asset".
 *
 * A beat carrying `art` needs to be a candidate for the media-required layout
 * templates, and candidacy is decided by `availableRoles`, which reads
 * `mediaAssetId`. So the sequencer stamps this value, the registry sees a
 * fillable media role, and the emitter — the only place that knows the
 * difference — rewrites the template's `create_media` into a `generate_image`.
 *
 * Deliberately not a real-looking id: if one ever escapes to `create_media` the
 * failure is an obvious "no imported asset with id '__generated__'" rather than
 * a silently wrong picture.
 */
export const GENERATED_MEDIA = '__generated__';

// ── Stage 2: the sequencer (deterministic) ────────────────────────────

/**
 * How one element crosses a beat boundary.
 *
 * The continuity contract. Every boundary must declare at least one survivor, and
 * the sequencer REJECTS a plan where one does not — that rejection is what turns
 * a sequence of segments into a piece.
 *
 * The old system's rule was "3–5 scenes tiling the duration", which structurally
 * guarantees a slideshow: discrete, non-overlapping segments with nothing crossing
 * the boundary. Replacing a tiling rule with a survival rule is the whole change.
 */
export type SurvivalKind = 'persist' | 'transform_into' | 'match_cut' | 'carry_motion' | 'mask_reveal';

export interface Survival {
  kind: SurvivalKind;
  /** The slot role that survives. */
  role: SlotRole;
}

export interface Beat {
  index: number;
  startMs: number;
  durationMs: number;
  purpose: string;
  content: SlotContent;
  /** Tag hints derived from `purpose`, used to rank candidates. */
  tags: readonly string[];
  /** How this beat connects to the NEXT one. Absent on the last beat. */
  survival?: Survival;
  /** Art direction carried through from the brief. See `BriefBeat.art`. */
  art?: string;
}

export interface Sequence {
  beats: readonly Beat[];
  totalDurationMs: number;
  /** Boundaries and their survivor counts, for the NO_CONTINUITY rule. */
  boundaries: readonly { atMs: number; survivors: number }[];
}

// ── Stage 3: casting (LLM) ────────────────────────────────────────────

/** One layout choice for one beat. */
export interface LayoutCast {
  beatIndex: number;
  templateId: string;
  /** Variant seed. The caster picks; determinism comes from it. */
  seed: number;
}

/** One motion choice for one beat. */
export interface MotionCast {
  beatIndex: number;
  techniqueId: string;
  /** Semantic params only. Never keyframes. */
  params: Record<string, unknown>;
  seed: number;
  /** Which roles this instance animates. Validated against the layout's slots. */
  roles?: readonly SlotRole[];
}

export interface Casting {
  layouts: readonly LayoutCast[];
  motion: readonly MotionCast[];
}

// ── Stage 4: the result ───────────────────────────────────────────────

export interface CastResult {
  calls: readonly { name: string; args: Record<string, unknown> }[];
  /** Everything the linters and the metrics need, without re-deriving it. */
  report: CastReport;
}

export interface CastReport {
  lookPackId: string;
  beats: number;
  /** Technique instance ids in cast order. */
  techniques: readonly string[];
  /** Layout template ids in cast order. */
  templates: readonly string[];
  /** Seeds actually used, so a run is reproducible from the report alone. */
  seeds: readonly number[];
  /**
   * The metrics that replace `compose ratio`.
   *
   * The old number measured the share of mutations that went through the recipe
   * layer and treated a high ratio as quality — but with a small generic recipe
   * set, a high ratio means every output came from the same handful of shapes. It
   * measured HOMOGENEITY and reported it as quality.
   */
  metrics: CastMetrics;
  /** Findings from all three linters, already merged. */
  findings: readonly { source: 'design' | 'timing' | 'ui'; rule: string; severity: 'error' | 'warn'; message: string }[];
  /** Weighted pass rates, 0..1. */
  designScore: number;
  craftScore: number;
  uiMotionScore: number;
  /** Whether a deterministic repair pass ran, and what it changed. */
  repairs: readonly string[];
}

export interface CastMetrics {
  /** Share of layers produced by a library technique rather than hand-authored. */
  techniqueCoverage: number;
  /** Distinct techniques ÷ total instances. High is good. */
  techniqueDiversity: number;
  /** Distinct layout templates ÷ total beats. */
  templateDiversity: number;
  /** Spread of variant seeds — catches "always variant 0". */
  variantEntropy: number;
}
