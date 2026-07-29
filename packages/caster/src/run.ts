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
  const brief = await o.hooks.brief(briefPrompt(packs), o.userPrompt);

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

  // ── 5. Emit, lint, repair ───────────────────────────────────────────────
  const { calls, report } = emitAndValidate({
    sequence: seq,
    casting,
    lookPackId: brief.lookPackId,
    ...(brief.accent ? { accent: brief.accent } : {}),
    ...(brief.mode ? { mode: brief.mode } : {}),
    width: o.width,
    height: o.height,
    fps: o.fps,
  });

  return {
    brief,
    calls,
    report,
    problems: { sequence: sequenceProblems, casting: castingProblems },
  };
}
