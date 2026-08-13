/**
 * @motion/caster — the pipeline.
 *
 * ```
 * prompt
 *   ├─▶ [LLM 1] CREATIVE BRIEF     briefPrompt()
 *   ├─▶ [code]  SEQUENCER          sequence() + validate()
 *   ├─▶ [LLM 2] CAST LAYOUT        layoutCastPrompts()
 *   ├─▶ [LLM 2] CAST MOTION        motionCastPrompts()
 *   ├─▶ [code]  VALIDATE CASTING   validateCasting()
 *   ├─▶ [code]  EMIT + LINT        emitAndValidate()
 *   ├─▶ [host]  EXECUTE            unchanged, inside aiTransaction
 *   └─▶ [LLM 3] FIT CRITIC         fitCriticPrompt()   (optional, 1 iteration)
 * ```
 *
 * Three LLM calls, down from roughly thirty, and none of them authors a keyframe.
 * The model decides what and why; the libraries decide how.
 *
 * Pure: builds prompts, validates responses, emits `ToolCall[]`. Makes no network
 * calls and touches no document — the host executes the result inside the existing
 * `aiTransaction`, so one prompt is still one undo entry.
 */

export {
  MIN_BEAT_MS,
  availableRolesFor,
  sequence,
  survivalBetween,
  tagsForPurpose,
  validate,
  type SequenceOptions,
  type SequenceProblem,
} from './sequencer';

export {
  briefPrompt,
  fitCriticPrompt,
  layoutCastPrompts,
  motionCastPrompts,
  motionCastScope,
  validateCasting,
  type CastProblem,
  type LayoutCastPrompt,
  type MotionCastPrompt,
  type ValidatedCasting,
} from './cast';

export { emitAndValidate, sceneFromCalls, type EmitOptions } from './emit';

export { GENERATED_MEDIA } from './types';

export type {
  Beat,
  BriefBeat,
  CastMetrics,
  CastReport,
  CastResult,
  Casting,
  CreativeBrief,
  LayoutCast,
  MotionCast,
  Sequence,
  Survival,
  SurvivalKind,
} from './types';

export {
  runCaster,
  type CasterHooks,
  type CasterVariant,
  type Direction,
  type RunCasterOptions,
  type RunCasterResult,
} from './run';
