/**
 * @motion/animation — the framework-independent Animation Engine.
 *
 * Holds keyframe property tracks and expressions keyed by (nodeId, prop) and
 * samples them at a time to produce values the renderer merges over the scene's
 * base state. No React, no DOM, no app spine — the host binds a change listener
 * (setChangeListener) to surface mutations onto its own event bus.
 */

// ── Data models ───────────────────────────────────────────────────
export type {
  PropPath,
  EasingKind,
  BezierHandles,
  Keyframe,
  PropertyTrack,
  SceneValueSnapshot,
} from './types';

// ── Interpolation / sampling ──────────────────────────────────────
export { cubicBezierEase, ease, sampleTrack, upsertKeyframe } from './interpolate';

// ── Expressions ───────────────────────────────────────────────────
export {
  compileExpression,
  suggestExpression,
  tokenizeExpression,
  matchBracket,
  EXPRESSION_API,
} from './expressions';
export type {
  ExprContext,
  ExprResult,
  CompiledExpression,
  TokenKind,
  SyntaxToken,
} from './expressions';

// ── Keyframe ids (timeline ↔ engine reference encoding) ───────────
export { makeKeyframeId, parseKeyframeId } from './keyframeId';
export type { KeyframeRefParts } from './keyframeId';

// ── Engine ────────────────────────────────────────────────────────
export { AnimationEngine, defaultAnimation } from './AnimationEngine';
export type { AnimSnapshot, AnimationChangeListener } from './AnimationEngine';
