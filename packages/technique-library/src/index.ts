/**
 * @motion/technique-library — hand-authored motion craft.
 *
 * The LLM casts (id + params + seed); this emits. That inversion is the whole
 * architecture: the quality floor stops being stochastic and starts being
 * deterministic, which is why running the caster on a weak model and still
 * passing the timing linter is the project's key acceptance test.
 *
 * Pure. Emits `ToolCall[]`, executes nothing, never calls `Math.random`.
 */

export {
  CRAFT_MARKERS,
  coerceParams,
  type AnimatableRole,
  type Antipatterns,
  type CoerceResult,
  type CraftMarker,
  type EmitContext,
  type ParamSpec,
  type ResolvedPackLike,
  type TechniqueCategory,
  type TechniqueDef,
} from './schema';

export {
  BLUR_VELOCITY_THRESHOLD_PX_PER_SEC,
  CURVES,
  PROPERTY_LEAD_FRAMES,
  blurIfFast,
  compositionShutter,
  fadeIn,
  fadeOut,
  followThrough,
  heroMove,
  hold,
  offsetFor,
  rolesTargets,
  sec,
  staggerAt,
  subFrame,
  track,
  travel,
  type CurveName,
  type Key,
} from './emit';

export {
  TECHNIQUES,
  atCap,
  briefFor,
  candidates,
  clashesWith,
  technique,
  techniqueIds,
  techniquesForPack,
  packPermits,
  resourceTakenBy,
  validateRequirements,
  type Candidate,
  type CastQuery,
} from './registry';

export {
  craftScore,
  formatTimingFindings,
  lintTiming,
  tracksFromCalls,
  type Severity,
  type TimingFinding,
  type TimingLintScene,
  type TimingRule,
} from './lint';
