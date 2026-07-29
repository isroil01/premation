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
export {
  cubicBezierEase, ease, sampleTrack, upsertKeyframe,
  sampleSpeed, applyRoving,
  cubicValueAt, smoothTrackTangents, clearTrackTangents,
  EASY_EASE_BEZIER, EASY_EASE_OUT_BEZIER, EASY_EASE_IN_BEZIER,
} from './interpolate';

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
  LoopMode,
} from './expressions';

// The raw parser/evaluator, for callers that need their own scope rather than
// the property-expression one (text expression SELECTORS see `textIndex` /
// `textTotal` / `selectorValue`, which `compileExpression` knows nothing
// about). Interpreted, never eval'd — the app's CSP refuses `new Function`.
export { parseExpression, evaluateExpression, ExprSyntaxError, ExprRuntimeError } from './exprLang';
export type { ExprNode } from './exprLang';

// ── Keyframe ids (timeline ↔ engine reference encoding) ───────────
export { makeKeyframeId, parseKeyframeId, expandKeyframeProp, POSITION_PSEUDO_PROP } from './keyframeId';
export type { KeyframeRefParts } from './keyframeId';

export {
  sampleDataTrack, upsertDataKeyframe, setDataKeyframeEasing, cloneDataValue, growOutline,
  dataPathTangents, setDataSpatialTangent, clearDataSpatialTangents,
  hasDataSpatialTangents, smoothDataSpatialTangents,
} from './dataTracks';
export type {
  DataKind, DataTrack, DataValue, DataKeyframe, DataPoint, GradientStop, DataPathTangents,
} from './dataTracks';

export { lottieBezierToPoints, pointsToLottieBezier, lottiePathKeyframes } from './lottiePath';
export type { LottieBezier, LottieShapeProp } from './lottiePath';

// ── Engine ────────────────────────────────────────────────────────
export { AnimationEngine, defaultAnimation } from './AnimationEngine';
export type {
  AnimSnapshot,
  AnimationChangeListener,
  AudioLevelProvider,
  ControlProvider,
  LayerResolver,
  BaseValueProvider,
} from './AnimationEngine';
