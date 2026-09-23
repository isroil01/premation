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
  SpatialInterp,
} from './types';

// ── Interpolation / sampling ──────────────────────────────────────
export {
  cubicBezierEase, ease, sampleTrack, upsertKeyframe,
  sampleSpeed, applyRoving, applyRovingSpatial,
  cubicValueAt, smoothTrackTangents, clearTrackTangents,
  autoSpatialTangents, effectiveSpatialTangents,
  EASY_EASE_BEZIER, EASY_EASE_OUT_BEZIER, EASY_EASE_IN_BEZIER,
} from './interpolate';

// ── Expressions ───────────────────────────────────────────────────
export {
  compileExpression,
  suggestExpression,
  tokenizeExpression,
  matchBracket,
  EXPRESSION_API,
  // The host's hook for `plugin.<namespace>.<fn>()` — see `expressions.ts`.
  setPluginExpressionScope,
} from './expressions';
export type {
  ExprContext,
  ExprResult,
  CompiledExpression,
  TokenKind,
  SyntaxToken,
  LoopMode,
  LayerSpace,
  SourceRect,
  ExprMarker,
  ExprMarkerData,
} from './expressions';

// ── Source Text expressions (AE `text.sourceText` + the AE 25 style API) ──
export {
  SOURCE_TEXT_PROP,
  MAX_SOURCE_TEXT_LENGTH,
  MAX_RANGE_OVERRIDES,
  makeSourceTextValue,
  coerceSourceTextResult,
  resolveSourceTextStyle,
  sampleAfterResult,
  cssToRgb01,
  rgb01ToCss,
  splitSourceGraphemes,
} from './sourceText';
export type {
  SourceTextStyle,
  SourceTextRun,
  SourceTextRunStyle,
  SourceTextSample,
  SourceTextStyleOverrides,
  SourceTextRangeKey,
  SourceTextRangeOverride,
  SourceTextExpressionResult,
} from './sourceText';

// The raw parser/evaluator, for callers that need their own scope rather than
// the property-expression one (text expression SELECTORS see `textIndex` /
// `textTotal` / `selectorValue`, which `compileExpression` knows nothing
// about). Interpreted, never eval'd — the app's CSP refuses `new Function`.
export { parseExpression, evaluateExpression, ExprSyntaxError, ExprRuntimeError } from './exprLang';
export { LAYER_ID_PREFIX, isLayerIdRef, resolveLayerRef, layerIdRef } from './AnimationEngine';
export { mapLayerNameRefs, layerNameRefsIn } from './layerNameRefs';
export type { ExprNode } from './exprLang';

// ── Keyframe ids (timeline ↔ engine reference encoding) ───────────
export { makeKeyframeId, parseKeyframeId, expandKeyframeProp, POSITION_PSEUDO_PROP, stableKeyframeId, stableKeyframeIdSeq } from './keyframeId';
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
  NodeAnimSnapshot,
  ExpressionState,
  AnimationChangeListener,
  AudioLevelProvider,
  ControlProvider,
  LayerResolver,
  BaseValueProvider,
  MarkerProvider,
  SourceTextProvider,
} from './AnimationEngine';
