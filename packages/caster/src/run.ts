/**
 * The orchestrator.
 *
 * Threads the pipeline together and takes the two LLM stages as **injected
 * functions** rather than calling anything itself. That keeps this package pure —
 * the same purity contract as `@motion/ai-tools` — and it is also what makes the
 * key acceptance test possible: swapping in a weak model, or a stub that returns
 * nonsense, and checking that the output still passes every linter.
 *
 * If it does, craft lives in the libraries rather than in the model, which is the
 * entire thesis.
 */

import type { CreativeBrief, CastReport, Casting } from './types';

import { sequence, validate, type SequenceProblem } from './sequencer';
import { layoutCastPrompts, motionCastPrompts, validateCasting, type CastProblem } from './cast';
import { emitAndValidate } from './emit';
import type { ToolCall } from '@motion/design-system';

/** The two model-facing hooks. Both are injected; neither is called here. */
export interface CasterHooks {
  /** LLM 1 — returns the creative brief. */
  brief(prompt: string, userPrompt: string): Promise<CreativeBrief>;
  /**
   * LLM 2 — returns one cast per beat, given the per-beat prompts.
   *
   * Layout and motion are separate calls in the same round trip if the host wants,
   * but they are separate *decisions*: motion animates a design, so the layout is
   * cast first and the motion prompt is built against the roles that layout
   * actually produced.
   */
  cast(prompts: readonly { beatIndex: number; prompt: string }[], kind: 'layout' | 'motion'): Promise<
    readonly { beatIndex: number; id: string; params?: Record<string, unknown>; seed?: number }[]
  >;
}

export interface RunCasterOptions {
  userPrompt: string;
  hooks: CasterHooks;
  width: number;
  height: number;
  fps: number;
  /** The packs the brief may choose from. Defaults to all of them. */
  packs?: readonly { id: string; intent: string; vocabulary: string }[];
  /**
   * Direction the user supplied, which overrides what the model chose.
   *
   * The brief call still runs — it is what turns a sentence into beats and
   * content, and nothing else can do that. But when the person typing has
   * already decided the look, asking the model to guess it and then ignoring the
   * guess is the honest description of what should happen.
   */
  direction?: Direction;
  /**
   * How many alternative emits to produce, ≥1.
   *
   * The expensive half of a run is the three model calls; emit is pure and
   * deterministic given a seed. So N directions cost one cast plus N cheap
   * re-emits, which is why "generate three and pick one" is affordable here and
   * would not be if the model authored the keyframes.
   */
  variants?: number;
}

/** User-supplied overrides on the creative brief. */
export interface Direction {
  lookPackId?: string;
  accent?: string;
  mode?: 'dark' | 'light';
  energy?: number;
  totalDurationMs?: number;
}

/** One emitted alternative. */
export interface CasterVariant {
  /** 0-based. Variant 0 is the casting exactly as validated. */
  index: number;
  /** The seed offset that produced it, for reproducing a chosen variant. */
  seed: number;
  calls: readonly ToolCall[];
  report: CastReport;
}

export interface RunCasterResult {
  brief: CreativeBrief;
  calls: readonly ToolCall[];
  report: CastReport;
  /** Everything that was rejected or repaired, for the user-facing log. */
  problems: {
    sequence: readonly SequenceProblem[];
    casting: readonly CastProblem[];
  };
  /**
   * Every alternative, best-scoring first. Always at least one, and
   * `variants[0]` is the same content as `calls`/`report`.
   */
  variants: readonly CasterVariant[];
}

/**
 * Run the whole pipeline.
 *
 * Note what happens to a bad response at every stage: it is **corrected, not
 * re-requested**. A sequence with a bare boundary is reported; an invalid cast
 * falls back to the top-ranked valid candidate; a linter error triggers a
 * deterministic re-emit. Nothing loops back to a model, because at every one of
 * those points the constraint was already in the prompt and a sort or an
 * arithmetic fix decides it better than a retry would.
 */
export async function runCaster(o: RunCasterOptions): Promise<RunCasterResult> {
  // ── 1. Brief ────────────────────────────────────────────────────────────
  const { briefPrompt } = await import('./cast');
  const { LOOK_PACKS } = await import('@motion/design-system');
  const packs = LOOK_PACKS;
  const modelBrief = await o.hooks.brief(briefPrompt(packs), o.userPrompt);

  // The user's direction wins over the model's. Applied HERE rather than after
  // the sequencer so every downstream stage — candidate filtering, energy bands,
  // beat budgets — sees the values that will actually be used. Overriding later
  // would leave the cast prompts describing a pack the piece is not in.
  const d = o.direction;
  const brief: CreativeBrief = !d
    ? modelBrief
    : {
        ...modelBrief,
        ...(d.lookPackId ? { lookPackId: d.lookPackId } : {}),
        ...(d.accent ? { accent: d.accent } : {}),
        ...(d.mode ? { mode: d.mode } : {}),
        ...(typeof d.energy === 'number' ? { energy: Math.max(0, Math.min(1, d.energy)) } : {}),
        ...(typeof d.totalDurationMs === 'number' && d.totalDurationMs > 0
          ? { totalDurationMs: d.totalDurationMs }
          : {}),
      };

  // ── 2. Sequencer ────────────────────────────────────────────────────────
  const seq = sequence(brief);
  const sequenceProblems = validate(seq);

  // ── 3. Cast layout, THEN motion ─────────────────────────────────────────
  // Order is load-bearing: the motion prompt names the roles the layout produced,
  // so casting motion is a constrained match rather than free invention.
  const layoutPrompts = layoutCastPrompts(seq, brief.lookPackId);
  const layoutPicks = await o.hooks.cast(layoutPrompts, 'layout');

  const motionPrompts = motionCastPrompts(seq, brief.lookPackId, brief.energy);
  const motionPicks = await o.hooks.cast(motionPrompts, 'motion');

  const proposed: Casting = {
    layouts: layoutPicks.map((p) => ({
      beatIndex: p.beatIndex,
      templateId: p.id,
      seed: p.seed ?? 0,
    })),
    motion: motionPicks.map((p) => ({
      beatIndex: p.beatIndex,
      techniqueId: p.id,
      params: p.params ?? {},
      seed: p.seed ?? 0,
    })),
  };

  // ── 4. Validate + repair the casting ────────────────────────────────────
  const { casting, problems: castingProblems } = validateCasting(
    seq,
    brief.lookPackId,
    brief.energy,
    proposed,
  );

  // ── 5. Emit, lint, repair — once per variant ────────────────────────────
  // Re-seeding the casting rather than re-casting is what makes this cheap: the
  // model already decided which layout and which technique each beat gets, and
  // the seed selects among the variants the LIBRARY authored for that choice. So
  // three directions cost three pure function calls, not three more model turns,
  // and every one of them is held to the same linters.
  const count = Math.max(1, Math.trunc(o.variants ?? 1));
  const base = {
    lookPackId: brief.lookPackId,
    ...(brief.accent ? { accent: brief.accent } : {}),
    ...(brief.mode ? { mode: brief.mode } : {}),
    width: o.width,
    height: o.height,
    fps: o.fps,
  };

  const variants: CasterVariant[] = [];
  for (let i = 0; i < count; i++) {
    // Variant 0 is the casting exactly as validated, so a single-variant run is
    // byte-identical to what it produced before this existed. Later variants
    // shift every seed by a prime multiple of the index — a flat `+i` would make
    // variant 1 of beat 0 identical to variant 0 of beat 1, and the piece would
    // look reshuffled rather than redesigned.
    const shifted: Casting = i === 0 ? casting : {
      layouts: casting.layouts.map((l) => ({ ...l, seed: l.seed + i * 17 })),
      motion: casting.motion.map((m) => ({ ...m, seed: m.seed + i * 23 })),
    };
    const { calls, report } = emitAndValidate({ sequence: seq, casting: shifted, ...base });
    variants.push({ index: i, seed: i, calls, report });
  }

  // Best first, by the linters' own weighting. A variant is only offered because
  // a person will choose between them by eye, but ordering by score means the
  // one shown first is never the one with a contrast failure in it.
  const ranked = [...variants].sort(
    (a, b) =>
      (b.report.designScore + b.report.craftScore + b.report.uiMotionScore) -
      (a.report.designScore + a.report.craftScore + a.report.uiMotionScore),
  );

  const best = ranked[0]!;
  return {
    brief,
    calls: best.calls,
    report: best.report,
    problems: { sequence: sequenceProblems, casting: castingProblems },
    variants: ranked,
  };
}
