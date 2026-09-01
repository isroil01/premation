/**
 * SnapshotBuilder — projects (SceneGraph + animated values @ time) into an
 * immutable RenderSnapshot (TAD §6.4.3). Pure: reads only, mutates nothing.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import { renderComponentsOf, renderTransformOf } from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { flattenComposition, readNodeKind, KIND_FILL } from '@core/scene/sceneDerive';
import { readNodeRenderEffects, effectsToFilter, resolveEffectParams, paramsOf, type Effect } from '@core/effects/effects';
import { readNodeLayerStyles, layerStylesToEffects, layerStyleEffectId, styledSurfaceFill } from '@core/effects/layerStyles';

/** Prop-path prefix every layer-style keyframe track shares —
 *  `effect.layerstyle:<style>.<param>`. Derived, so it cannot drift from
 *  `layerStyleEffectId`. */
const LAYER_STYLE_TRACK_PREFIX = `effect.${layerStyleEffectId('dropShadow')}`.replace(/dropShadow$/, '');
import { resolveGlass } from '@core/effects/glassResolve';
import { resolveGlobalLight } from '@stores/projectStore';
import { readNodeBlend } from '@core/effects/blendMode';
import { readNodePreserveTransparency } from '@core/effects/preserveTransparency';
import { readNodeMaskAt, roundedRectMask, applyMaskPropertyTracks, type LayerMask } from '@core/effects/mask';
import {
  clampCornerRadii,
  hasIndependentCornerRadii,
  resolveCornerRadii,
  type CornerRadiiTuple,
} from '@core/scene/cornerRadii';
import { readNodeMatte, readMatte } from '@core/effects/matte';
import { readNodeAdjustment } from '@core/effects/adjustment';
import { readNodeMotionBlur, motionBlurSampleTimes, adaptiveMotionBlurSamples, type MotionBlurConfig } from '@core/effects/motionBlur';
import { readNodeFill, readNodeFills, sampleFillAt, type FillPaint } from '@core/paint/fill';
import { readNodeStroke, readNodeRenderStrokes } from '@core/paint/stroke';
import { useAssetStore } from '@stores/assetStore';
import { localMatrix, worldTransformOf, worldMatrixOf, localUnderParent, type LocalOf, type ParentOf } from '@core/scene/worldTransform';
import { parentWorld3d, resolveNode3DTransform } from '@core/scene/nodeMatrix';
import { readIsGuideLayer } from '@core/scene/guideLayer';
import { readNodeLayerTime, remapTime } from '@core/scene/layerTime';
import { readNode3D, is3DEnabled, isPerChar3D } from '@core/scene/threeD';
import { isAutoOrientedToCamera, readNodeAutoOrient } from '@core/scene/autoOrient';
import { autoOrientAngleDeg } from '@core/motion/motionPath';

import { nearestPrecompRoot, precompAncestorChain, isPrecomp } from '@core/scene/precomp';
import { readNodeAnchor } from '@core/scene/anchor';
import { readNodeLight, lightAttenuationAt, lightReach } from '@core/scene/light';
import { readNodeParticle, resolveParticleConfig } from '@core/particles/particleSim';
import { measureTextNodeSize, readMeasuredTextStyle } from '@core/text/measureText';
import { readGeometry } from '@core/workspace/geometry';
import { readGhostSpec } from '@core/effects/temporalGhosts';
import { readForceMotionBlur } from '@core/effects/forceMotionBlur';
import { readPosterizeTimeFps } from '@core/effects/posterizeTime';
import { readNodeQuality } from '@core/effects/layerQuality';
import { resolveAudioSpectrum } from '@core/audio/audioSpectrum';
import { readNodeMaterial } from '@core/scene/material';
import { extrusionGeometry, EXTRUSION_WALL_FALLBACK_FILL, GRADIENT_WALL_SEGMENTS, EXTRUSION_SLICE_STEP_PX, MAX_EXTRUSION_SLICES } from '@core/scene/extrusion';
import { extrusionOutlineFor, extrusionMeshFor } from '@core/scene/extrusionMesh';
import { isColorEffect } from '@core/effects/effectColorMatrix';
import { readNodeFaceMaterials, resolveFaceMaterial, faceKindOf } from '@core/scene/faceMaterials';
import { faceEffectsFor } from '@core/scene/faceEffects';
import { shadeLayer, planeNormalOf, toShaderLights, lightAim3D, type SceneLight } from '@core/scene/lightShading';
import { readNodePaint } from '@core/paint/paintStrokes';
import { contentAwareFillAt } from '@core/effects/contentAwareFillVideo';
import { resolvePathOps, applyPathOpChain, shapeOutline, type PolyRun } from '@core/scene/pathOps';
import { corner } from '../../../packages/workspace/src/math/BezierPoint';
import { resolveAnimators, evaluateTextAnimators } from '@core/text/textAnimators';
import { layoutPerChar3D } from '@core/text/perChar3D';
import type { ParagraphStyle } from '@core/text/textLayout';
import { readRuns, normalizeRuns } from '@core/text/richText';
import { resolveTextPath, resolveTextPathMask, flattenMaskPath } from '@core/text/textPath';
import { bracketFrames } from './videoFrameCache';
import { footageSourceOf, applyLoop } from '@core/source/sourceInfo';
import { slotFitOf, coverUvRect } from '@core/template/mediaSlots';
import { readSceneCamera, readSceneDof, dofBlurPx, dofIrisParams, activeCameraNode, cameraFromNode } from '@core/scene/camera3d';
import { planDofCocCorners, layerCornerDepths } from './dofStrips';
import { expandCompInstances, instanceSourceOf, isCompInstanceRoot, readCompRef, readCompCollapse } from '@core/scene/compInstance';
import { applyOverridesToComponents, overriddenPropsFor, readCompOverrides, type OverrideValue } from '@core/scene/compInstanceOverrides';
import { expandCloners, cloneOffsetOf } from '@core/scene/clonerExpand';
import { readNodePhysics, physicsPosesAt } from '@core/simulation/physicsBodies';
import type { BodySeed } from '@core/simulation/rigidBody';
import { usePhysicsStore } from '@stores/physicsStore';
import { readLiveBoolean, evaluateLiveBoolean, isBooleanOperand, nodeWorldOutline, flattenOutline, ADAPTIVE } from '@core/scene/mergePaths';
import { readContinuousRaster, supportsContinuousRaster } from '@core/scene/continuousRaster';
import { readNodeCornerPin } from '@core/scene/cornerPin';
import type { PropPath } from '@motion/animation';
import { Project3D, Matrix4Math, Matrix, type Matrix2D, type Matrix4 } from '@motion/scene';
import { Color } from '@motion/renderer';

import { getTimelineController } from '@core/timeline/TimelineController';

const DEG = Math.PI / 180;
import type { MotionSample } from './RenderBackend';
import type { AnimationEngine } from '@motion/animation';
import type { RenderSnapshot, RenderLayer, LayerKind, SubpathPaint } from './RenderBackend';
import { contentHashOf } from './contentHash';
import { rasterPadding } from './raster/vectorDraw';
import { readNodePuppet, getCachedRestMesh, deform, silhouetteFromPathPoints, resolvePuppetSilhouette, overlapDepthField, sortTrianglesByDepth } from '../rig/puppet';
import { resolveLivePins } from '../rig/livePins';
import { resolveActiveIkTargets } from '../rig/liveIkTargets';
import { readNodeAudioWaveform, resolveAudioWaveformPoints } from '@core/audio/audioWaveformGen';
import { readNodeSkeleton } from '../rig/skeletonCommands';
import { computeWorldTransforms, type Bone } from '../rig/skeleton';
import { resolveLiveBones } from '../rig/liveBones';
import { applyIk, getSkeletonBinding, skinRigVertices, type IkTargetResolved } from '../rig/rigDeform';
import { rigCoverageMask, resolveRigImageSrc } from '../rig/rigMeshInputs';
import { readSvgLayer } from '../svg/svgLayer';

const COMP_WIDTH = 1920;
const COMP_HEIGHT = 1080;
const COMP_BG = '#101014';

/** Comp-level render inputs. When omitted, the hardcoded defaults are used so
 *  headless callers (export presets, tests) keep working unchanged. */
export interface SnapshotComp {
  width: number;
  height: number;
  background: string;
  /** Composition GLOBAL LIGHT — the direction layer styles bound to it use.
   *  Optional: absent on older documents, resolved to a default at read. */
  globalLightAngle?: number;
  globalLightAltitude?: number;
  /** Rich background paint (gradient). When set, the Canvas2D backend paints
   *  this over the flat `background`. Undefined = plain solid `background`. */
  backgroundPaint?: FillPaint;
  transparent?: boolean;
  /**
   * This frame is being built for DELIVERY, not for the editor — so guide
   * layers are dropped from it.
   *
   * Carried on the comp rather than on `RenderView` or as its own parameter,
   * and the reason is nested compositions. `buildSnapshot` recurses for a comp
   * instance and spreads `{...comp}` into that call while deliberately passing
   * `view` and `overlays` as `undefined` (a nested comp renders at its own size
   * with none of the editor's chrome). A purpose flag on the view would
   * therefore be LOST one level down, and a guide layer inside a precomp would
   * render into an export — the exact bug this flag exists to prevent, hidden
   * one level deeper than anyone would look. Riding on `comp` means the
   * propagation is the existing spread rather than a line someone must
   * remember to add.
   *
   * Set in exactly one place per export path, and every export path builds its
   * geometry through `exportView` — so if you are adding a fifth, set this too.
   */
  forExport?: boolean;
  camera3dMode?: 'active' | Project3D.OrthoView;
  /**
   * View-camera override (AE custom views): when set (and the mode is not an
   * ortho view), 3D layers project through THIS pre-built camera instead of
   * the scene's Camera layer, and DOF is off (like ortho — you're inspecting,
   * not shooting). The editor builds it from stored view params; export and
   * headless paths never set it, so their output is untouched.
   */
  customViewCamera?: Project3D.Camera3D;
  /**
   * Draft 3D (AE's lightning bolt): skip depth-of-field blur and all lighting
   * (light washes, Lambert shading, cast shadows) for a fast interactive
   * preview. Pure input gate — projection/transforms are untouched. Absent =
   * full quality (export/tests unchanged).
   */
  draft3d?: boolean;
  /**
   * Decode low-resolution PROXIES instead of the original media.
   *
   * Absent/false = full resolution, and that polarity is deliberate: export,
   * the offline renderer and the render-test harness never set it, so no output
   * path can reach a proxy by forgetting to opt out. Only the interactive
   * viewport passes it, from the global Use Proxies preference. Substitution is
   * PIXELS ONLY — duration, fps, PAR, alpha and loop still come from the
   * original asset, so timing cannot drift. See `@core/assets/proxy`.
   */
  useProxies?: boolean;
  /** Comp length in seconds — used to clamp the layer in/out gate frame. */
  durationSeconds?: number;
  /**
   * The scene node this composition is rooted at.
   *
   * Compositions live as separate root subtrees in one scene graph, so without
   * this the renderer walks EVERY root and draws all comps on top of each
   * other. Absent = the whole scene (single-comp projects, tests).
   */
  rootId?: string;
  /**
   * The pixel dimensions of ANOTHER composition, by its root id.
   *
   * A composition placed as a layer has to render at ITS OWN size, not the
   * host's — that is what makes a 1080×1920 vertical cut of a 1920×1080 master
   * a portrait rectangle inside it rather than a landscape one. Comp sizes live
   * in the project store, which the renderer must not import (it has to stay
   * callable from export, tests and the headless paths), so the caller injects
   * the lookup.
   *
   * Absent, or returning undefined, falls back to the host's size — the
   * behaviour before comp instances had a size of their own.
   */
  compSizeOf?: (compRootId: string) => { width: number; height: number } | undefined;
  /**
   * INTERNAL — the chain of composition roots currently being rendered.
   *
   * A sealed comp instance is rendered by a recursive `buildSnapshot` call, so
   * this is what stops A-inside-B-inside-A from recursing forever, and what caps
   * absurd nesting. Set by the renderer itself; callers never pass it.
   */
  compStack?: readonly string[];
  /**
   * INTERNAL — Essential Properties handed down by the comp instance whose
   * recursive pass this is (see `compInstanceOverrides.ts`). Keyed by the
   * referenced comp's OWN node ids, because this pass walks the real nodes
   * rather than clones. Set by the renderer itself; callers never pass it.
   */
  compOverrides?: ReadonlyMap<string, OverrideValue>;
}

/** Nesting cap for recursive composition rendering. */
const MAX_COMP_DEPTH = 8;

/**
 * Re-key a nested composition's layers under the instance that placed them.
 *
 * The same composition can be placed many times, and the recursive pass renders
 * the SAME source nodes each time — so without this both placements emit layers
 * with identical ids. Ids are not cosmetic here: they are offscreen texture keys
 * (`precomp:<id>`) and track-matte source references, so a collision makes two
 * instances share one texture and matte off each other's layers.
 */
function prefixLayerIds(layers: ReadonlyArray<RenderLayer>, prefix: string): RenderLayer[] {
  return layers.map((l) => ({
    ...l,
    id: `${prefix}${l.id}`,
    ...(l.matteSourceId ? { matteSourceId: `${prefix}${l.matteSourceId}` } : {}),
    ...(l.precompLayers ? { precompLayers: prefixLayerIds(l.precompLayers, prefix) } : {}),
  }));
}

export const DEFAULT_COMP: SnapshotComp = { width: COMP_WIDTH, height: COMP_HEIGHT, background: COMP_BG };

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Read base (authoring) props off a node's components. */
function readBase(node: SceneNode): {
  x: number; y: number; rotation: number; opacity: number;
  scaleX: number; scaleY: number;
  width?: number; height?: number;
  cornerRadius?: number;
  cornerRadiusTL?: number;
  cornerRadiusTR?: number;
  cornerRadiusBR?: number;
  cornerRadiusBL?: number;
  backdropBlur?: number;
  fill?: string; text?: string; fontSize: number;
  fontFamily?: string; fontWeight?: string; fontStyle?: string;
  /** Variable-font wdth axis. */
  fontWidth?: number;
  /** Variable-font slnt axis. */
  fontSlant?: number;
  letterSpacing?: number; lineHeight?: number; align?: string;
  paragraphSpacing?: number;
  strokeOverFill?: boolean;
  src?: string; assetId?: string; color?: string;
} {
  let x: number | undefined;
  let y: number | undefined;
  let rotation: number | undefined;
  let opacity = 100;
  let scaleX: number | undefined;
  let scaleY: number | undefined;
  let scale: number | undefined;
  let fill: string | undefined;
  let text: string | undefined;
  let fontSize = 48;
  let fontFamily: string | undefined;
  let fontWeight: string | undefined;
  let fontWidth: number | undefined;
  let fontSlant: number | undefined;
  let fontStyle: string | undefined;
  let letterSpacing: number | undefined;
  let lineHeight: number | undefined;
  let align: string | undefined;
  let paragraphSpacing: number | undefined;
  let strokeOverFill: boolean | undefined;
  let src: string | undefined;
  let assetId: string | undefined;
  let color: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let cornerRadius: number | undefined;
  let cornerRadiusTL: number | undefined;
  let cornerRadiusTR: number | undefined;
  let cornerRadiusBR: number | undefined;
  let cornerRadiusBL: number | undefined;
  let backdropBlur: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    x = num(p.x) ?? x;
    y = num(p.y) ?? y;
    rotation = num(p.rotation) ?? rotation;
    opacity = num(p.opacity) ?? opacity;
    scaleX = num(p.scaleX) ?? scaleX;
    scaleY = num(p.scaleY) ?? scaleY;
    scale = num(p.scale) ?? scale;
    fontSize = num(p.fontSize) ?? fontSize;
    if (typeof p.fill === 'string') fill = p.fill;
    if (typeof p.content === 'string') text = p.content;
    if (typeof p.fontFamily === 'string') fontFamily = p.fontFamily;
    if (typeof p.fontWeight === 'string') fontWeight = p.fontWeight;
    else if (typeof p.fontWeight === 'number') fontWeight = String(p.fontWeight);
    if (typeof p.fontWidth === 'number') fontWidth = p.fontWidth;
    if (typeof p.fontSlant === 'number') fontSlant = p.fontSlant;
    if (typeof p.fontStyle === 'string') fontStyle = p.fontStyle;
    letterSpacing = num(p.letterSpacing) ?? letterSpacing;
    lineHeight = num(p.lineHeight) ?? lineHeight;
    if (typeof p.align === 'string') align = p.align;
    paragraphSpacing = num(p.paragraphSpacing) ?? paragraphSpacing;
    if (typeof p.strokeOverFill === 'boolean') strokeOverFill = p.strokeOverFill;
    if (typeof p.src === 'string') src = p.src;
    if (typeof p.assetId === 'string') assetId = p.assetId;
    if (typeof p.color === 'string') color = p.color;
    width = num(p.width) ?? width;
    height = num(p.height) ?? height;
    if (num(p.cornerRadius) !== undefined) cornerRadius = num(p.cornerRadius);
    if (num(p.cornerRadiusTL) !== undefined) cornerRadiusTL = num(p.cornerRadiusTL);
    if (num(p.cornerRadiusTR) !== undefined) cornerRadiusTR = num(p.cornerRadiusTR);
    if (num(p.cornerRadiusBR) !== undefined) cornerRadiusBR = num(p.cornerRadiusBR);
    if (num(p.cornerRadiusBL) !== undefined) cornerRadiusBL = num(p.cornerRadiusBL);
    if (num(p.backdropBlur) !== undefined) backdropBlur = num(p.backdropBlur);
  }
  return {
    x: x ?? node.transform.position.x,
    y: y ?? node.transform.position.y,
    rotation: rotation ?? node.transform.rotation,
    opacity: opacity / 100,
    scaleX: scaleX ?? scale ?? 1,
    scaleY: scaleY ?? scale ?? 1,
    width,
    height,
    cornerRadius,
    cornerRadiusTL,
    cornerRadiusTR,
    cornerRadiusBR,
    cornerRadiusBL,
    backdropBlur,
    fill,
    text,
    fontSize,
    fontFamily,
    fontWeight,
    fontWidth,
    fontSlant,
    fontStyle,
    letterSpacing,
    lineHeight,
    align,
    paragraphSpacing,
    strokeOverFill,
    src,
    assetId,
    color,
  };
}

/** Fixed on-canvas size per layer kind (comp px). Shared with the Workspace
 *  interaction engine so hit-testing/selection overlays match what's drawn. */
export const SIZE: Record<LayerKind, { w: number; h: number }> = {
  shape: { w: 220, h: 220 },
  text: { w: 320, h: 80 },
  image: { w: 280, h: 180 },
  video: { w: 480, h: 270 },
};

/**
 * Per-run paint for a chain's output, or null when no run needs any.
 *
 * ── Why this is all-or-nothing ─────────────────────────────────────────
 *
 * `subpathBatches` groups every UNPAINTED run into one batch and draws that
 * batch FIRST, then each painted run in order. So the moment one run carries
 * paint, an unpainted neighbour jumps to the front of the paint order. A
 * repeater fading its copies leaves copy 0 at exactly opacity 1 — and under
 * `composite: 'below'`, copy 0 is the one that must paint LAST. Giving it an
 * explicit `{ opacity: 1 }` costs nothing and keeps paint order equal to run
 * order, which is the only thing the ladder's ordering can rely on.
 *
 * Returning null when nothing needs paint is equally deliberate: without it,
 * every path-operator layer in every existing project would move onto the
 * batched draw path, where separately-filled runs can no longer cut holes in
 * each other.
 */
function runPaints(
  runs: ReadonlyArray<PolyRun>,
  layer: RenderLayer,
): Array<SubpathPaint | undefined> | null {
  const needs = runs.some((r) => (r.opacity ?? 1) !== 1 || (r.strokeScale ?? 1) !== 1);
  if (!needs) return null;
  // A single stroke override REPLACES the layer's whole stack (RenderBackend's
  // contract), so scaling is only expressible for a layer that has exactly one
  // stroke. A multi-stroke layer keeps its authored widths — logged in
  // COMPOSITING_PLAN rather than silently half-applied.
  const stack = layer.strokes && layer.strokes.length > 0 ? layer.strokes : layer.stroke ? [layer.stroke] : [];
  const soleStroke = stack.length === 1 ? stack[0]! : null;
  return runs.map((r) => {
    const opacity = r.opacity ?? 1;
    const ss = r.strokeScale ?? 1;
    const stroke =
      soleStroke && ss !== 1 ? { ...soleStroke, width: soleStroke.width * ss } : undefined;
    return stroke ? { opacity, stroke } : { opacity };
  });
}

/** First numeric value of `prop` across a node's components, or undefined. */
function readNumProp(node: SceneNode, prop: string): number | undefined {
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown>)[prop];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/** Opacity multiplier applied to layers that are ghosted in Focus Mode. */
const GHOST_OPACITY = 0.12;

export interface SnapshotFocus {
  /** Returns true when a node should render as a dim ghost reference. */
  isGhost: (nodeId: string) => boolean;
}

/**
 * Snapshot a node's fields into a PLAIN object for the duration of one frame.
 *
 * `SceneGraph` hands out `AppNodeView`s — live wrappers whose `components` is a
 * GETTER that reconstructs the whole `Component[]` from the engine every time it
 * is read, allocating a fresh object per component with all its props spread.
 * That is fine for an occasional read and ruinous here: instrumenting one
 * snapshot of a 1203-node scene counted **61,266 `components` reads — 50.9 per
 * node per frame** (readNodeKind, readBase, readNodeEffects, readNode3D,
 * readNodeAnchor, readNodeLayerStyles, the inline shapeType/solid/Geometry
 * lookups… each re-reads it), costing 81.7 ms of a 150 ms snapshot. Over half
 * the frame budget went to rebuilding the same arrays.
 *
 * Reading each field ONCE per frame collapses that to one rebuild per node.
 *
 * Deliberately a copy, not a cached getter on the view itself: callers all over
 * the app do `node.components.find(...).props.x = …`, which today writes into a
 * throwaway copy and is silently lost. Making the view cache its array would
 * quietly turn those no-ops into live mutations — a behaviour change nobody
 * asked for. This stays confined to the render path, which only ever READS.
 */
function materializeForFrame(n: SceneNode): SceneNode {
  return {
    id: n.id,
    name: n.name,
    parent: n.parent,
    children: n.children,
    // Memoized on the scene's mutation epoch, so across frames where nothing
    // changed these cost a counter compare instead of a full rebuild. Safe
    // ONLY because the snapshot below treats them as read-only — see
    // `SceneGraph.renderComponents`.
    transform: renderTransformOf(n),
    visible: n.visible,
    locked: n.locked,
    solo: n.solo,
    color: n.color,
    components: renderComponentsOf(n),
    // Comp-instance bookkeeping. This is an explicit field list, not a spread,
    // so anything not named here is DROPPED — and both of these are set on
    // render-only clones by `expandCompInstances`, after which every downstream
    // reader looks them up on the materialized node:
    //   • `__instanceSource` is the id-indirection that makes a clone sample the
    //     ORIGINAL node's keyframes. Losing it means `srcId` returns the
    //     prefixed id, which has no tracks at all — animation inside a placed
    //     composition simply does not play.
    //   • `__compInstanceRoot` stops the instance's transform composing into
    //     children that are already in the referenced comp's own space.
    ...(instanceSourceOf(n) !== null ? { __instanceSource: instanceSourceOf(n) } : {}),
    ...(isCompInstanceRoot(n) ? { __compInstanceRoot: true } : {}),
    //   • `__overriddenProps` is the Essential Properties set. It MUST be named
    //     here for the same reason as the two above: this list is a whitelist,
    //     and a dropped field turns the override into a value that patches the
    //     static prop and is then outvoted by the source's track every frame.
    ...(overriddenPropsOf(n) ? { __overriddenProps: overriddenPropsOf(n) } : {}),
  } as SceneNode;
}

/** The Essential Properties set attached to a clone by `expandCompInstances`. */
function overriddenPropsOf(n: SceneNode): ReadonlySet<string> | undefined {
  return (n as unknown as { __overriddenProps?: ReadonlySet<string> }).__overriddenProps;
}

export function buildSnapshot(
  graph: SceneGraph,
  rawAnim: AnimationEngine,
  t: number,
  focus?: SnapshotFocus,
  overlays?: import('./RenderBackend').RenderOverlays,
  view?: import('./RenderBackend').RenderView,
  motionBlur?: MotionBlurConfig,
  comp: SnapshotComp = DEFAULT_COMP,
): RenderSnapshot {
  const layers: RenderLayer[] = [];
  // One light direction for the whole frame — resolved once so every style in
  // it agrees, and so a document saved before global light existed still gets a
  // real angle rather than `undefined`.
  const globalLight = resolveGlobalLight(comp as { globalLightAngle?: number; globalLightAltitude?: number });

  // Solo (AE-style): when any node is soloed, only soloed nodes render.
  // Scoped to the active composition's root — other comps are separate subtrees.
  // Comp instances expand into render-only clones of their referenced comp's
  // subtree (routed through the precomp path); clones carry `__instanceSource`
  // so animation and clips sample the ORIGINAL nodes via `srcId` below.
  // Only COLLAPSED instances expand into this walk. A sealed one stays a bare
  // `comp` node and is rendered below by its own recursive pass, so that it
  // resolves ITS camera, its depth of field and its own 3D sort rather than
  // borrowing the host's.
  // Essential Properties on a SEALED instance. A collapsed instance expands
  // inline and its clones are patched by `expandCompInstances`; a sealed one is
  // rendered by the recursive pass below, over the referenced comp's REAL
  // nodes, where no clone exists to carry an override. So the owning instance
  // hands its overrides down through `comp.compOverrides` and they are applied
  // here — the same two halves (patch the Transform, mark the prop overridden),
  // just keyed by the node's own id rather than by `__instanceSource`.
  //
  // Without this, overrides worked on collapsed instances and silently did
  // nothing on sealed ones, which is the default. The test that caught it is
  // `overrides a KEYFRAMED property` in compInstanceOverrides.test.ts.
  const ownOverrides = comp.compOverrides;
  const applyOwnOverrides = (n: SceneNode): SceneNode => {
    if (!ownOverrides || ownOverrides.size === 0) return n;
    const ovProps = overriddenPropsFor(ownOverrides, n.id);
    if (!ovProps) return n;
    return {
      ...(n as unknown as Record<string, unknown>),
      components: applyOverridesToComponents(n.components, ownOverrides, n.id),
      __overriddenProps: ovProps,
    } as unknown as SceneNode;
  };
  /**
   * Where a cloner's driving layer sits, expressed in the CLONER's own frame.
   *
   * Computed over the RAW graph rather than the expanded list, because
   * expansion is what this feeds — the `localOf`/`parentOf` further down do not
   * exist yet, and depending on them would be circular. That is sound: a field
   * driver is an ordinary layer, never a clone, so the raw graph already has
   * everything needed.
   *
   * `localUnderParent`, not a plain position subtraction: subtracting world
   * positions is right only while the cloner sits unrotated at scale 1, which
   * is precisely the kind of thing that looks correct until someone animates a
   * rotation and the field starts sliding the wrong way.
   */
  const rawLocalOf: LocalOf = (id) => {
    const n = graph.getNode(id);
    if (!n) return null;
    const b = readBase(n as SceneNode);
    const av = rawAnim.evaluateNode(id, t);
    const sc = av.get('scale');
    return {
      x: av.get('x') ?? b.x,
      y: av.get('y') ?? b.y,
      rotation: av.get('rotation') ?? b.rotation,
      scaleX: av.get('scaleX') ?? sc ?? b.scaleX,
      scaleY: av.get('scaleY') ?? sc ?? b.scaleY,
    };
  };
  const rawParentOf: ParentOf = (id) => graph.getNode(id)?.parent ?? null;
  const rawWorldCache = new Map<string, Matrix2D>();
  const fieldOf = (clonerId: string, layerId: string): { x: number; y: number } | null => {
    if (!graph.getNode(layerId) || !graph.getNode(clonerId)) return null;
    const fieldW = worldMatrixOf(layerId, rawLocalOf, rawParentOf, rawWorldCache);
    const clonerW = worldMatrixOf(clonerId, rawLocalOf, rawParentOf, rawWorldCache);
    if (!fieldW || !clonerW) return null;
    const rel = localUnderParent(fieldW, clonerW);
    return { x: rel.x, y: rel.y };
  };

  /**
   * A path layer's outline, expressed in the CLONER's frame — the driver for
   * `mode: 'path'`. Shares everything with `fieldOf` above: raw graph, raw
   * world matrices, and the same reasoning about why (expansion is what this
   * feeds; a driver is an ordinary layer, never a clone).
   *
   * The outline itself comes from `nodeWorldOutline` — the SAME resolution the
   * boolean ops use (primitive outline vs Geometry points vs animated
   * `path.points`) — so the clones sit on the curve that is actually drawn,
   * not on a second implementation of it that drifts.
   */
  const pathOf = (clonerId: string, layerId: string): { points: Array<{ x: number; y: number }>; closed: boolean } | null => {
    const n = graph.getNode(layerId);
    if (!n || !graph.getNode(clonerId)) return null;
    const av = rawAnim.evaluateNode(layerId, t);
    // WORLD pose through the parent chain, like the live-boolean caller: a
    // path layer inside a moving null must carry the null's motion.
    const w = worldTransformOf(layerId, rawLocalOf, rawParentOf, rawWorldCache);
    const outline = nodeWorldOutline(
      n as SceneNode,
      (prop) => {
        if (prop === 'x') return w.x;
        if (prop === 'y') return w.y;
        if (prop === 'rotation') return w.rotation;
        if (prop === 'scaleX') return w.scaleX;
        if (prop === 'scaleY') return w.scaleY;
        return av.get(prop);
      },
      () => {
        const pts = rawAnim.sampleData(layerId, 'path.points', t);
        if (!Array.isArray(pts) || pts.length < 3) return undefined;
        if (typeof pts[0] !== 'object' || pts[0] === null || !('x' in (pts[0] as object))) return undefined;
        return (pts as Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>).map(
          (q) => ({ x: q.x, y: q.y, inX: q.inX ?? q.x, inY: q.inY ?? q.y, outX: q.outX ?? q.x, outY: q.outY ?? q.y }),
        );
      },
    );
    if (!outline) return null;
    // World → the cloner's local frame, so the plan's output lands in the same
    // space every other clone offset is expressed in. Inverting the matrix
    // (rather than subtracting positions) is what keeps a ROTATED or scaled
    // cloner honest — same lesson the field resolver already carries.
    const clonerW = worldMatrixOf(clonerId, rawLocalOf, rawParentOf, rawWorldCache);
    if (!clonerW) return null;
    const inv = Matrix.invert(clonerW);
    return {
      closed: outline.closed,
      points: outline.points.map((pt) => Matrix.transformPoint(inv, pt)),
    };
  };

  const nodes = expandCloners(expandCompInstances(
    graph, flattenComposition(graph, comp.rootId), comp.rootId, readCompCollapse,
    // Centre-anchors collapsed expansions so toggling Collapse never moves
    // content (see expandCompInstances' `sizeOf`).
    comp.compSizeOf,
  // AFTER `materializeForFrame`, never before: a graph node view exposes
  // `transform` and friends through prototype getters, and the spread in
  // `applyOwnOverrides` drops them — `readBase` then died on an undefined
  // transform. A materialized node is a plain object, so the spread is safe.
  ).map(materializeForFrame).map(applyOwnOverrides), fieldOf, pathOf);
  const anySolo = nodes.some((n) => n.solo === true);

  const rawController = getTimelineController();
  const fps = rawController.timeline.getFrameRate().fps;
  // Read once per snapshot, not per layer: the world is the same for every body
  // and a per-layer read would be a store subscription inside the hot loop.
  const physicsWorldSettings = usePhysicsStore.getState();

  /**
   * Rigid-body poses for this composition.
   *
   * A PRE-PASS, because bodies collide with each other: every body has to be
   * known before any one of them can be placed, so the per-layer loop below
   * cannot build this incrementally. Seeds come from `readBase` — the layer's
   * AUTHORED pose, which is where the simulated history begins.
   */
  const physicsSeeds: BodySeed[] = [];
  for (const n of nodes) {
    const cfg = readNodePhysics(n);
    if (!cfg) continue;
    const pb = readBase(n);
    physicsSeeds.push({
      id: n.id, x: pb.x, y: pb.y,
      // The authored rotation seeds the body's starting ANGLE, so a layer
      // placed at 25° begins its tumble from 25° rather than snapping flat.
      rotation: pb.rotation,
      width: pb.width ?? 100, height: pb.height ?? 100,
      cfg,
    });
  }
  const physicsPoses = physicsSeeds.length
    ? physicsPosesAt(
        comp.rootId ?? 'comp',
        physicsSeeds,
        {
          gravityX: physicsWorldSettings.gravityX,
          gravityY: physicsWorldSettings.gravityY,
          bounds: physicsWorldSettings.useCompBounds
            ? { left: 0, top: 0, right: comp.width, bottom: comp.height }
            : null,
          iterations: physicsWorldSettings.iterations,
        },
        fps,
        Math.round(t * (fps || 30)),
      )
    : null;

  // Parenting: each layer's on-screen transform is its local transform composed
  // with its parent chain's world transform (E3). Groups/nulls don't draw but
  // still participate as parents. Composition uses each node's ANIMATED local
  // values so parented children follow their parent live.
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const worldCache = new Map<string, Matrix2D>();

  // Comp-instance id indirection: a clone samples the ORIGINAL node's
  // animation tracks and timeline clips. Real nodes map to themselves.
  const srcId = (id: string): string => instanceSourceOf(nodeById.get(id)) ?? id;
  /**
   * Essential Properties: props this clone overrides (see
   * `compInstanceOverrides.ts`). Attached to the clone by `expandCompInstances`.
   *
   * This is the half that makes an override actually mean something. The static
   * value is already patched onto the clone's Transform, but every consumer
   * reads `a?.has(p) ? a.get(p) : base.p` — so on a KEYFRAMED layer the
   * original's track would outvote the patch on every frame, silently, and the
   * inspector control would look wired while changing nothing. Dropping the
   * prop here is what makes the override REPLACE the animation, as AE does.
   */
  const overriddenOf = (id: string): ReadonlySet<string> | null =>
    (nodeById.get(id) as unknown as { __overriddenProps?: ReadonlySet<string> })?.__overriddenProps ?? null;
  const anim: AnimationEngine = {
    sample: (id, prop, tt) =>
      overriddenOf(id)?.has(prop) ? undefined : rawAnim.sample(srcId(id), prop, tt),
    evaluateNode: (id, tt) => {
      const values = rawAnim.evaluateNode(srcId(id), tt);
      const ov = overriddenOf(id);
      // `evaluateNode` builds a fresh Map per call, so deleting is safe here.
      if (ov) for (const p of ov) values.delete(p);
      return values;
    },
    isAnimated: (id, prop) =>
      overriddenOf(id)?.has(prop) ? false : rawAnim.isAnimated(srcId(id), prop),
    timeSpan: (id) => rawAnim.timeSpan(srcId(id)),
    sampleData: (id: string, prop: string, tt: number) => rawAnim.sampleData(srcId(id), prop, tt),
  } as AnimationEngine;
  const controller = {
    getLayersForNode: (id: string) => rawController.getLayersForNode(srcId(id)),
  };
  /*
    The clips that GOVERN a node's time: its own, or its enclosing GROUP's.

    `TimelineController.governingClipsFor` answers the same question, and
    deliberately is NOT used here: it walks `defaultSceneGraph`, which does not
    contain this snapshot's EXPANDED comp-instance clones. `nodeById` does, and
    it is the graph actually being rendered — asking the other one would return
    no clips for every layer inside a comp instance and silently un-govern them.

    Bounded rather than `while (true)`: a malformed parent cycle must not hang a
    render. Nothing legitimate nests groups 32 deep.
  */
  const governingClipsOf = (id: string): ReturnType<typeof controller.getLayersForNode> => {
    const own = controller.getLayersForNode(id);
    if (own.length > 0) return own;
    let node = nodeById.get(id);
    for (let depth = 0; depth < 32; depth++) {
      const parentId = node?.parent ?? null;
      if (!parentId) return [];
      const parent = nodeById.get(parentId as string);
      // A precomp boundary, or anything that is not a plain group, ends the
      // walk: only a group's members are clip-less by design.
      if (!parent || isPrecomp(parent) || readNodeKind(parent) !== 'group') return [];
      const clips = controller.getLayersForNode(parent.id as string);
      if (clips.length > 0) return clips;
      node = parent;
    }
    return [];
  };

  // Per-layer time (E6): each layer maps comp time → its own source time
  // (stretch / reverse / freeze), so its animation is sampled at that time.
  // Default (100% / no reverse / no freeze) is identity → no behaviour change.
  const remapOf = (id: string): (tt: number) => number => {
    const hit = remapCache.get(id);
    if (hit) return hit;
    let fn = buildRemap(id);
    // Cloner cascade: a clone with a time offset plays its animation that many
    // seconds behind the source. Applied at COMP time — outside every clip map,
    // loop and precomp remap — because "this copy runs 0.3s behind" is a
    // statement about the composition's clock, not the layer's internal one.
    // The offset lives on the clone ROOT; a cloned group's children find it by
    // walking up, so the whole subtree delays together.
    const cascade = cloneTimeOffsetOf(id);
    if (cascade !== 0) {
      const inner = fn;
      fn = (tt: number) => inner(tt - cascade);
    }
    remapCache.set(id, fn);
    return fn;
  };
  /** Nearest ancestor clone root's time offset, or 0. Bounded walk. */
  const cloneTimeOffsetOf = (id: string): number => {
    let cur = nodeById.get(id);
    for (let i = 0; cur && i < 64; i++) {
      const off = cloneOffsetOf(cur);
      if (off) return off.timeOffset ?? 0;
      cur = cur.parent != null ? nodeById.get(cur.parent) : undefined;
    }
    return 0;
  };
  /**
   * Memoized exactly like `valuesOf` below — `remapOf` is called ~12× per node
   * per frame, and each uncached call re-scanned the node's clips, re-read its
   * layer-time config out of `components`, re-walked its precomp ancestor chain
   * and allocated 2-3 fresh closures. `valuesOf` was memoized; this was missed.
   */
  const remapCache = new Map<string, (tt: number) => number>();
  const buildRemap = (id: string): (tt: number) => number => {
    const n = nodeById.get(id);

    let baseMap = (tt: number) => tt;
    /*
      GOVERNING clips — the node's own, or its enclosing group's.

      This asked for the node's OWN clips, and a group's members have none by
      design (`syncFromScene` gives the group the bar). So `clips` came back
      empty for every member, `baseMap` stayed the identity, and each member was
      sampled at RAW COMP TIME while its bar said otherwise.

      The visible failure is subtle enough to look like success: drag a 0.9s
      library item from 0s to 5s and the gate moves correctly, so it appears at
      5s — but comp time 5.2s is sampled as keyframe time 5.2s, which is long
      past the end of a 0.87s choreography, so every frame of the bar shows the
      SETTLED pose. The move looks like it worked and the animation is simply
      gone. That is "the keyframes don't move with the template", from the one
      side of it the gate fix did not cover.

      Third and last of the matched set: `isLiveAt` decides WHETHER a layer
      draws, `compToKeyframeTime` decides where its diamonds sit, and this
      decides WHEN it is sampled. All three must ask the same question of the
      same clips or they disagree about the same bar.
    */
    const clips = governingClipsOf(id);
    if (clips.length > 0) {
      baseMap = (tt: number) => {
        const frame = Math.round(tt * fps);
        const active = clips.find((l) => l.isActiveAt(frame));
        if (active) {
          return active.clip.sourceFrameAt(frame) / fps;
        }
        return tt;
      };
    }

    // Loop the SOURCE (Interpret Footage ▸ Loop). Wrapping source time is the
    // whole implementation: a bar dragged longer than the file then keeps
    // reading real frames instead of holding the last one. Applied to the clip
    // map's output — the bar decides which part of the source timeline we are
    // on, looping decides what that means once it runs past the end.
    //
    // This is where the old Media panel's `loop` prop should always have lived.
    // As a boolean on the layer it had no defined interaction with clip trim at
    // all, which is part of why nothing ever read it.
    if (n) {
      const source = footageSourceOf(n);
      if (source && source.loopCount !== 1 && source.durationSec) {
        const inner = baseMap;
        baseMap = (tt: number) => applyLoop(inner(tt), source.durationSec, source.loopCount);
      }
    }

    // Posterize Time — quantize the layer's OWN clock to a lower frame rate, so
    // its animation steps instead of flowing. Temporal like Echo, so it belongs
    // here and not in the pixel chain: it changes WHEN the layer is sampled, and
    // therefore affects its transform, its masks and its effect params together.
    // Applied before stretch/reverse so the steps land on the posterized grid
    // rather than being smeared by a subsequent time warp.
    const posterizeFps = n ? readPosterizeTimeFps(readNodeRenderEffects(n)) : null;
    const posterized: (tt: number) => number = posterizeFps
      ? (tt) => Math.floor(baseMap(tt) * posterizeFps) / posterizeFps
      : baseMap;

    // Per-layer time (E6): stretch / reverse / freeze on the node itself.
    //
    // The remap anchor: the keyframe span when the layer has one; otherwise
    // the CLIP's source range (footage layers rarely carry keyframes), then
    // the footage duration. The old `{start: 0, end: 1}` fallback anchored a
    // plain video's reverse/stretch on a fictitious one-second span — Reverse
    // played one second backwards and froze on frame 0 for the rest of the
    // bar, and Stretch on a trimmed clip silently moved its in-point.
    const cfg = n ? readNodeLayerTime(n) : undefined;
    let remapSpan: { start: number; end: number } | undefined;
    if (cfg) {
      remapSpan = anim.timeSpan(id) ?? undefined;
      if (!remapSpan) {
        const active = clips[0];
        const source = n ? footageSourceOf(n) : null;
        if (active && active.clip.duration > 0) {
          const inSec = active.clip.sourceIn / fps;
          remapSpan = { start: inSec, end: inSec + active.clip.duration / fps };
        } else if (source?.durationSec) {
          remapSpan = { start: 0, end: source.durationSec };
        } else {
          remapSpan = { start: 0, end: 1 };
        }
      }
    }
    const own: (tt: number) => number = cfg
      ? (tt) => remapTime(posterized(tt), cfg, remapSpan!)
      : (tt) => posterized(tt);
    // Precomp time remap: a layer inside a precomp whose group has a
    // keyframed `precompTime` is sampled at that remapped internal time. The
    // group's own animation stays on comp time — only its nested content remaps.
    //
    // For NESTED precomps (A ▸ B ▸ C, A outermost) the remaps compose: start at
    // comp time, apply A's remap, then B's sampled at that result, then C's, then
    // the node's own layer-time. Folding the FULL ancestor chain (outermost →
    // innermost) — not just the nearest precomp — is what makes 3+ levels correct.
    // The chain excludes the node itself, so a precomp group's own remap (applied
    // via its `sourceTime`) is never double-counted for its own children.
    if (n) {
      const chain = precompAncestorChain(n, nodeById);
      const anyAnimated = chain.some(
        (pc) => anim.isAnimated(pc.id, 'timeRemap') || anim.isAnimated(pc.id, 'precompTime'),
      );
      if (anyAnimated) {
        return (tt) => {
          let time = tt;
          for (const pc of chain) {
            if (anim.isAnimated(pc.id, 'timeRemap') || anim.isAnimated(pc.id, 'precompTime')) {
              time = anim.sample(pc.id, 'timeRemap', time) ?? anim.sample(pc.id, 'precompTime', time) ?? time;
            }
          }
          return own(time);
        };
      }
    }
    return own;
  };
  /**
   * Assets indexed by id, built at most once per snapshot and only if a media
   * layer actually asks. The lookup used to be a linear
   * `assets.find(a => a.id === …)` inside the per-node loop, so a project with
   * 200 assets and 40 image layers did 8000 comparisons every frame.
   */
  let assetIndex: Map<string, ReturnType<typeof useAssetStore.getState>['assets'][number]> | null = null;
  const assetById = (): NonNullable<typeof assetIndex> => {
    assetIndex ??= new Map(useAssetStore.getState().assets.map((a) => [a.id, a]));
    return assetIndex;
  };

  const valueCache = new Map<string, Map<PropPath, number>>();
  const valuesOf = (id: string): Map<PropPath, number> => {
    let v = valueCache.get(id);
    if (!v) { v = anim.evaluateNode(id, remapOf(id)(t)); valueCache.set(id, v); }
    return v;
  };

  /**
   * A node's effect stack AND its layer styles, both sampled at `t`.
   *
   * `own` is the layer's own stack alone (the CSS `filter` describes only that,
   * so the two cannot double-apply); `all` appends the compiled styles, which is
   * what renders. After Effects evaluates layer styles after effects, hence the
   * order.
   *
   * The styles go through `resolveEffectParams` WITH the effects rather than
   * being concatenated after it. They used to be appended afterwards, which
   * meant every layer-style parameter was frozen at its stored value — a drop
   * shadow's distance, an overlay's colour and a stroke's width simply could not
   * be keyframed, while the identical parameter on the equivalent EFFECT could.
   * The compiled styles carry stable ids (`layerstyle:dropShadow`), so they need
   * nothing else to animate through the ordinary `effect.<id>.<key>` path.
   */
  const effectsAndStyles = (
    node: SceneNode,
    values: Map<PropPath, number> | undefined,
    /**
     * The layer's own time, for TIME-DEPENDENT effects (Timecode).
     *
     * Post time-remap, deliberately: a burn-in on a remapped or stretched layer
     * must read the frame the layer is actually showing — the same axis
     * Roughen's wiggle rides. Optional because the group and 3D-face call sites
     * have no meaningful layer clock of their own.
     */
    layerTimeSec?: number,
  ): {
    own: Effect[];
    all: Effect[];
  } => {
    const sample = (path: string): number | undefined => {
      const v = values?.get(path);
      return typeof v === 'number' ? v : undefined;
    };
    // Which styles carry ANY track — collected in one pass so the emit gates in
    // layerStylesToEffects can keep a style alive whose stored value is zero.
    const animated = new Set<string>();
    if (values) {
      for (const k of values.keys()) {
        if (!k.startsWith(LAYER_STYLE_TRACK_PREFIX)) continue;
        // `effect.layerstyle:dropShadow.distance` → `dropShadow`
        const rest = k.slice(LAYER_STYLE_TRACK_PREFIX.length);
        const dot = rest.indexOf('.');
        animated.add(dot < 0 ? rest : rest.slice(0, dot));
      }
    }
    const ownRaw = readNodeRenderEffects(node);
    const styleRaw = layerStylesToEffects(
      readNodeLayerStyles(node), globalLight.angle, globalLight.altitude,
      (k) => animated.has(k),
    );
    const resolved = resolveEffectParams([...ownRaw, ...styleRaw], sample, layerTimeSec);

    // Audio Spectrum's band magnitudes are analysed HERE, where the scene and
    // the audio engine are both reachable, and written into the effect's params.
    // The drawing kernel then stays a pure function of its params — which is
    // what keeps preview and export identical — and the per-frame magnitudes are
    // what correctly make the content hash vary for this layer, and only this
    // layer. Same mechanism as the Timecode clock above.
    const all = layerTimeSec === undefined
      ? resolved
      : resolved.map((e) => {
          if (e.type !== 'audio-spectrum') return e;
          const p = paramsOf(e);
          const magnitudes = resolveAudioSpectrum(
            {
              sourceLayerId: typeof p.audioLayerId === 'string' ? p.audioLayerId : '',
              bands: typeof p.bands === 'number' ? p.bands : 32,
              startFreq: typeof p.startFreq === 'number' ? p.startFreq : 40,
              endFreq: typeof p.endFreq === 'number' ? p.endFreq : 16000,
            },
            layerTimeSec,
          );
          return { ...e, params: { ...p, magnitudes } };
        });

    return { own: all.slice(0, ownRaw.length), all };
  };

  const localOf: LocalOf = (id) => {
    const n = nodeById.get(id);
    if (!n) return null;
    const b = readBase(n);
    const av = valuesOf(id);
    const sc = av.get('scale');
    // Per-axis scale is checked BEFORE the uniform `scale` shorthand, matching
    // every other reader of these tracks (`ports.ts:127`, `nodeMatrix.ts:80`,
    // the motion-blur sampler below). This used to read `scale` alone, so a
    // keyframed `scaleX`/`scaleY` — which is what the scale gizmo autokeys, what
    // the SVG importer writes for a CSS `scale` animation, and what the seeded
    // showcases use — moved the selection box and left the pixels at 1.
    return {
      x: av.get('x') ?? b.x,
      y: av.get('y') ?? b.y,
      rotation: av.get('rotation') ?? b.rotation,
      scaleX: av.get('scaleX') ?? sc ?? b.scaleX,
      scaleY: av.get('scaleY') ?? sc ?? b.scaleY,
    };
  };
  // A comp instance's expanded children are authored in the REFERENCED comp's
  // own coordinate space, so the instance's transform must not compose into
  // them — it is applied once, to the container. They keep `parent` pointing at
  // the instance (precomp routing and time-remap inheritance both walk it);
  // only the TRANSFORM chain stops here. See `isCompInstanceRoot`.
  const parentOf: ParentOf = (id) => {
    const n = nodeById.get(id);
    if (!n || isCompInstanceRoot(n)) return null;
    return n.parent ?? null;
  };

  // 3D parenting: the accumulated 4×4 of a layer's ancestor chain, or null when
  // no ancestor is 3D (the overwhelmingly common case, which keeps the ordinary
  // 2D path byte-identical).
  //
  // `worldTransformOf` above is a 2×3 affine — x/y/rotation/scaleX/scaleY — so
  // on its own a child inherits none of its parent's z / rotationX / rotationY.
  // A 3D null dollying away in Z left its children exactly where they were.
  const parent3dCache = new Map<string, import('@motion/scene').Matrix4 | null>();
  const local3DOf = (id: string) => {
    const n = nodeById.get(id);
    return n ? resolveNode3DTransform(n, remapOf(id)(t)) : null;
  };
  const parent3dOf = (id: string) =>
    parentWorld3d(
      id,
      {
        parentOf,
        local3DOf,
        is3DOf: (nid) => {
          const n = nodeById.get(nid);
          return !!n && is3DEnabled(n);
        },
        // The ancestor's WORLD 2D affine, recomposed from the same TRS the rest
        // of the renderer uses, so the flattened branch and the 2D path agree.
        world2DOf: (nid) => {
          const w = worldTransformOf(nid, localOf, parentOf, worldCache);
          return localMatrix({ x: w.x, y: w.y, rotation: w.rotation, scaleX: w.scaleX, scaleY: w.scaleY });
        },
      },
      parent3dCache,
    );

  // Precomp routing: a layer whose node sits inside a precomp group
  // is collected into that group's texture instead of the top-level comp. The
  // precomp container layer is emitted (once) at the first descendant's position
  // and itself routed, so nested precomps nest correctly.
  const precompInner = new Map<string, RenderLayer[]>();
  const precompEmitted = new Set<string>();
  /**
   * The internal time a precomp's content is sampled at: its own time-remap
   * track when keyframed, otherwise the comp time through its clip/stretch.
   * Split out because the recursive pass has to render the nested composition at
   * exactly the time its container claims to be showing.
   */
  const precompSourceTime = (groupNode: SceneNode): number => {
    const remapped = anim.sample(groupNode.id, 'timeRemap', t) ?? anim.sample(groupNode.id, 'precompTime', t);
    return remapOf(groupNode.id)(remapped !== undefined ? remapped : t);
  };
  const buildPrecompContainer = (groupNode: SceneNode, innerOverride?: RenderLayer[]): RenderLayer => {
    const gv = valuesOf(groupNode.id);
    const gBase = readBase(groupNode);
    const inner = innerOverride ?? precompInner.get(groupNode.id) ?? [];
    // Resolve the container's effect stack once — the CSS string stays for
    // tests/legacy readers, the structured list is what the GPU path renders
    // (without it a precomp's effects were silently dropped on composite).
    // Own effects + layer styles, both sampled — see `effectsAndStyles`. The
    // styles are appended after the container's own stack, matching AE.
    const { own: gFxOwn, all: gFx } = effectsAndStyles(groupNode, gv);
    const filter = effectsToFilter(gFxOwn) || undefined;
    // A comp INSTANCE has an intrinsic frame: the referenced composition's own
    // width/height, placed at the instance layer's own transform. A plain
    // precomp GROUP (from Pre-compose) has no frame of its own — its children
    // are already in comp space and its transform reaches them through ordinary
    // parenting — so it keeps the full-comp carrier it has always had.
    //
    // NOTE: this places and sizes the frame; it does not yet CROP to it. Content
    // that overflows the referenced comp's bounds still shows, where After
    // Effects would clip it at the instance's edges.
    const ref = readCompRef(groupNode);
    const refSize = ref ? comp.compSizeOf?.(ref) : undefined;
    const isInstance = ref !== null && refSize !== undefined;
    const gWorld = isInstance
      ? worldTransformOf(groupNode.id, localOf, parentOf, worldCache)
      : null;
    // Crop to the frame. A composition is a rectangle of a stated size, and
    // content outside it is not part of the composition — placing a 1080×1920
    // cut into a wider master must show the 1080-wide slice, not everything that
    // happens to sit beside it.
    //
    // Expressed as a full-box rectangle mask because that is machinery the
    // isolated composite already has: `prepareIsolatedPrecomp` bakes the
    // container's mask into the offscreen before compositing. It is appended
    // with `intersect` so an authored mask still applies and the frame then
    // clips the result, rather than the two unioning.
    //
    // The id is derived from the node, NOT minted per call: the mask raster is
    // cached on a signature that includes it, so a fresh id every frame would
    // miss the cache on every frame.
    const authoredMask = applyMaskPropertyTracks(readNodeMaskAt(groupNode, remapOf(groupNode.id)(t)), valuesOf(groupNode.id));
    const frameMask: LayerMask | undefined = isInstance && refSize
      ? {
          paths: [
            ...(authoredMask?.paths ?? []),
            {
              id: `${groupNode.id}::frame`,
              mode: authoredMask?.paths.length ? 'intersect' : 'add',
              closed: true,
              feather: 0,
              opacity: 1,
              expansion: 0,
              inverted: false,
              points: [
                { x: -refSize.width / 2, y: -refSize.height / 2, inX: -refSize.width / 2, inY: -refSize.height / 2, outX: -refSize.width / 2, outY: -refSize.height / 2 },
                { x: refSize.width / 2, y: -refSize.height / 2, inX: refSize.width / 2, inY: -refSize.height / 2, outX: refSize.width / 2, outY: -refSize.height / 2 },
                { x: refSize.width / 2, y: refSize.height / 2, inX: refSize.width / 2, inY: refSize.height / 2, outX: refSize.width / 2, outY: refSize.height / 2 },
                { x: -refSize.width / 2, y: refSize.height / 2, inX: -refSize.width / 2, inY: refSize.height / 2, outX: -refSize.width / 2, outY: refSize.height / 2 },
              ],
            },
          ],
        }
      : authoredMask;
    return {
      id: groupNode.id,
      kind: 'shape',
      blend: readNodeBlend(groupNode),
      ...(readNodePreserveTransparency(groupNode) ? { preserveTransparency: true } : {}),
      mask: frameMask,
      matte: readNodeMatte(groupNode),
      x: gWorld ? gWorld.x : comp.width / 2,
      y: gWorld ? gWorld.y : comp.height / 2,
      rotation: gWorld ? gWorld.rotation : 0,
      scaleX: gWorld ? gWorld.scaleX : 1,
      scaleY: gWorld ? gWorld.scaleY : 1,
      depth: 0,
      opacity: gv?.has('opacity') ? (gv.get('opacity') as number) / 100 : gBase.opacity,
      width: refSize ? refSize.width : comp.width,
      height: refSize ? refSize.height : comp.height,
      fill: '#000',
      visible: groupNode.visible !== false,
      filter,
      effects: gFx.length ? gFx : undefined,
      precompLayers: inner,
      sourceTime: precompSourceTime(groupNode),
    };
  };
  const emitLayer = (l: RenderLayer, node: SceneNode): void => {
    const pc = nearestPrecompRoot(node, nodeById);
    if (!pc) { layers.push(l); return; }
    let inner = precompInner.get(pc.id);
    if (!inner) { inner = []; precompInner.set(pc.id, inner); }
    inner.push(l);
    if (!precompEmitted.has(pc.id)) {
      precompEmitted.add(pc.id);
      emitLayer(buildPrecompContainer(pc), pc); // route the container itself (nesting)
    }
  };

  /**
   * A camera or light's WORLD position — its own animated x/y/z composed with
   * its parent chain, exactly like a content layer.
   *
   * This exists because the readers of a light's position disagreed. The visible
   * wash resolved through `worldTransformOf` (parent-aware) while the Lambert
   * shading and `shadowLight` read `readBase` (the raw LOCAL props). Parent a
   * light to a null and drag it: the glow flew across the frame while the
   * shading on every lit layer did not move at all, because two of the three
   * were reading a position the user had already moved away from. Cameras were
   * worse — they had no parent path at all, so the standard "camera parented to
   * a null" rig moved nothing.
   *
   * The 4×4 parent chain is preferred (it carries z / rotationX / rotationY, so
   * a 3D null dollying in depth takes the light with it) and the 2D world affine
   * is the fallback — the same rule the layer walk uses, so a camera, a light
   * and the layers around them can never be composed by different rules.
   *
   * Declared HERE, above the camera block, because the camera resolves before
   * the layer walk and needs the identical lift.
   */
  const parentWorldMatrixOf = (id: string): Matrix4 | null => {
    const parentId = parentOf(id);
    if (!parentId) return null;
    // A 3D ancestor anywhere in the chain ⇒ compose in 4×4 so depth and X/Y
    // rotation carry. `parentWorld3d` already folds any 2D ancestors above it.
    const p3 = parent3dOf(id);
    if (p3) return p3;
    // Pure-2D chain: the parent's own WORLD affine, lifted to 4×4. z is left
    // untouched, which is AE's rule for a 2D parent.
    const pw = worldTransformOf(parentId, localOf, parentOf, worldCache);
    return Matrix4Math.fromMatrix2D(
      localMatrix({ x: pw.x, y: pw.y, rotation: pw.rotation, scaleX: pw.scaleX, scaleY: pw.scaleY }),
    );
  };

  /** A point expressed in `id`'s parent space, lifted into world space. */
  const toWorldPoint = (
    id: string,
    p: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } => {
    const m = parentWorldMatrixOf(id);
    return m ? Matrix4Math.transformPoint(m, p) : p;
  };

  /** A camera / light node's own animated position, lifted into world space. */
  const nodeWorldPosition = (n: SceneNode): { x: number; y: number; z: number } => {
    const av = valuesOf(n.id);
    const b = readBase(n);
    return toWorldPoint(n.id, {
      x: av.get('x') ?? b.x,
      y: av.get('y') ?? b.y,
      z: av.get('z') ?? readNode3D(n).z,
    });
  };

  /**
   * A light's effective comp-plane aim, in DEGREES.
   *
   * `lightAngle` (the inspector's "Direction") is the fixture's own aim; the
   * layer's rotation turns the whole fixture, exactly as rotating any other
   * layer turns it. The two sum.
   *
   * Rotating a light used to do nothing whatsoever. The inspector offers the
   * full Transform section on a light — Rotation included — but the wash was
   * emitted with `rotation: 0`, its cone was baked into the wash texture from
   * `lightAngle` alone, and `sceneLights` read the same raw prop, so no render
   * path consulted the control at all. A spot could only be swung from the
   * Direction field, and the huge centre-weighted glow never moved, which reads
   * as the light piling up on itself rather than sweeping.
   *
   * Summed HERE, once, because the glow, the per-quad Lambert shading, the
   * per-fragment shader and the viewport cone gizmo must all aim at the same
   * place — the "ONE light, ONE resolver" rule this file has had to re-learn at
   * every other light call site.
   *
   * WORLD rotation, not local, so a spot parented to a spinning null sweeps
   * with the rig — the same parent-awareness `nodeWorldPosition` gives the
   * origin. A TARGETED light is unaffected: a POI is a real 3D aim and wins
   * over `angle` outright (see `lightAim3D`), exactly as in AE.
   */
  const nodeLightAimDeg = (n: SceneNode, lt: { angle: number }): number => {
    const base = valuesOf(n.id).get('lightAngle') ?? lt.angle;
    return (base as number) + worldTransformOf(n.id, localOf, parentOf, worldCache).rotation;
  };

  // 3D: the composition camera (a Camera layer if present, else the default)
  // projects each 3D layer's plane — +z dollies + parallaxes, and X/Y rotation
  // tilts it in real perspective. Pure-2D layers skip this entirely, so their
  // output is byte-for-byte unchanged. The camera's keyframed x/y/z/focalLength
  // are sampled at the current (remapped) time via valuesOf, so animating the
  // camera pans / dollies / zooms the whole 3D scene; an unkeyframed camera
  // resolves from its static props exactly as before.
  /**
   * Is this node's layer live at the current frame? (AE in/out points.)
   *
   * Hoisted out of the layer walk below so the CAMERA selection can apply the
   * same test: After Effects picks the topmost *live* camera, so a camera
   * trimmed to the back half of the comp must not steer the front half. Sharing
   * the predicate is the point — a camera judged live by one rule and drawn by
   * another is the class of bug this file keeps re-learning.
   */
  const isLiveAt = (nodeId: string): boolean => {
    // The GOVERNING clips, not merely this node's own.
    //
    // Groups are skipped in the layer walk below — the renderer draws their
    // MEMBERS — and `syncFromScene` gives the group the clip and its members
    // none. Asking a member for its own clips therefore returned nothing, this
    // read "no clips, always live", and a group's in/out bar governed nothing
    // it visibly contained. The time axis asks the identical question
    // (`compToKeyframeTime`), which is the point: a layer judged live by one
    // rule and retimed by another is the class of bug this file keeps
    // re-learning.
    // The LOCAL walk, not `TimelineController.governingClipsFor` — see its
    // definition above. Both answer the same question; only this one can see
    // this snapshot's expanded comp-instance clones, and the gate and the time
    // remap have to agree on the same clips or they disagree about the bar.
    const nodeClips = governingClipsOf(nodeId);
    if (nodeClips.length === 0) return true;
    const rawFrame = Math.round(t * fps);
    // Clip spans are end-EXCLUSIVE; clamp so a full-length layer doesn't blink
    // out at the exactly-end playhead. Only meaningful when the caller gave us a
    // duration (see the long note at the layer-walk call site).
    const gateFrame = comp.durationSeconds !== undefined
      ? Math.min(rawFrame, Math.max(0, Math.round(comp.durationSeconds * fps) - 1))
      : rawFrame;
    return nodeClips.some((l) => l.isActiveAt(gateFrame));
  };

  const cameraMode = comp.camera3dMode ?? 'active';
  // The six axis views project orthographically (no perspective, no scene
  // camera); 'active' uses the scene's Camera layer. One `project` closure so
  // every projection site below is view-agnostic.
  const orthoView: Project3D.OrthoView | null =
    cameraMode === 'active' ? null : (cameraMode as Project3D.OrthoView);
  // Custom views (AE parity): a pre-built view camera supplied by the editor
  // replaces the scene camera — the shot camera is deliberately IGNORED.
  const customCamera = orthoView ? null : comp.customViewCamera ?? null;
  const camera = orthoView
    ? null
    : customCamera ?? readSceneCamera(
        graph,
        comp.width,
        comp.height,
        (id, p) => valuesOf(id).get(p),
        comp.rootId,
        // The camera is a layer: it follows its parent chain like everything
        // else, through the renderer's own per-frame caches.
        toWorldPoint,
        { isLiveAt },
      );
  const project = orthoView
    ? (p: { x: number; y: number; z: number }) => Project3D.projectOrtho(p, orthoView, comp.width, comp.height)
    : (p: { x: number; y: number; z: number }) => Project3D.projectPoint(p, camera!);

  /*
    Camera motion blur. `moves()` inspects only a layer's OWN animated props and
    `project` is built once per frame from the camera at `t` — so a static 3D
    layer under a fully keyframed camera pan rendered perfectly sharp while its
    animated neighbour blurred. The fix is two-sided: an animated active camera
    (a) extends the motion gate to every 3D layer, and (b) supplies a PER-SAMPLE
    projector, so each sub-frame sample projects through the camera's own pose
    at that sample's comp time. The camera NODE is resolved once (it cannot
    change across one shutter) and its resolved pose is memoized per sample
    time, since every 3D layer shares the same sub-frame cameras.
    Ortho/custom views have no scene camera, so there is nothing to blur there;
    the camera's parent chain is sampled at frame time like every other parent
    (the documented static-chain approximation).
  */
  const cameraMotionNode = !orthoView && !customCamera && motionBlur
    ? activeCameraNode(graph, comp.rootId, { isLiveAt })
    : null;
  const cameraAnimated =
    cameraMotionNode !== null &&
    CAMERA_MOTION_PROPS.some((p) => anim.isAnimated(cameraMotionNode.id, p));
  const subFrameCameras = new Map<number, ReturnType<typeof cameraFromNode>>();
  const projectAtTime = cameraAnimated && cameraMotionNode
    ? (tc: number): ((p: { x: number; y: number; z: number }) => Project3D.Projected) => {
        let cam = subFrameCameras.get(tc);
        if (!cam) {
          cam = cameraFromNode(
            cameraMotionNode,
            comp.width,
            comp.height,
            (id, p) => anim.sample(id, p, tc),
            toWorldPoint,
          );
          subFrameCameras.set(tc, cam);
        }
        const fixed = cam;
        return (p) => Project3D.projectPoint(p, fixed);
      }
    : null;

  // Depth of field: layers blur by how far their depth sits from the camera's
  // focus distance (linear ramp, capped at `strength` px). Orthographic views
  // have no lens, so DOF is off.
  // Draft 3D skips DOF entirely (dof = null ⇒ withDof/dofEffectOf no-op).
  const dof = orthoView || customCamera || comp.draft3d
    ? null
    : readSceneDof(graph, comp.width, comp.height, (id, p) => valuesOf(id).get(p), comp.rootId, { isLiveAt });
  // `depth: undefined` = this layer is not in the camera's space (a 2D layer),
  // so it is never defocused.
  const withDof = (f: string | undefined, depth: number | undefined): string | undefined => {
    if (!dof || depth === undefined) return f;
    const blur = dofBlurPx(depth, dof);
    if (blur < 0.3) return f;
    const b = `blur(${blur.toFixed(1)}px)`;
    return f ? `${f} ${b}` : b;
  };
  // GPU twin of withDof: the same blur amount as a real effect entry, so
  // snapshotToFrameScene's extractSpatialEffects routes it through the
  // CompositionPass blur pass. The CSS string above only ever fed the (deleted)
  // Canvas2D backend — without this, DOF rendered nothing on the GPU path.
  const dofEffectOf = (depth: number): Effect | null => {
    if (!dof) return null;
    const blur = dofBlurPx(depth, dof);
    if (blur < 0.3) return null;
    const iris = dofIrisParams(dof);
    return {
      id: 'dof',
      type: 'blur',
      params: {
        amount: Number(blur.toFixed(1)),
        ...(iris.blades !== undefined ? { blades: iris.blades } : {}),
        ...(iris.roundness !== undefined ? { roundness: iris.roundness } : {}),
        ...(iris.highlightGain !== undefined && iris.highlightGain > 0
          ? { highlightGain: iris.highlightGain }
          : {}),
      },
    };
  };

  // Cast shadows: every shadow-casting non-ambient light projects casters onto
  // receivers behind them. First light still drives the 2D CSS/drop-shadow
  // fallback (`withShadow` / `shadowEffectOf`) for layers that never enter the
  // projected path.
  type ShadowLight = {
    x: number; y: number; z: number;
    intensity: number; darkness: number; diffusion: number;
  };
  const shadowLights: ShadowLight[] = (() => {
    if (comp.draft3d) return [];
    const out: ShadowLight[] = [];
    for (const n of nodes) {
      if (readNodeKind(n) !== 'light') continue;
      const lt = readNodeLight(n);
      if (!lt.shadows || lt.type === 'ambient') continue;
      const av = valuesOf(n.id);
      const wp = nodeWorldPosition(n);
      out.push({
        x: wp.x,
        y: wp.y,
        // Z matters: it is what turns a flat offset into a real projection.
        // A light in FRONT of the caster (z < casterZ) throws the shadow onto
        // the surfaces behind it, growing with the gap — which is the whole
        // reason a shadow reads as depth.
        //
        // `av` is the ANIMATION map, so `av.get('z') ?? 0` silently pinned an
        // unanimated light to z = 0 (readBase has no z to fall back on, unlike
        // x/y above). That put the light in the caster's own plane: `denom`
        // collapsed to the caster's z, so a caster at z = 0 hit the
        // divide-by-zero guard and anything under z ≈ 150 blew the t > 8 cap —
        // no shadow, for exactly the layers most likely to be at the front.
        // `nodeWorldPosition` keeps that base-prop fallback and adds the parent
        // chain on top.
        z: wp.z,
        intensity: av.get('intensity') ?? lt.intensity,
        // AE's Shadow Darkness / Shadow Diffusion. Darkness scales the shadow's
        // opacity; diffusion adds to its blur. Both default to the values that
        // reproduce the previous hardcoded look (100% / +0px).
        darkness: (av.get('shadowDarkness') ?? lt.shadowDarkness) / 100,
        diffusion: av.get('shadowDiffusion') ?? lt.shadowDiffusion,
      });
    }
    return out;
  })();
  const shadowLight = shadowLights[0] ?? null;

  /**
   * Planes that can RECEIVE a projected shadow: 3D layers whose material accepts
   * shadows, recorded as {z, depth} once the main loop has placed them.
   *
   * Filled during the layer walk below and consumed after it, because a caster
   * can only be projected onto receivers that exist — and the walk is the only
   * place a layer's resolved world z is known.
   */
  const shadowReceivers: Array<{ z: number; depth: number }> = [];
  /**
   * Planes a BEAM can land on: 3D layers whose material accepts lights, recorded
   * as {z, depth} by the same walk that records shadow receivers.
   *
   * A spot's wash used to be drawn at the fixture, so an aimed light read as a
   * glow sitting on its own emitter rather than as light falling on the thing it
   * was pointed at. A beam needs a surface for exactly the reason a shadow does.
   */
  const lightReceivers: Array<{ z: number; depth: number }> = [];
  /**
   * Emitted wash layers, held by reference so the post-walk pass can move one
   * onto the plane it illuminates. Deliberately a MUTATION of the already-placed
   * layer rather than a deferred emit: the wash screen-blends, so its stack
   * position decides what it brightens, and re-emitting at the end would light
   * layers that sit above it.
   */
  const washLights: Array<{ nodeId: string; layer: RenderLayer; reach: number }> = [];
  /** Casters captured during the walk, projected onto receivers afterwards.
   *  `transmission` is Material Options → Light Transmission as 0..1: how much
   *  of the caster's own colour bleeds into its shadow (0 = a black silhouette,
   *  1 = the caster's colour, which is how stained glass and gels read). */
  const shadowCasters: Array<{ layer: RenderLayer; z: number; transmission: number; world3d: readonly number[] }> = [];
  /** The projected shadow quads, appended once the walk has placed everything. */
  const shadowLayers: RenderLayer[] = [];
  /**
   * A shadow's colour: black lerped toward the caster's own fill by Light
   * Transmission (0..1). Non-hex or missing fills fall back to black, which is
   * the pre-transmission behaviour.
   */
  const shadowTint = (fill: string | undefined, transmission: number): string => {
    if (transmission <= 0) return '#000000';
    const m = /^#?([0-9a-f]{6})$/i.exec(fill ?? '');
    if (!m) return '#000000';
    const n = parseInt(m[1]!, 16);
    const ch = (shift: number): string =>
      Math.round(((n >> shift) & 0xff) * Math.min(1, transmission))
        .toString(16)
        .padStart(2, '0');
    return `#${ch(16)}${ch(8)}${ch(0)}`;
  };
  // Scene lights in WORLD space, for per-quad Lambert shading of 3D layers that
  // opt in via Material Options → Accepts Lights.
  //
  // Position comes from `nodeWorldPosition` — the same resolver the wash and
  // `shadowLight` use. It used to read the raw LOCAL props here, so a light
  // parented to a null lit the scene from wherever it had been *before* the
  // null moved: the glow moved, the shading did not.
  // Draft 3D collects no lights ⇒ per-quad shading, per-fragment shade3d and
  // lights3d all fall away without touching the pipeline itself.
  const sceneLights: SceneLight[] = [];
  /**
   * The same lights, by node id. The beam projection needs a light's RESOLVED
   * world position and its parent-lifted Point of Interest, and this is where
   * both already exist — re-deriving them at the wash would be a fourth reader
   * of a light's position, which is the bug this file has fixed three times.
   */
  const sceneLightById = new Map<string, SceneLight>();
  for (const n of comp.draft3d ? [] : nodes) {
    if (readNodeKind(n) !== 'light') continue;
    const lt = readNodeLight(n);
    const av = valuesOf(n.id);
    const wp = nodeWorldPosition(n);
    sceneLights.push({
      ...lt,
      intensity: av.get('intensity') ?? lt.intensity,
      radius: av.get('radius') ?? lt.radius,
      angle: nodeLightAimDeg(n, lt),
      cone: av.get('lightCone') ?? lt.cone,
      coneFeather: av.get('lightConeFeather') ?? lt.coneFeather,
      falloffDistance: av.get('falloffDistance') ?? lt.falloffDistance,
      // A keyframed POI aims the light in 3D over time. Any single component
      // being animated is enough to make the light a targeted one, so the base
      // POI (which may be null) has to be filled in rather than spread through.
      //
      // The target rides the SAME parent transform as the eye — otherwise
      // parenting a spot to a null swung its origin while its aim stayed nailed
      // to a fixed comp point, i.e. the cone sheared open as the null moved.
      poi: (() => {
        const px = av.get('poiX') ?? lt.poi?.x;
        const py = av.get('poiY') ?? lt.poi?.y;
        const pz = av.get('poiZ') ?? lt.poi?.z;
        return px === undefined && py === undefined && pz === undefined
          ? null
          : toWorldPoint(n.id, { x: px ?? 0, y: py ?? 0, z: pz ?? 0 });
      })(),
      // Same trap as shadowLight: `av` holds ANIMATED values only, so a literal
      // fallback pinned every unanimated light to z = 0 — i.e. into the comp
      // plane. All per-fragment lighting then lit from dead ahead no matter
      // where the user put the light in depth. `nodeWorldPosition` keeps the
      // base-prop fallback and composes the parent chain on top.
      x: wp.x,
      y: wp.y,
      z: wp.z,
    });
    sceneLightById.set(n.id, sceneLights[sceneLights.length - 1]!);
  }

  const withShadow = (f: string | undefined, lx: number, ly: number): string | undefined => {
    if (!shadowLight) return f;
    let dx = lx - shadowLight.x;
    let dy = ly - shadowLight.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) {
      dx = 0;
      dy = 1;
    } else {
      dx /= len;
      dy /= len;
    }
    const strength = Math.max(0, Math.min(1, (shadowLight.intensity / 100) * shadowLight.darkness));
    const off = 6 + 10 * strength;
    const s = `drop-shadow(${(dx * off).toFixed(1)}px ${(dy * off).toFixed(1)}px ${(6 + 8 * strength + shadowLight.diffusion).toFixed(0)}px rgba(0,0,0,${(0.45 * strength).toFixed(2)}))`;
    return f ? `${f} ${s}` : s;
  };
  // GPU twin of withShadow: the same offset/softness/opacity expressed in the
  // drop-shadow effect's params (extractSpatialEffects reconstructs offsetX/Y as
  // cos/sin(angle)·distance, which is exactly the dx/dy·off above).
  const shadowEffectOf = (lx: number, ly: number): Effect | null => {
    if (!shadowLight) return null;
    let dx = lx - shadowLight.x;
    let dy = ly - shadowLight.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) {
      dx = 0;
      dy = 1;
    } else {
      dx /= len;
      dy /= len;
    }
    const strength = Math.max(0, Math.min(1, (shadowLight.intensity / 100) * shadowLight.darkness));
    if (strength <= 0) return null;
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return {
      id: 'cast-shadow',
      type: 'drop-shadow',
      params: {
        distance: Number((6 + 10 * strength).toFixed(1)),
        angle: Number(angle.toFixed(1)),
        softness: Number((6 + 8 * strength + shadowLight.diffusion).toFixed(0)),
        color: '#000000',
        opacity: Number((45 * strength).toFixed(1)),
      },
    };
  };

  /**
   * A SEALED composition placed as a layer: render the referenced comp through
   * its OWN recursive pass and hand the result to the container.
   *
   * This is what makes a placed composition a real composition rather than a bag
   * of borrowed nodes. Everything the nested pass resolves is now the CHILD's:
   * its camera and depth of field, its own 3D depth sort, its own solo scope,
   * its own frame size. Previously its nodes were spliced into this walk, so a
   * 3D layer two comps deep was projected through whatever camera the outermost
   * composition happened to own — the sealed frame leaked.
   *
   * `compStack` is the cycle guard. Insertion already refuses reference loops
   * (`wouldCreateCompCycle`), but a hand-edited or migrated document must not be
   * able to hang the renderer.
   */
  const stack = comp.compStack ?? [];
  const nestedCompLayers = (node: SceneNode, ref: string): RenderLayer[] | null => {
    if (stack.includes(ref) || stack.length >= MAX_COMP_DEPTH) return null;
    if (!graph.getNode(ref)) return null;
    const size = comp.compSizeOf?.(ref) ?? { width: comp.width, height: comp.height };
    const nested = buildSnapshot(
      graph,
      rawAnim,
      // The container reports this as its `sourceTime`; the content has to be
      // rendered at the same instant or a time-remapped comp shows one frame and
      // claims another.
      precompSourceTime(node),
      // Focus rings, guides and the region of interest belong to the composition
      // the user is EDITING, never to one nested inside it.
      undefined,
      undefined,
      undefined,
      motionBlur,
      {
        ...comp,
        width: size.width,
        height: size.height,
        rootId: ref,
        // Essential Properties belong to THIS instance, so they must replace
        // (never inherit) whatever the host pass was carrying — `...comp` would
        // otherwise leak an outer instance's overrides into every comp nested
        // below it, keyed by ids that happen to match.
        compOverrides: readCompOverrides(node),
        // A nested comp contributes content, not a backdrop — its own
        // background must not paint over the host.
        transparent: true,
        backgroundPaint: undefined,
        // The host's view mode does not reach inside a sealed comp: it is
        // composited as a flat card, so an ortho view or a custom view camera
        // would be re-applied on top of the host's own.
        camera3dMode: 'active',
        customViewCamera: undefined,
        compStack: [...stack, ref],
      },
    );
    return prefixLayerIds(nested.layers, `${node.id}::`);
  };

  // Which layers must be fully materialized this frame. Invisible / un-soloed
  // layers still occupy stack slots (mattes, paint order) but a 1×1 stub is
  // enough — building geometry, effects and text for 10k hidden layers is the
  // main per-frame cost once the scene tree is virtualized. Matte sources of
  // layers that WILL draw stay in the full-build set so the matte still has
  // real pixels.
  const layerWillDraw = (n: SceneNode): boolean =>
    n.visible !== false
    && (!anySolo || n.solo === true)
    && !(comp.forExport === true && readIsGuideLayer(n));

  const needsFullBuild = new Set<string>();
  {
    const emitOrder: SceneNode[] = [];
    for (const n of nodes) {
      const k = readNodeKind(n);
      if (k === 'group' || k === 'null' || k === 'camera' || k === 'audio') continue;
      if (k === 'comp' && readCompCollapse(n)) continue;
      if (isBooleanOperand(n)) continue;
      if (!isLiveAt(n.id)) continue;
      if (k === 'light' && comp.draft3d) continue;
      emitOrder.push(n);
    }
    for (let i = 0; i < emitOrder.length; i++) {
      const n = emitOrder[i]!;
      if (!layerWillDraw(n)) continue;
      needsFullBuild.add(n.id);
      const m = readMatte(readNodeMatte(n));
      if (!m) continue;
      if (m.sourceId) needsFullBuild.add(m.sourceId);
      else if (i + 1 < emitOrder.length) needsFullBuild.add(emitOrder[i + 1]!.id);
    }
  }

  const emitInvisibleStub = (node: SceneNode): void => {
    emitLayer({
      id: node.id,
      kind: 'shape',
      x: 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      depth: 0,
      opacity: 0,
      width: 1,
      height: 1,
      fill: '#000',
      visible: false,
      matte: readNodeMatte(node),
    }, node);
  };

  for (const node of nodes) {
    const kind = readNodeKind(node);
    if (kind === 'comp') {
      // A COLLAPSED instance is structural here: its layers were already
      // expanded into this walk, so the node itself draws nothing and must not
      // also mint a container — that would render its content twice, once
      // spliced and once as a card.
      const ref = readCompRef(node);
      const sealed = ref !== null && !readCompCollapse(node);
      if (sealed) {
        if (!needsFullBuild.has(node.id)) {
          emitInvisibleStub(node);
        } else {
          emitLayer(buildPrecompContainer(node, nestedCompLayers(node, ref) ?? undefined), node);
        }
      }
      continue;
    }
    // Groups / nulls / cameras / audio are structural — they never draw.
    if (kind === 'group' || kind === 'null' || kind === 'camera' || kind === 'audio') continue;
    // Live-boolean operands stay in the scene for editing/animation but paint
    // only through their result layer — skipping here is what keeps the merge
    // from double-drawing the sources.
    if (isBooleanOperand(node)) continue;

    // AE-style layer in/out points: when the timeline has clip bars for this
    // node and NONE is active at the current frame, the layer sits outside its
    // trimmed range and must not draw. Safe now that remapOf maps sampling
    // through clip.sourceFrameAt for active clips — gating and retime agree.
    // The gate frame clamps to the last comp frame so a full-length layer
    // doesn't blink out at the exactly-end playhead (clip spans are
    // end-exclusive).
    // `isLiveAt` (hoisted above the camera block) holds the end-exclusive clamp
    // and the reasoning behind it; the camera selection applies the same test.
    if (!isLiveAt(node.id)) continue;

    // Draft 3D: light layers draw nothing (their glow wash IS lighting).
    if (kind === 'light' && comp.draft3d) continue;

    // Hidden / un-soloed: keep a stack stub, skip the expensive materialize.
    if (!needsFullBuild.has(node.id)) {
      emitInvisibleStub(node);
      continue;
    }

    // Light: a radial glow at its world position, composited (screen) to
    // brighten what's beneath. Intensity / radius are keyframeable.
    if (kind === 'light') {
      const av = valuesOf(node.id);
      const lt = readNodeLight(node);
      // PROJECT the glow through the current view. The wash used to be emitted
      // at the light's raw comp x/y, so it ignored both the light's depth and
      // the active view entirely: switch to Left view and every layer moved
      // while the glow stayed nailed to the same screen position, and pushing a
      // light forward or back in Z changed nothing about where it appeared.
      //
      // Ambient lifts the whole frame uniformly and has no position to project,
      // so it stays centred — projecting it would make a whole-frame wash slide
      // off the frame.
      //
      // ONE light, ONE resolver. The wash used to take `worldTransformOf` (the
      // 2D world affine) for x/y plus the RAW LOCAL z, while `sceneLights` and
      // `shadowLight` took `nodeWorldPosition` (the parent-aware 4×4). So a
      // light under a 3D null lit the scene from one place and glowed from
      // another, and the wash ignored the parent's depth entirely. This is the
      // remaining half of a bug already fixed at the other two call sites.
      const wp = nodeWorldPosition(node);
      const lp = lt.type === 'ambient'
        ? { x: comp.width / 2, y: comp.height / 2, scale: 1 }
        : project(wp);
      // The aim rides the QUAD, not the texture. The cone used to be baked into
      // the 512² wash canvas from `angle`, so every degree of rotation threw the
      // cached texture away and re-rasterized a quarter-million pixels on the
      // CPU — a scrub of Direction, or any rotation keyframe, re-baked on every
      // frame. Rotating the renderable instead makes the sweep a matrix change,
      // and lets the texture be cached across the whole rotation.
      const aimDeg = nodeLightAimDeg(node, lt);
      const shape = {
        falloff: lt.falloff,
        radius: av?.get('radius') ?? lt.radius,
        falloffDistance: av?.get('falloffDistance') ?? lt.falloffDistance,
      };
      // How far the light carries. Used ONLY to size a parallel light's landed
      // pool below — the fixture glow is drawn at its authored radius, because
      // that is what the reference frames were captured against.
      const reach = lightReach(shape);
      // NOT scaled by the light's own perspective. That was tried and it is
      // wrong: `radius` is authored in COMP PIXELS (it is what the inspector
      // dials and what the reference frames were drawn against), so multiplying
      // the quad by the scale at the emitter's depth made a light anywhere near
      // the camera flood the whole frame with flat colour — a 500px radius at
      // z = -400 became an 1667px quad on a 480x360 comp, wiping out its own
      // falloff and screen-blending every other layer toward white.
      //
      // A POOL is different and does take the projection: it is a real footprint
      // measured on a plane at a known depth, so its size genuinely is a world
      // quantity. See the beam projection below.
      const washLayer: RenderLayer = {
        id: node.id, kind: 'shape',
        x: lp.x, y: lp.y, rotation: aimDeg, scaleX: 1, scaleY: 1, depth: 0,
        opacity: 1, width: comp.width, height: comp.height,
        fill: '#000', visible: node.visible !== false,
        light: {
          color: lt.color,
          intensity: av?.get('intensity') ?? lt.intensity,
          radius: shape.radius,
          screenRadius: shape.radius,
          type: lt.type,
          cone: av?.get('lightCone') ?? lt.cone,
          // Without this the wash had no feather to apply and a spot's soft
          // edge was unreachable from the inspector — see rasterizeLight.
          coneFeather: av?.get('lightConeFeather') ?? lt.coneFeather,
        },
      };
      emitLayer(washLayer, node);
      // Aimed lights get a second look once the walk knows where the lit planes
      // are — see the beam projection below.
      if (lt.type === 'spot' || lt.type === 'parallel') {
        washLights.push({ nodeId: node.id, layer: washLayer, reach });
      }
      continue;
    }

    // Particle emitter: a self-drawing layer. buildSnapshot resolves its world
    // transform (so the layer moves/rotates the whole system) and attaches the
    // config; the backend simulates it deterministically at the current time.
    if (kind === 'particle') {
      const w = worldTransformOf(node.id, localOf, parentOf, worldCache);
      const staticCfg = readNodeParticle(node);
      const pv = valuesOf(node.id);
      const pOpacity = pv?.has('opacity') ? (pv.get('opacity') as number) / 100 : 1;
      const pEvalMap: Record<string, unknown> = {};
      if (pv) {
        for (const [k, val] of pv.entries()) pEvalMap[k] = val;
      }
      const geom = readGeometry(node, pEvalMap);
      const pW = geom?.width ?? staticCfg?.emitterWidth ?? 400;
      const pH = geom?.height ?? staticCfg?.emitterHeight ?? 400;

      if (staticCfg) {
        // Keep emitterWidth and emitterHeight synced with particle layer width & height
        const syncedCfg = {
          ...staticCfg,
          emitterWidth: pW,
          emitterHeight: pH,
        };
        const cfg = resolveParticleConfig(syncedCfg, (path) => pv?.get(path));
        emitLayer({
          id: node.id, kind: 'shape',
          x: w.x, y: w.y, rotation: w.rotation, scaleX: w.scaleX, scaleY: w.scaleY, depth: 0,
          opacity: pOpacity, width: pW, height: pH,
          fill: '#000', visible: node.visible !== false,
          blend: readNodeBlend(node),
      ...(readNodePreserveTransparency(node) ? { preserveTransparency: true } : {}),
          particles: cfg,
        }, node);
      }
      continue;
    }

    const base = readBase(node);
    const a = valuesOf(node.id);
    const world = worldTransformOf(node.id, localOf, parentOf, worldCache);
    const scaleX = world.scaleX;
    const scaleY = world.scaleY;
    // An SVG layer is a stored vector document, rasterized to a texture — it
    // composites exactly like an image, so it rides the image path and inherits
    // transform / opacity / blend / mask / matte / effects / 3D unchanged.
    const layerKind = kind === 'svg'
      ? 'image'
      : (kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video')
        ? kind
        : 'shape';
    const size = SIZE[layerKind];
    const name = (node.name ?? '').toLowerCase();
    const ghost = focus?.isGhost(node.id) ?? false;
    // Cloner: MULTIPLIES the resolved opacity rather than replacing it, so a
    // clone of a 50%-opacity layer at the faded end of a step ramp is fainter
    // than the source rather than equal to the ramp value. Same reasoning as
    // scale below — a cloner describes a variation ON the layer, not a
    // substitute for it. Additive/multiplicative is also why this cannot use
    // the Essential Properties suppression path, which REPLACES.
    const cloneOff = cloneOffsetOf(node);
    const baseOpacity = (a?.has('opacity') ? (a.get('opacity') as number) / 100 : base.opacity)
      * (cloneOff ? cloneOff.opacity / 100 : 1);
    // Resolve effect amounts once (keyframed → sampled) — the CSS `filter` for
    // Canvas2D, and the structured list attached to the layer for the GPU path.
    // readNodeRenderEffects (not readNodeEffects) so the layer's `fx` switch
    // actually silences the stack — it had no reader at all before.
    // Layer styles are STRUCTURED effects appended after the layer's own stack.
    //
    // They used to be folded into the CSS `filter` string below, which no
    // backend reads — so Drop Shadow and Outer Glow rendered nothing at all,
    // and every style preset that specified them (Glass, Neon, Sticker, Long
    // Shadow, …) shipped its fills without its depth. Appending rather than
    // prepending matches AE: layer styles evaluate after effects.
    //
    // Both go through ONE sampler pass (`effectsAndStyles`), which is what makes
    // layer-style parameters keyframeable at all.
    const { own: ownEffects, all: resolvedEffects } = effectsAndStyles(node, a, remapOf(node.id)(t));
    // The CSS form is retained for export/legacy readers only; `RenderLayer.
    // filter` is not consulted by any render path. It deliberately describes
    // the layer's OWN effects, not its styles, so the two cannot double-apply
    // if a future consumer starts reading it.
    const filter = effectsToFilter(ownEffects) || undefined;

    // A solid layer fills the whole composition by default, but remains a
    // normal transformable shape once seeded — pinning x/y/scale made the
    // selection blueprint sit at makeNode's 100×100 while the fill covered the
    // frame, and scale/drag writes never showed.
    const isSolid = node.components.find((c) => c.type === 'fx')?.props.solid === true;
    const geomComponent = node.components.find((c) => c.type === 'Geometry');
    const staticPathPoints = geomComponent?.props.points as import('../../../packages/workspace/src/math/BezierPoint').BezierPoint[] | undefined;
    // Animated outline (data track) beats the static Geometry component — this
    // is how baked/imported vector paths (e.g. Lottie character rigs) animate
    // their vertices frame-to-frame. Mirrors the fill.stops / text.source
    // overrides below. DataPoint handles are optional; a corner collapses them
    // onto the vertex, matching BezierPoint's absolute-handle contract.
    const livePathPts = anim.sampleData(node.id, 'path.points', remapOf(node.id)(t));
    const liveOutline =
      Array.isArray(livePathPts) && livePathPts.length > 1 &&
      typeof livePathPts[0] === 'object' && livePathPts[0] !== null && 'x' in (livePathPts[0] as object)
        ? (livePathPts as Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>).map(
            (p) => ({ x: p.x, y: p.y, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y }),
          )
        : undefined;
    /**
     * Stored RUNS — a path that is several outlines rather than one.
     *
     * The SVG importer writes these for any `d` with more than one `M`: the
     * hole in a donut, the counter in an "o", any icon with a gap. `points` is
     * the single-run shorthand, and the two are mutually exclusive (see
     * raster/subpaths.ts), so a node carrying runs must not carry the flat list.
     * A live `path.points` track still wins — it is one animated outline.
     */
    let staticSubpaths = liveOutline
      ? undefined
      : (geomComponent?.props.subpaths as Array<{ points: typeof staticPathPoints; open?: boolean }> | undefined);
    let pathPoints = liveOutline
      ?? staticPathPoints
      // The first run stands in wherever a single outline is wanted (the
      // `primitive` choice, the rig silhouette). The full set is installed on
      // the layer below, and is what actually gets drawn.
      ?? staticSubpaths?.[0]?.points;
    /**
     * POINTS FOLLOW NULLS — AE's other Create-Nulls-From-Paths direction.
     *
     * `pointBindings` on the Geometry names, per vertex index, a null layer
     * whose position that vertex should track. Resolved HERE, per frame, from
     * the null's world position pulled into this layer's local space, so the
     * outline follows the nulls live through any parenting — the null can be
     * parented elsewhere, rigged, keyframed, and the path keeps up. A
     * render-time resolver rather than an expression because the expression
     * language has no data-track form; this is the honest live version, not a
     * one-shot copy that looks live and then is not.
     *
     * Handles move with their vertex (same delta), so a smooth corner stays
     * smooth as it is dragged.
     */
    const pointBindings = geomComponent?.props.pointBindings as
      | ReadonlyArray<{ index: number; nullId: string }>
      | undefined;
    if (pointBindings && pointBindings.length > 0 && pathPoints && pathPoints.length > 0) {
      const shapeW = worldMatrixOf(node.id, rawLocalOf, rawParentOf, rawWorldCache);
      if (shapeW) {
        const inv = Matrix.invert(shapeW);
        const moved = pathPoints.map((p) => ({ ...p }));
        let any = false;
        for (const b of pointBindings) {
          const pt = moved[b.index];
          if (!pt || !graph.getNode(b.nullId)) continue;
          const nullW = worldMatrixOf(b.nullId, rawLocalOf, rawParentOf, rawWorldCache);
          if (!nullW) continue;
          const local = Matrix.transformPoint(inv, { x: nullW.e, y: nullW.f });
          const dx = local.x - pt.x, dy = local.y - pt.y;
          if (dx === 0 && dy === 0) continue;
          pt.x += dx; pt.y += dy;
          pt.inX += dx; pt.inY += dy;
          pt.outX += dx; pt.outY += dy;
          any = true;
        }
        if (any) pathPoints = moved;
      }
    }
    // Open strokes (line / freehand pencil) must not be closed into a loop.
    const pathOpen = geomComponent?.props.open === true;
    // Explicit shape type set at insert time; falls back to the legacy
    // name heuristic for older nodes that never carried one.
    const shapeType = node.components.find((c) => c.type === 'Transform')?.props.shapeType as string | undefined;
    
    const evalMap: Record<string, unknown> = {};
    if (a) {
      for (const [k, val] of a.entries()) evalMap[k] = val;
    }
    const measuredText = layerKind === 'text'
      ? measureTextNodeSize(node, evalMap)
      : null;
    // A solid layer is a full-frame colour plate by default. Prefer authored
    // width/height when seeded (insertSolid / 3D enable); fall back to the
    // composition when dims are missing or still makeNode's 100×100.
    const rawW = a?.has('width') ? (a.get('width') as number) : base.width;
    const rawH = a?.has('height') ? (a.get('height') as number) : base.height;
    const solidUnseeded = isSolid && (
      typeof rawW !== 'number'
      || typeof rawH !== 'number'
      || (rawW === 100 && rawH === 100)
    );
    // The `typeof` re-tests are redundant with `solidUnseeded` — which is
    // already true whenever either dimension is not a number — but the compiler
    // cannot narrow `rawW`/`rawH` through a separate boolean const, and without
    // them `layerW`/`layerH` widen to `number | undefined` and poison every
    // geometry call downstream.
    let layerW = isSolid
      ? (solidUnseeded || typeof rawW !== 'number' ? comp.width : rawW)
      : (measuredText?.w ?? (typeof rawW === 'number' ? rawW : size.w));
    let layerH = isSolid
      ? (solidUnseeded || typeof rawH !== 'number' ? comp.height : rawH)
      : (measuredText?.h ?? (typeof rawH === 'number' ? rawH : size.h));

    // Audio Waveform generator (envelope, not spectrum): a referenced audio
    // layer's precomputed peaks become this shape's live outline. Overrides any
    // static/animated path — the shape IS the waveform. Degenerate (draws
    // nothing) until the source audio has decoded. Needs layerW/H, so it runs
    // after they are resolved.
    const audioWaveformCfg = readNodeAudioWaveform(node);
    if (audioWaveformCfg) {
      pathPoints = resolveAudioWaveformPoints(audioWaveformCfg, layerW, layerH, remapOf(node.id)(t));
    }

    // Live Merge Paths: re-evaluate the boolean from animated operands each
    // frame. Geometry is world-space → recentred onto the result layer.
    let liveBooleanPose: { cx: number; cy: number; width: number; height: number } | null = null;
    if (readLiveBoolean(node)) {
      const ev = evaluateLiveBoolean(
        node,
        (id) => graph.getNode(id),
        (id) => {
          // WORLD pose so parented operands (null rigs, groups) stay correct.
          const w = worldTransformOf(id, localOf, parentOf, worldCache);
          const m = valuesOf(id);
          return (prop) => {
            if (prop === 'x') return w.x;
            if (prop === 'y') return w.y;
            if (prop === 'rotation') return w.rotation;
            if (prop === 'scaleX') return w.scaleX;
            if (prop === 'scaleY') return w.scaleY;
            return m.get(prop);
          };
        },
        (id) => () => {
          // Each source samples at ITS own remapped time — using the result's
          // remap made time-stretched operands freeze relative to the merge.
          const remapped = remapOf(id)(t);
          const pts = anim.sampleData(id, 'path.points', remapped);
          if (!Array.isArray(pts) || pts.length < 3) return undefined;
          if (typeof pts[0] !== 'object' || pts[0] === null || !('x' in (pts[0] as object))) return undefined;
          return (pts as Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>).map(
            (p) => ({ x: p.x, y: p.y, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y }),
          );
        },
      );
      if (ev) {
        pathPoints = ev.points;
        liveBooleanPose = { cx: ev.cx, cy: ev.cy, width: ev.width, height: ev.height };
        // Compound boolean (holes / islands): install as stored runs so the
        // fill winding can cut holes. Single-ring results keep the shorthand.
        if (ev.subpaths && ev.subpaths.length > 1) {
          staticSubpaths = ev.subpaths;
          pathPoints = ev.subpaths[0]!.points;
        }
      }
    }

    // Project 3D layers through the camera into a full 2×3 affine, so X/Y
    // rotation produces real perspective tilt/shear (not just a squish). The
    // affine is derived from three projected points — the layer's local origin
    // and unit axes — through the layer's 3D world matrix. Z-rotation, xy-scale,
    // z-depth (scale + parallax) and tilt all fall out of it. `x/y/scaleX/scaleY/
    // rotation` are kept as the decomposed fallback for hit-testing. (Motion
    // blur does NOT read them — the backend prefers `matrix`, so 3D samples
    // carry their own; see `matrixAt` below.)
    const d3 = readNode3D(node);
    const z3 = a?.get('z') ?? d3.z;
    const rotX = a?.get('rotationX') ?? d3.rotationX;
    const rotY = a?.get('rotationY') ?? d3.rotationY;
    // Orientation (composed before rotation) + anchor Z — all keyframeable,
    // all 0 by default so 2D layers and existing 3D layers are unaffected.
    const oriX = a?.get('orientationX') ?? d3.orientationX;
    const oriY = a?.get('orientationY') ?? d3.orientationY;
    const oriZ = a?.get('orientationZ') ?? d3.orientationZ;
    const anchorZ = a?.get('anchorZ') ?? d3.anchorZ;
    // Extrusion depth (px): keyframeable via the same animated-value path as z.
    // > 0 turns the flat plane into a real 3D object (back cap + walls below).
    const extrusionDepth = Math.max(0, a?.get('extrusionDepth') ?? d3.extrusionDepth);
    // Solids may take the 3D switch (AE parity): un-switched solids stay pinned
    // full-comp exactly as before; a switched solid un-pins onto its own
    // transform and projects like any layer.
    const is3D = is3DEnabled(node);
    // Depth scale. Animated track wins, then the static prop, then 1.
    const scaleZ = (() => {
      const anim3 = a?.get('scaleZ');
      if (typeof anim3 === 'number') return anim3;
      const base3 = node.components.find((c) => c.type === 'Transform')?.props.scaleZ;
      return typeof base3 === 'number' ? base3 : 1;
    })();
    // A 3D ancestor drives this layer through the 4×4 chain, so its own
    // transform must be LOCAL — `world` has the parent already baked in, and
    // using it here would apply the parent twice. Null (no 3D ancestor) keeps
    // the ordinary 2D-composed path exactly as before.
    const parent3d = is3D ? parent3dOf(node.id) : null;
    const ownX = parent3d ? (a?.get('x') ?? base.x) : world.x;
    const ownY = parent3d ? (a?.get('y') ?? base.y) : world.y;
    const ownRot = parent3d ? (a?.get('rotation') ?? base.rotation) : world.rotation;
    const ownScaleX = parent3d ? (a?.get('scaleX') ?? a?.get('scale') ?? base.scaleX) : scaleX;
    const ownScaleY = parent3d ? (a?.get('scaleY') ?? a?.get('scale') ?? base.scaleY) : scaleY;

    let px = world.x;
    let py = world.y;
    let sx = scaleX;
    let sy = scaleY;
    let rot = world.rotation;
    /**
     * Physics REPLACES the position, where the cloner offsets it.
     *
     * A dynamic body's position IS the solver's output — there is nothing to
     * add it to. Keyframed x/y on a simulated layer is therefore overridden,
     * not blended: blending would produce a body that is neither where physics
     * put it nor where you keyframed it, and no way to tell which half was
     * responsible for any given frame. Static bodies are never in this map, so
     * a keyframed wall still animates and still collides.
     */
    const simPose = physicsPoses?.get(node.id);
    if (simPose) {
      px = simPose.x;
      py = simPose.y;
      // Present only for bodies that opted into spin — see physicsPosesAt.
      // A rotation-locked body keeps its own (possibly keyframed) rotation.
      if (simPose.rotation !== undefined) rot = simPose.rotation;
    }
    // Cloner offset, applied to the RESOLVED transform.
    //
    // It has to land here rather than be patched into the components, because a
    // cloner OFFSETS what the layer already resolves to — including its
    // animation. Patching `x` on the clone's Transform would be outvoted by a
    // keyframed x every frame (the dead-control shape compInstanceOverrides
    // documents), and suppressing the track instead would throw the animation
    // away, which is the opposite of what a cloner is for: the clones are meant
    // to move WITH the layer, spread apart from each other.
    if (cloneOff) {
      px += cloneOff.x;
      py += cloneOff.y;
      rot += cloneOff.rotation;
      sx *= cloneOff.scaleX;
      sy *= cloneOff.scaleY;
    }
    // Auto-orient (E4): a flagged, moving layer faces its direction of travel.
    if (!is3D && readNodeAutoOrient(node)) {
      const ang = autoOrientAngleDeg(node, remapOf(node.id)(t), anim);
      if (ang !== null) rot = ang;
    }
    /**
     * The layer's projected 2×3 affine at a given 3D transform. Extracted so
     * motion blur can rebuild it per sub-frame sample — the backend prefers
     * `matrix` over the decomposed x/y/rotation/scale, so without a per-sample
     * matrix a 3D layer's blur degenerates into N identical draws.
     */
    const affineAt = (
      wx: number, wy: number, wz: number,
      rX: number, rY: number, rZ: number,
      sX: number, sY: number,
      sZ = 1,
      // Camera motion blur: a sub-frame sample projects through the camera's
      // pose at ITS time, not the frame's. Defaults to the frame projector.
      proj: (p: { x: number; y: number; z: number }) => Project3D.Projected = project,
    ): { matrix: readonly [number, number, number, number, number, number]; O: Project3D.Projected; world: import('@motion/scene').Matrix4 } => {
      const L = Matrix4Math.compose({
        position: { x: wx, y: wy, z: wz },
        // AE composes Orientation THEN Rotation about the same anchor; summing
        // the euler angles per axis gives the identical composed facing. Anchor
        // x/y are applied at draw time (RenderLayer.anchorX/Y) so only anchorZ
        // enters the matrix — dropping it was why anchor-Z did nothing.
        rotation: { x: (rX + oriX) * DEG, y: (rY + oriY) * DEG, z: (rZ + oriZ) * DEG },
        // Depth scale, not a hardcoded 1. The timeline has always offered a
        // `scaleZ` stopwatch (App.tsx's 3D placeholder rows) and the gizmo tracks
        // it, but the matrix pinned z to 1 — so keyframing Scale Z animated
        // nothing at all. With it composed here it scales the extrusion body
        // along its depth axis, since the extrusion faces are built by
        // multiplying this same world matrix.
        scale: { x: sX, y: sY, z: sZ },
        anchor: { x: 0, y: 0, z: anchorZ },
      });
      // world = parentChain · local. With no 3D ancestor `parent3d` is null and
      // this is exactly the matrix that was composed before.
      const M = parent3d ? Matrix4Math.multiply(parent3d, L) : L;
      const O = proj(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
      const X = proj(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
      const Y = proj(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
      return { matrix: [X.x - O.x, X.y - O.y, Y.x - O.x, Y.y - O.y, O.x, O.y], O, world: M };
    };

    let matrix: readonly [number, number, number, number, number, number] | undefined;
    let world3d: readonly number[] | undefined;
    // Painter depth (distance from camera); far layers draw first.
    let depth = project({ x: world.x, y: world.y, z: z3 }).depth;
    // Auto-Orient → Toward Camera (AE's per-layer, opt-in billboard). The
    // layer's normal is its composed +Z axis, which for rotation order Rz·Ry·Rx
    // is exactly (sinY·cosX, −sinX, cosY·cosX) — the same expression
    // `lookAtOrientation` inverts. So aiming the layer at the eye is just that
    // look orientation, minus whatever Orientation already contributes (the
    // matrix composes rotation + orientation, so the two must not double up).
    let faceRotX = rotX;
    let faceRotY = rotY;
    if (is3D && camera && isAutoOrientedToCamera(node)) {
      const look = Project3D.lookAtOrientation({ x: world.x, y: world.y, z: z3 }, camera.position);
      faceRotX = look.pitch - oriX;
      faceRotY = look.yaw - oriY;
    }
    if (is3D) {
      const { matrix: m, O, world: M } = affineAt(ownX, ownY, z3, faceRotX, faceRotY, ownRot, ownScaleX, ownScaleY, scaleZ);
      // Behind the near plane ⇒ the layer is not in front of the camera and must
      // not be drawn. `projectPoint` CLAMPS rather than rejects (so the divide
      // stays finite for overlays), which meant a layer the camera had dollied
      // past resolved to focalLength/1 — a ~1111× scale for a 1920-wide comp,
      // i.e. one layer smeared opaque across the entire frame. Dropping it here
      // also drops it from the shadow caster/receiver lists below, which is
      // correct: an invisible layer casts nothing.
      //
      // This tests the layer's ORIGIN, so a large layer straddling the near
      // plane pops rather than clipping per-fragment. That is the Classic-3D
      // approximation this compositor makes everywhere (layers are whole quads,
      // not clipped geometry); true near-plane clipping needs the GPU path to
      // own it.
      if (O.clipped) continue;
      matrix = m;
      // The full 4×4 world matrix rides along for the GPU depth-tested path;
      // the projected affine stays as the universal fallback.
      world3d = M;
      px = O.x;
      py = O.y;
      sx = Math.hypot(m[0], m[1]);
      sy = Math.hypot(m[2], m[3]);
      rot = Math.atan2(m[1], m[0]) / DEG;
      depth = O.depth;
    }

    // Live boolean result rides the union centre each frame so animating an
    // operand moves the merge without baking. Identity scale — the outline is
    // already in world pixels.
    if (liveBooleanPose) {
      px = liveBooleanPose.cx;
      py = liveBooleanPose.cy;
      layerW = liveBooleanPose.width;
      layerH = liveBooleanPose.height;
      sx = 1;
      sy = 1;
      rot = 0;
      matrix = undefined;
      world3d = undefined;
    }

    let fillPaint = readNodeFill(node);
    if (fillPaint) {
      if (fillPaint.type === 'linear' && a?.has('fillAngle')) {
        fillPaint = { ...fillPaint, angle: a.get('fillAngle') ?? fillPaint.angle };
      } else if (fillPaint.type === 'radial') {
        const cx = a?.has('fillCenterX') ? a.get('fillCenterX')! : fillPaint.cx;
        const cy = a?.has('fillCenterY') ? a.get('fillCenterY')! : fillPaint.cy;
        const radius = a?.has('fillRadius') ? a.get('fillRadius')! : fillPaint.radius;
        fillPaint = { ...fillPaint, cx, cy, radius };
      }
      // Keyframed gradient stops (data track): the whole stop list animates —
      // per-stop position AND color — which scalar tracks could never express.
      // Engine stops are {pos, color}; the paint model wants ColorStop with an
      // id, so mint stable positional ids.
      if (fillPaint.type === 'linear' || fillPaint.type === 'radial') {
        const liveStops = anim.sampleData(node.id, 'fill.stops', remapOf(node.id)(t));
        if (Array.isArray(liveStops) && liveStops.length > 0 && typeof liveStops[0] === 'object' && 'pos' in (liveStops[0] as object)) {
          fillPaint = {
            ...fillPaint,
            stops: (liveStops as { pos: number; color: string }[]).map((s, i) => ({
              id: `anim_${i}`,
              offset: s.pos,
              color: s.color,
            })),
          };
        }
      }
    }
    // Textured kinds have no fallback fill: for an SVG layer `fill` is a RECOLOUR
    // override the rasterizer paints over every path (see AppTextureProvider's
    // rasterizeSvg), so defaulting it to the kind's category colour would render
    // every imported SVG as a flat teal silhouette.
    let finalFill = base.fill
      ?? (kind === 'image' || kind === 'video' || kind === 'svg' ? undefined : KIND_FILL[kind]);
    // A solid paint set via the Fill & Stroke panel lives on the fx component
    // and must beat the legacy Style fill string — Canvas2D's fillStyleFor
    // resolves solid paints to this fallback string, so bake it in here.
    if (fillPaint?.type === 'solid' && typeof fillPaint.color === 'string') {
      finalFill = fillPaint.color;
    }
    if (a?.has('fill_r')) {
      const r = a.get('fill_r') ?? 0;
      const g = a.get('fill_g') ?? 0;
      const b = a.get('fill_b') ?? 0;
      const alpha = a.get('fill_a') ?? 1;
      finalFill = Color.toHex({ r, g, b, a: alpha });
    } else if (layerKind === 'text' && a?.has('color_r')) {
      // Legacy documents animated text color via color_* tracks, but the text
      // renderers draw with layer.fill — honor those old tracks as fill.
      const r = a.get('color_r') ?? 0;
      const g = a.get('color_g') ?? 0;
      const b = a.get('color_b') ?? 0;
      const alpha = a.get('color_a') ?? 1;
      finalFill = Color.toHex({ r, g, b, a: alpha });
    }

    const baseStroke = readNodeStroke(node);
    let finalStroke = baseStroke;
    // Dash offset folds in exactly the way the stroke colour does — sampled off
    // the animated-value map and written into the RESOLVED stroke rather than
    // read from the stored object.
    if (baseStroke && a?.has('strokeDashOffset')) {
      finalStroke = { ...baseStroke, dashOffset: a.get('strokeDashOffset') ?? 0 };
    }
    // F34, FIXED. `strokeWidth` was registered as keyframeable in
    // `propertyMeta`, offered a stopwatch by the inspector and the timeline, and
    // sampled by NOTHING for a shape stroke — a 6→40 ramp rendered 5296 stroke
    // pixels at both ends. The comment that used to sit here cited that as the
    // reason dash offset did NOT copy its shape; the honest fix is to make
    // `strokeWidth` behave like dash offset rather than to keep a second
    // pattern alive as a warning.
    //
    // Chained off `finalStroke` for the reason stated below it: width, colour
    // and dash offset can all be animated on one layer.
    if (finalStroke && a?.has('strokeWidth')) {
      const w = a.get('strokeWidth');
      // A negative width is not a thinner stroke, it is a Canvas2D exception —
      // and the property's own `min: 0` says so. Clamp rather than trust the
      // curve, since an overshooting ease can undershoot zero between keys.
      if (typeof w === 'number' && Number.isFinite(w)) {
        finalStroke = { ...finalStroke, width: Math.max(0, w) };
      }
    }
    // Taper and Wave. Nine tracks, folded HERE for the same reason every other
    // stroke track is: `propertyMeta` gives them a stopwatch, and a stopwatch
    // the renderer never samples is F34/F35 — twice on this board already.
    //
    // Each falls back to the STORED profile rather than to a constant, so a
    // taper authored statically survives when only one of its nine is animated.
    if (finalStroke && a) {
      const t = finalStroke.taper;
      const num = (k: string, fallback: number): number => {
        const v = a.get(k);
        return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
      };
      if (
        a.has('strokeTaperStartWidth') || a.has('strokeTaperEndWidth') ||
        a.has('strokeTaperStartLength') || a.has('strokeTaperEndLength') ||
        a.has('strokeTaperStartEase') || a.has('strokeTaperEndEase')
      ) {
        finalStroke = { ...finalStroke, taper: {
          startWidth: num('strokeTaperStartWidth', t?.startWidth ?? 1),
          endWidth: num('strokeTaperEndWidth', t?.endWidth ?? 1),
          startLength: num('strokeTaperStartLength', t?.startLength ?? 0),
          endLength: num('strokeTaperEndLength', t?.endLength ?? 0),
          startEase: num('strokeTaperStartEase', t?.startEase ?? 0),
          endEase: num('strokeTaperEndEase', t?.endEase ?? 0),
        } };
      }
      const wv = finalStroke.wave;
      if (a.has('strokeWaveAmount') || a.has('strokeWaveWavelength') || a.has('strokeWavePhase')) {
        finalStroke = { ...finalStroke, wave: {
          amount: num('strokeWaveAmount', wv?.amount ?? 0),
          wavelength: num('strokeWaveWavelength', wv?.wavelength ?? 0),
          phase: num('strokeWavePhase', wv?.phase ?? 0),
        } };
      }
    }
    // Chained off `finalStroke`, not `baseStroke`: colour and dash offset can be
    // animated on the same layer, and rebuilding from `baseStroke` here would
    // silently drop whichever was applied first.
    if (finalStroke && a?.has('stroke_r')) {
      const r = a.get('stroke_r') ?? 0;
      const g = a.get('stroke_g') ?? 0;
      const b = a.get('stroke_b') ?? 0;
      const alpha = a.get('stroke_a') ?? 1;
      finalStroke = { ...finalStroke, color: Color.toHex({ r, g, b, a: alpha }) };
    }

    // Multi-fill / multi-stroke stacks. Animated tracks (fill_* / stroke_* /
    // fillAngle/…) bind to entry 0 only — the resolved primary above replaces
    // the stack's first entry so animation stays honoured.
    const fillStack = readNodeFills(node);
    const fillPaints =
      fillStack.length > 1
        ? [fillPaint ?? fillStack[0]!, ...fillStack.slice(1)]
        : undefined;
    const strokeStack = readNodeRenderStrokes(node);
    const strokes =
      strokeStack.length > 1
        ? [...(finalStroke ? [finalStroke] : []), ...strokeStack.slice(1)]
        : undefined;

    // Appearance / paint stroke is drawn into the shape raster for vectors, but
    // image / video / text upload a texture and never stroke that geometry — so
    // enabling Stroke in Fill & Stroke was a silent no-op on photos. Compile it
    // to the same GPU `stroke` effect Layer Styles use (silhouette outline),
    // unless a Layer Styles stroke is already present.
    if (
      (layerKind === 'image' || layerKind === 'video' || layerKind === 'text')
      && finalStroke?.enabled
      && finalStroke.width > 0
      && finalStroke.opacity > 0
      && !resolvedEffects.some((e) => e.type === 'stroke' && e.enabled !== false)
    ) {
      resolvedEffects.push({
        id: 'paintstroke:primary',
        type: 'stroke',
        enabled: true,
        params: {
          width: Math.max(0, finalStroke.width),
          color: finalStroke.color,
          opacity: Math.round(Math.max(0, Math.min(1, finalStroke.opacity)) * 100),
        },
      });
    }

    // Same trap for Fill: textured layers ignore Appearance fillPaint (they
    // sample the asset). Map a solid/gradient paint onto the GPU fill /
    // gradient-ramp effects so the Appearance panel actually recolours photos.
    if (
      (layerKind === 'image' || layerKind === 'video')
      && fillPaint
      && !resolvedEffects.some((e) =>
        (e.type === 'fill' || e.type === 'gradient-ramp') && e.enabled !== false)
    ) {
      if (fillPaint.type === 'solid' && typeof fillPaint.color === 'string') {
        resolvedEffects.push({
          id: 'paintfill:primary',
          type: 'fill',
          enabled: true,
          params: { color: fillPaint.color, opacity: 100 },
        });
      } else if (
        (fillPaint.type === 'linear' || fillPaint.type === 'radial')
        && Array.isArray(fillPaint.stops)
        && fillPaint.stops.length >= 2
      ) {
        const aStop = fillPaint.stops[0]!;
        const bStop = fillPaint.stops[fillPaint.stops.length - 1]!;
        resolvedEffects.push({
          id: 'paintfill:primary',
          type: 'gradient-ramp',
          enabled: true,
          params: {
            colorA: aStop.color,
            colorB: bStop.color,
            angle: fillPaint.type === 'linear' ? (fillPaint.angle ?? 90) : 90,
            blend: 100,
          },
        });
      }
    }

    // Corner radius on image/video: textured quads have no SDF, so Appearance →
    // Corners was a silent no-op. Synthesize a rounded-rect mask (intersected
    // with any authored mask) so the GPU mask path clips the photo.
    // Per-corner radii (TL/TR/BR/BL) win over the uniform `cornerRadius`.
    const sampleCorner = (key: string, fallback: number | undefined): number | undefined => {
      const live = a?.get(key);
      if (typeof live === 'number' && Number.isFinite(live)) return Math.max(0, live);
      return typeof fallback === 'number' && Number.isFinite(fallback) ? Math.max(0, fallback) : undefined;
    };
    const resolvedCornerRadii: CornerRadiiTuple = clampCornerRadii(
      layerW,
      layerH,
      resolveCornerRadii({
        cornerRadius: sampleCorner('cornerRadius', base.cornerRadius),
        cornerRadiusTL: sampleCorner('cornerRadiusTL', base.cornerRadiusTL),
        cornerRadiusTR: sampleCorner('cornerRadiusTR', base.cornerRadiusTR),
        cornerRadiusBR: sampleCorner('cornerRadiusBR', base.cornerRadiusBR),
        cornerRadiusBL: sampleCorner('cornerRadiusBL', base.cornerRadiusBL),
      }),
    );
    const resolvedCornerRadius = Math.max(
      resolvedCornerRadii[0],
      resolvedCornerRadii[1],
      resolvedCornerRadii[2],
      resolvedCornerRadii[3],
    );
    // Shape from the mask's own track, then Feather / Opacity / Expansion from
    // their per-path numeric tracks (AE's four mask properties, minus Path
    // which the shape track already is).
    let resolvedMask: LayerMask | undefined = applyMaskPropertyTracks(readNodeMaskAt(node, remapOf(node.id)(t)), a);
    if (
      (layerKind === 'image' || layerKind === 'video')
      && resolvedCornerRadius > 0.5
      && layerW > 0
      && layerH > 0
    ) {
      const round = roundedRectMask(layerW, layerH, resolvedCornerRadii);
      if (!resolvedMask || resolvedMask.paths.length === 0) {
        resolvedMask = { paths: [round] };
      } else {
        resolvedMask = {
          paths: [...resolvedMask.paths, { ...round, mode: 'intersect' as const }],
        };
      }
    }

    let finalColor = base.color;
    if (a?.has('color_r')) {
      const r = a.get('color_r') ?? 0;
      const g = a.get('color_g') ?? 0;
      const b = a.get('color_b') ?? 0;
      const alpha = a.get('color_a') ?? 1;
      finalColor = Color.toHex({ r, g, b, a: alpha });
    }

    // Resolved once — the object literal below needs it in two places, and
    // resolving twice per layer per frame is pure waste.
    const glass = resolveGlass(readNodeLayerStyles(node)?.glass, a, globalLight.angle);

    const layer: RenderLayer = {
      id: node.id,
      kind: layerKind,
      blend: readNodeBlend(node),
      ...(readNodePreserveTransparency(node) ? { preserveTransparency: true } : {}),
      mask: resolvedMask,
      matte: readNodeMatte(node),
      isAdjustment: readNodeAdjustment(node) || undefined,
      quality: readNodeQuality(node) === 'draft' ? 'draft' : undefined,
      paint: readNodePaint(node) ?? undefined,
      contentAwareFillSrc: contentAwareFillAt(node, remapOf(node.id)(t)) ?? undefined,
      sourceTime: (() => {
        const remapped = anim.sample(node.id, 'timeRemap', t) ?? anim.sample(node.id, 'precompTime', t);
        if (remapped !== undefined) return remapOf(node.id)(remapped);
        return remapOf(node.id)(t);
      })(),
      // Frame blending. This is the read that had been missing since the flag
      // was added: the dropdown wrote `frameBlend` and no renderer ever looked
      // at it. Resolved to bracket times here because only buildSnapshot knows
      // the comp's frame rate. Emitted only when the layer asks for it and only
      // for footage — blending a shape would mean nothing, its "frames" are
      // continuous keyframes.
      frameBlend: (() => {
        const fbMode = readNodeLayerTime(node)?.frameBlend;
        if (fbMode !== 'mix' && fbMode !== 'pixelMotion') return undefined;
        if (layerKind !== 'video') return undefined;
        const st = (() => {
          const remapped = anim.sample(node.id, 'timeRemap', t) ?? anim.sample(node.id, 'precompTime', t);
          return remapOf(node.id)(remapped !== undefined ? remapped : t);
        })();
        // Bracket on the SOURCE's rate when we know it. This was the documented
        // KNOWN LIMIT in videoFrameCache: nothing in the browser reports a
        // `<video>`'s frame rate, so the bracket fell back to the composition's
        // and a 24fps source in a 30fps comp had both bracket times resolve to
        // the same decoded frame — the blend silently collapsed to nearest-frame
        // for exactly the mismatched-rate case frame blending exists to fix.
        // The desktop ffmpeg probe (and Interpret Footage ▸ Conform) now supply
        // the real rate; `fps` remains the fallback when neither has run, which
        // is the behaviour every existing project already has.
        const sourceFps = footageSourceOf(node)?.fps ?? fps;
        const bracket = bracketFrames(st, sourceFps);
        // Exactly on a frame boundary there is nothing to blend toward.
        return bracket.weight > 1e-3 ? { ...bracket, mode: fbMode } : undefined;
      })(),
      // Fill opacity — stored 0..100 like `opacity`, emitted 0..1. Absent
      // stays undefined rather than defaulting to 1, so a layer that never
      // touched it does not get routed down the CPU-bake path.
      fillOpacity: (() => {
        const v = a?.get('fillOpacity') ?? readNumProp(node, 'fillOpacity');
        return typeof v === 'number' ? Math.max(0, Math.min(1, v / 100)) : undefined;
      })(),
      // Skew — animatable like every other transform property, so it reads
      // from the sampled values first and the static prop second.
      skew: a?.get('skew') ?? readNumProp(node, 'skew'),
      skewAxis: a?.get('skewAxis') ?? readNumProp(node, 'skewAxis'),
      // Continuous Rasterization. Emitted only when ON, so a layer without the
      // switch carries no field and the snapshot is unchanged from before this
      // feature existed. Gated on `supportsContinuousRaster` here rather than
      // trusted from the prop, so a stray flag on an image layer cannot make the
      // provider allocate a 64MB raster that cannot look any better.
      ...(readContinuousRaster(node) && supportsContinuousRaster(node)
        ? { continuousRaster: true }
        : {}),
      // Corner Pin. Read here (identity/degenerate pins already collapse to
      // undefined) and warped onto the render mvp in snapshotToFrameScene; export
      // and preview share this path, so a pinned layer is perspective-correct in
      // both. Absent = affine, snapshot unchanged from before the feature.
      ...(readNodeCornerPin(node) ? { cornerPin: readNodeCornerPin(node) } : {}),
      // Legacy unseeded solids still lack a real transform — keep them
      // full-frame until the user resizes. Seeded solids transform normally.
      x: isSolid && !is3D && solidUnseeded ? comp.width / 2 : px,
      y: isSolid && !is3D && solidUnseeded ? comp.height / 2 : py,
      rotation: isSolid && !is3D && solidUnseeded ? 0 : rot,
      scaleX: isSolid && !is3D && solidUnseeded ? 1 : sx,
      scaleY: isSolid && !is3D && solidUnseeded ? 1 : sy,
      matrix: isSolid && !is3D && solidUnseeded ? undefined : matrix,
      world3d: isSolid && !is3D && solidUnseeded ? undefined : world3d,
      depth,
      opacity: ghost ? baseOpacity * GHOST_OPACITY : baseOpacity,
      width: layerW,
      height: layerH,
      fill: finalFill,
      fillPaint,
      fillPaints,
      stroke: finalStroke,
      strokes,
      color: finalColor,
      // Guide layers fold into the SAME visibility decision as the eye toggle
      // and solo, rather than filtering the node list earlier. Three rules,
      // one expression, so there is no second place for them to disagree —
      // and the layer is still BUILT either way, just marked invisible, so
      // every downstream consumer takes the path it already takes for a hidden
      // layer instead of meeting a gap in the list.
      visible: node.visible !== false
        && (!anySolo || node.solo === true)
        && !(comp.forExport === true && readIsGuideLayer(node)),
      primitive: pathPoints
        ? 'path'
        : isSolid
          ? 'rect'
          : (shapeType === 'ellipse' || (!shapeType && /circle|ellip|dot|orb/.test(name)))
            ? 'ellipse'
            : 'rect',
      // F35, FIXED. `cornerRadius` was registered keyframeable in `propertyMeta`
      // and its animated track was folded NOWHERE — the STATIC value is read by
      // the component scan, so a rounded rect drew correctly and a keyframed
      // corner radius simply did not move. Found by the derived sweep added with
      // F34 (`animatablePropertyReaders.test.ts`): same class, and the same
      // one-line shape as the `backdropBlur` fold immediately below.
      //
      // Clamped at 0 for the reason `strokeWidth` is: an overshooting ease
      // undershoots between keys, and a negative radius is a Canvas2D exception
      // rather than a sharper corner. The property's own `min: 0` agrees.
      // Per-corner radii ride alongside for Appearance → individual corners;
      // uniform SDF still reads `cornerRadius` when all four match.
      cornerRadius: resolvedCornerRadius,
      ...(resolvedCornerRadius > 0 || hasIndependentCornerRadii(resolvedCornerRadii)
        ? { cornerRadii: resolvedCornerRadii }
        : {}),
      // The scale the raster will be stretched by, so the shape path can undo
      // it for the CORNERS alone — see `RenderLayer.cornerRadiusScale`. `sx`/
      // `sy` are the effective (world / projected) scale at this point, which
      // is the same pair the compositor places the quad with. Emitted only when
      // it would change something.
      ...((() => {
        const csx = Math.abs(sx);
        const csy = Math.abs(sy);
        const rounded = resolvedCornerRadius > 0 || hasIndependentCornerRadii(resolvedCornerRadii);
        return rounded && (csx !== 1 || csy !== 1) && csx > 1e-6 && csy > 1e-6
          ? { cornerRadiusScale: [csx, csy] as const }
          : {};
      })()),
      // Keyframeable like any numeric prop: an animated track wins over the base,
      // so a panel can frost in over time.
      // Glass owns the backdrop blur when it is on — one control, not two that
      // can disagree. Falls back to the raw prop otherwise.
      backdropBlur: glass ? glass.blur : a?.get('backdropBlur') ?? base.backdropBlur,
      glass,
      pathPoints,
      pathOpen: pathOpen || undefined,
      // Source Text keyframes (hold-interpolated data track, like AE) beat the
      // component's static content.
      text: (() => {
        const live = anim.sampleData(node.id, 'text.source', remapOf(node.id)(t));
        const raw = typeof live === 'string' ? live : base.text;
        // PARAGRAPH text renders WRAPPED. Wrapping is done by the same function
        // the measurement uses, so the box the rasterizer allocates and the
        // lines it draws into it can never disagree about where breaks fall.
        const boxWidth = readNumProp(node, 'boxWidth');
        if (!boxWidth || boxWidth <= 0 || typeof raw !== 'string') return raw;
        const style = readMeasuredTextStyle(node, { content: raw, boxWidth });
        return style ? style.content : raw;
      })(),
      // Numeric character props are keyframeable — sample the animated value
      // when a track exists, else fall back to the static base prop.
      fontSize: a?.get('fontSize') ?? base.fontSize,
      fontFamily: base.fontFamily,
      // Animated weight beats the static string — continuous (not rounded), so
      // a variable font's wght axis actually glides instead of stepping through
      // the nine named stops. Clamped to CSS's 1–1000.
      fontWeight: (() => {
        const w = a?.get('fontWeight');
        return w !== undefined ? String(Math.max(1, Math.min(1000, w))) : base.fontWeight;
      })(),
      // Variable-font width / slant — Canvas uses font-variation-settings, not
      // the font shorthand (see textFontVariationSettings).
      fontWidth: (() => {
        const w = a?.get('fontWidth');
        return w !== undefined ? w : base.fontWidth;
      })(),
      fontSlant: (() => {
        const s = a?.get('fontSlant');
        return s !== undefined ? s : base.fontSlant;
      })(),
      fontStyle: base.fontStyle,
      letterSpacing: a?.get('letterSpacing') ?? base.letterSpacing,
      lineHeight: a?.get('lineHeight') ?? base.lineHeight,
      align: base.align,
      paragraphSpacing: a?.get('paragraphSpacing') ?? base.paragraphSpacing,
      strokeOverFill: base.strokeOverFill,
      // Depth of field applies to 3D layers only. A 2D layer's `depth` is just
      // the focal length, which matches the DOF focus default — so this looked
      // fine until someone set Focus Distance, at which point every 2D title,
      // logo and UI layer blurred along with the 3D scene. AE never defocuses 2D
      // layers; they are not in the camera's space at all.
      filter: isSolid || !readNodeMaterial(node, a).castsShadows
        ? withDof(filter, is3D ? depth : undefined)
        : withShadow(withDof(filter, is3D ? depth : undefined), px, py),
      effects: resolvedEffects.length ? resolvedEffects : undefined,
      // Heal absolute backend URLs baked into older documents → same-origin path.
      // Resolution order lives in rigMeshInputs so the puppet overlay resolves
      // the SAME source this layer draws (its coverage mask is keyed off it).
      src: resolveRigImageSrc(node, kind, base, remapOf(node.id)(t), (id) => assetById().get(id), comp.useProxies === true ? 'viewport' : 'original'),
      assetId: base.assetId,
      ...(kind === 'svg' && readSvgLayer(node)?.livePlayback ? { liveSvgPlayback: true } : {}),
      // Media-slot COVER crop. The quad is already the slot rect (fillSlot
      // keeps the box there on purpose), so filling it without distortion means
      // sampling a sub-rect of the source. Computed per frame rather than baked
      // at fill time because the slot's box can be animated — a scaling slot
      // must re-crop as its aspect changes, and a baked rect would smear.
      ...(() => {
        if (slotFitOf(node) !== 'cover') return {};
        const slot = { width: base.width ?? 0, height: base.height ?? 0 };
        const source = footageSourceOf(node);
        const size = source && source.width > 0
          ? { width: source.width, height: source.height }
          : null;
        const uv = size ? coverUvRect(size, slot) : null;
        return uv ? { uvRect: uv } : {};
      })(),
      // Interpret Footage ▸ Alpha and ▸ Fields. Read from the ASSET's
      // interpretation, so one correction fixes every layer using that file —
      // including layers in other compositions — rather than being re-set per
      // layer.
      ...(footageSourceOf(node)?.alpha === 'premultiplied' ? { premultipliedSource: true } : {}),
      ...((): { fieldsSource?: 'upper' | 'lower'; pulldownSource?: number } => {
        const source = footageSourceOf(node);
        // Mutually exclusive by construction: footageSourceOf suppresses
        // `fields` while Remove Pulldown is set (the served frames are
        // progressive — see sourceInfo.ts).
        if (source?.pulldownPhase !== undefined) return { pulldownSource: source.pulldownPhase };
        return source?.fields ? { fieldsSource: source.fields } : {};
      })(),
    };

    // Per-quad Lambert lighting (Material Options → Accepts Lights, default
    // off): the plane normal comes from the layer's 3D world matrix; the
    // accumulated light gain rides the layer as an RGB multiplier which the
    // adapter folds into the draw tint — identical on the GPU depth path and
    // the affine fallback. No lights in the scene ⇒ identity ⇒ nothing added.
    if (is3D && world3d && sceneLights.length > 0) {
      const mat = readNodeMaterial(node, a);
      if (mat.acceptsLights) {
        const lit = shadeLayer(
          planeNormalOf(world3d),
          { x: world.x, y: world.y, z: z3 },
          sceneLights,
          { ambient: mat.ambient, diffuse: mat.diffuse },
        );
        if (lit) layer.lighting = lit;
        // Per-fragment upgrade for the depth-tested GPU path: the adapter swaps
        // the per-quad tint fold for real per-fragment Lambert + Blinn-Phong
        // there (specular and metal normalised to 0..1 for the shader).
        layer.shade3d = {
          specular: mat.specular / 100,
          shininess: mat.shininess,
          ...(mat.metal > 0 ? { metal: mat.metal / 100 } : {}),
          ...(mat.shading === 'pbr' ? { roughness: mat.roughness / 100 } : {}),
          ambient: mat.ambient,
          diffuse: mat.diffuse,
        };
      }
    }

    // Anchor point (E4): shift the pivot. Keyframeable via anchorX/anchorY.
    const anchor = readNodeAnchor(node);
    const ax = a?.get('anchorX') ?? anchor.x;
    const ay = a?.get('anchorY') ?? anchor.y;
    if (ax !== 0 || ay !== 0) { layer.anchorX = ax; layer.anchorY = ay; }

    // Mesh rigging & deformation: puppet pins (Phase 6) and/or skeleton bones.
    // When BOTH rigs live on one layer they COMPOSE instead of the skeleton
    // silently no-oping: the puppet solve runs first in REST space (keeping the
    // ARAP rest configuration — and its cached Cholesky factorisation — frame-
    // invariant), then the skeleton skinning maps the puppet-refined vertices
    // into posed space. Order rationale + determinism notes live in rigDeform.ts.
    const puppetRig = readNodePuppet(node);
    const skelRig = readNodeSkeleton(node);
    const hasPuppet = !!(puppetRig && puppetRig.pins && puppetRig.pins.length > 0);
    const hasSkel = !!(skelRig && skelRig.bones && skelRig.bones.length > 0);
    if (hasPuppet || hasSkel) {
      const pad = rasterPadding(layer);
      // Silhouette-conforming mesh: cull grid cells fully outside the layer's
      // path outline when path geometry exists (closed shapes). Image layers get
      // an alpha-derived coverage mask instead (once the bitmap has decoded);
      // open strokes and undecoded images keep the bbox grid.
      const pathSilhouette = silhouetteFromPathPoints(pathPoints, pathOpen);
      const coverage = rigCoverageMask(layerKind, layer.src, base.assetId, pathSilhouette);
      // ONE shared rest mesh. Puppet mesh settings win when a puppet rig exists
      // (its pin weights are baked into the mesh); a skeleton-only layer reads
      // density/expansion off its own config.
      const meshRig = hasPuppet
        ? puppetRig!
        : { pins: [], meshDensity: skelRig!.meshDensity, meshExpansion: skelRig!.meshExpansion };
      const w = layer.width ?? 100;
      const h = layer.height ?? 100;
      const silhouette = resolvePuppetSilhouette(pathSilhouette, coverage, w, h, meshRig.meshMode);
      const restMesh = getCachedRestMesh(
        node.id,
        w,
        h,
        pad,
        meshRig,
        silhouette,
        coverage
      );
      const rigT = layer.sourceTime ?? t;

      let deformedVertices = restMesh.vertices;
      let overlapDepth: Float32Array | null = null;

      if (hasPuppet) {
        // Static pin values folded with their keyframe tracks. Shared with
        // PuppetOverlay so the canvas and the render cannot drift — see
        // `livePins.ts`.
        const animatedPins = resolveLivePins(puppetRig!.pins, node.id, rigT, anim);
        deformedVertices = deform(
          animatedPins,
          restMesh,
          puppetRig!.solver ?? 'arap',
          puppetRig!.maxRotationDeg,
        );
        // Overlap pins drive per-vertex draw depth, not position — null (the
        // common case) leaves the mesh compositing exactly as before.
        overlapDepth = overlapDepthField(animatedPins, restMesh);
      }

      if (hasSkel) {
        // FK: sample the bone tracks (rotation stored in radians — the unit
        // fromTRS consumes; the UI converts at the display boundary).
        const animatedBones: Bone[] = resolveLiveBones(skelRig!.bones, node.id, rigT, anim);
        // IK: each enabled target overrides its chain's rotations so the end
        // bone's tip reaches the (keyframeable) target position.
        // Live positions, live poles, and the per-chain IK/FK mode — resolved
        // in ONE place shared with both overlays, so a chain cannot be FK here
        // and IK on canvas. See `liveIkTargets.ts`.
        const ikTargets: IkTargetResolved[] = resolveActiveIkTargets(skelRig!, node.id, rigT, anim);
        const posedBones = applyIk(animatedBones, ikTargets);
        const poseWorld = computeWorldTransforms({ bones: posedBones });
        // Weights bound once per (mesh × rest skeleton) and cached — not
        // recomputed per frame. Skinning positions come from the (possibly
        // puppet-deformed) vertex buffer; weights always from rest positions.
        const binding = getSkeletonBinding(restMesh, skelRig!.bones, skelRig!.weightPaint);
        deformedVertices = skinRigVertices(binding, poseWorld, deformedVertices);
      }

      // Overlap pins resolve as draw ORDER within the layer (painter's
      // algorithm over the mesh's own triangles) — see sortTrianglesByDepth.
      // No overlap ⇒ the authored index buffer is passed through untouched.
      layer.deformedMesh = {
        vertices: deformedVertices,
        triangles: overlapDepth
          ? sortTrianglesByDepth(restMesh.triangles, overlapDepth)
          : restMesh.triangles,
        ...(overlapDepth ? { depth: overlapDepth } : {}),
      };
    }

    // The shape geometry chain (`fx.pathOps`): deform, trim, deform again — an
    // ORDERED stack evaluated top-down, exactly as AE evaluates shape contents.
    //
    // Trim is an entry in this chain rather than a fixed stage after it (v1.4.0).
    // That is what makes its position meaningful: at a 37% trim, moving it past
    // any of the six deformers changes the geometry, because trimming by ARC
    // LENGTH cuts a ruffled outline somewhere quite different from where it cuts
    // the smooth one. Round Corners then Trim is not Trim then Round Corners.
    //
    // Trim CUTS the path, so the fill follows it (F14). It used to write an
    // annotation the rasterizer read inside its stroke loop and nowhere else,
    // leaving the fill to trace the whole shape above it.
    if (layerKind === 'shape') {
      // Multi-run stored geometry becomes the layer's real path BEFORE the
      // operator chain, so trim/offset/repeat all see every run and the
      // rasterizer traces them as one region (which is what cuts the hole).
      if (staticSubpaths && staticSubpaths.length > 1) {
        layer.subpaths = staticSubpaths.map((r) => ({
          // Stored runs are already BezierPoints; normalise a missing handle
          // onto its vertex rather than trusting hand-edited project data.
          points: (r.points ?? []).map((p) => ({
            x: p.x, y: p.y,
            inX: p.inX ?? p.x, inY: p.inY ?? p.y,
            outX: p.outX ?? p.x, outY: p.outY ?? p.y,
          })),
          open: r.open === true,
        }));
        layer.pathPoints = undefined;
        layer.pathOpen = undefined;
        layer.primitive = 'path';
      }
      const ops = resolvePathOps(node, a);
      if (ops.length > 0) {
        // Density is decided by whether ANY operator in the chain wants it. A
        // pucker three steps down still deforms every vertex, so testing only
        // the first operator would starve it of geometry — the coarse outline
        // is generated once, before the chain runs, and cannot be re-densified.
        const dense = ops.some((o) => o.type === 'pucker' || o.type === 'twist') ? 8 : 0;
        // FLATTEN the bezier, do not merely drop its handles.
        //
        // The chain's currency is a polyline, and what came out of it is what
        // gets drawn — `corner(x, y)` points, with no handles left to carry
        // curvature. Seeding it with the anchors alone therefore did not
        // "approximate" the path, it REPLACED it with the polygon through its
        // anchors: a drawn curve came back as straight chords the moment any
        // operator was added. Trim was where it showed worst, because trimming
        // is the operator you watch the whole outline while using.
        const base = pathPoints && pathPoints.length > 1
          ? flattenOutline(pathPoints, ADAPTIVE, pathOpen === true)
          : shapeOutline(layer.primitive, layerW, layerH, 48, dense);
        // Roughen's wiggle rides the layer's OWN time — the same axis `a` was
        // sampled on (valuesOf → remapOf). Handing it comp `t` would leave the
        // noise running at wall-clock speed while the keyframes it animates
        // alongside obey time remapping and stretch.
        // Every stored run enters the chain, not just the first: trimming a
        // donut has to trim both of its rings.
        const seed = layer.subpaths && layer.subpaths.length > 0
          ? layer.subpaths.map((sp) => ({
              // Same flattening as `base` above — every run enters the chain as
              // the curve it is, not as the polygon through its anchors.
              pts: flattenOutline(sp.points, ADAPTIVE, sp.open === true),
              closed: sp.open !== true,
            }))
          : [{ pts: base, closed: pathOpen !== true }];
        const runs = applyPathOpChain(
          seed,
          ops,
          remapOf(node.id)(t),
        ).filter((r) => r.pts.length > 1);

        // PER-RUN PAINT, which is what lets the repeater live in this chain at
        // all: its copies are geometry now, and `offsetOpacity` needs somewhere
        // to go. `runPaints` is all-or-nothing — see below.
        const paints = runPaints(runs, layer);

        if (runs.length === 0) {
          // Every run was cut away — an empty trim window (start >= end) draws
          // NOTHING. Not "the untrimmed shape", which is what the old annotation
          // left on screen: the stroke drew no arcs and the fill drew the lot.
          layer.visible = false;
        } else if (runs.length === 1 && runs[0]!.closed && !paints) {
          // The overwhelmingly common result — one closed run — takes the
          // single-subpath shorthand, so nothing downstream sees a list it did
          // not see before this change. A run carrying paint cannot: the
          // shorthand has nowhere to put it.
          layer.pathPoints = runs[0]!.pts.map((p) => corner(p.x, p.y));
          // The two geometry fields are mutually exclusive — a chain that
          // collapses stored runs down to one must drop the list with them.
          layer.subpaths = undefined;
          layer.primitive = 'path';
        } else {
          layer.subpaths = runs.map((r, i) => ({
            points: r.pts.map((p) => corner(p.x, p.y)),
            open: !r.closed,
            ...(paints?.[i] ? { paint: paints[i] } : {}),
          }));
          // The invariant: one geometry field or the other, never both.
          layer.pathPoints = undefined;
          layer.pathOpen = undefined;
          layer.primitive = 'path';
        }

        // GROW THE BOX to whatever the chain produced, but only for a chain
        // containing a repeater.
        //
        // The raster is allocated from `layer.width/height` and `rasterPadding`
        // measures how far the geometry escapes it — with a hard 512px-per-side
        // ceiling, because padding costs quadratic texture memory. Every other
        // operator displaces points by a bounded `amount`, so the ceiling is
        // never near. The repeater is the one that multiplies the geometry's
        // EXTENT: six copies at the default 80px offset already reach 400px, and
        // ten at 150px would have their far copies silently sliced off at the
        // texture edge. Copies vanishing is not an acceptable way to fold.
        //
        // Symmetric about the origin because the box is centred there
        // (`drawPath` translates by bw/2, bh/2) — the geometry's own
        // coordinates are untouched, so nothing moves; the box just stops
        // cutting. It costs up to 2× in one axis for a ladder running one way,
        // which is the same allocation padding would have made.
        //
        // Note this is what makes a GRADIENT fill span the whole repeated group
        // rather than repeat per copy: gradients are built from the layer box.
        // Consistent with the fold's model — the fill paints the chain's output
        // — and part of the announced behaviour change.
        if (runs.length > 0 && ops.some((o) => o.type === 'repeater')) {
          let halfW = 0;
          let halfH = 0;
          for (const r of runs) {
            for (const p of r.pts) {
              if (Math.abs(p.x) > halfW) halfW = Math.abs(p.x);
              if (Math.abs(p.y) > halfH) halfH = Math.abs(p.y);
            }
          }
          if (halfW * 2 > layer.width) layer.width = halfW * 2;
          if (halfH * 2 > layer.height) layer.height = halfH * 2;
        }
      }
    }

    /*
      Motion blur: sub-frame transform samples for a moving, opted-in layer.

      Force Motion Blur overrides the two OPT-INS — the comp switch and the
      layer switch — but not `moves`: sampling a static layer returns the same
      transform every time, so forcing it there costs N draws for an identical
      image. See forceMotionBlur.ts.
    */
    const forcedBlur = readForceMotionBlur(resolvedEffects);
    const blurCfg = forcedBlur && motionBlur
      ? { ...motionBlur, enabled: true, shutterAngle: forcedBlur.shutterAngle, samples: forcedBlur.samples }
      : motionBlur;
    const blurOptIn = forcedBlur ? true : (motionBlur?.enabled === true && readNodeMotionBlur(node));
    // A 3D layer also moves ON SCREEN when the camera does — a static card
    // under a keyframed pan must blur exactly like a moving card under a
    // static camera. 2D layers are outside the camera's space and keep the
    // own-motion gate.
    if (blurCfg && blurOptIn && (moves(anim, node.id) || (is3D && cameraAnimated))) {
      // 3D layers need a matrix per sample (see affineAt). The sub-frame world
      // position is the layer's world position plus its own local delta over
      // the shutter — the parent chain is treated as static across the
      // interval, which is exact unless a parent is also moving.
      const localX = (a?.get('x') as number | undefined) ?? base.x;
      const localY = (a?.get('y') as number | undefined) ?? base.y;
      const localRot = (a?.get('rotation') as number | undefined) ?? base.rotation;
      const matrixAt = is3D
        ? (ti: number, tc: number): readonly [number, number, number, number, number, number] => {
            const sc = anim.sample(node.id, 'scale', ti);
            // `own*` is the local transform when a 3D ancestor drives this
            // layer and the parent-composed world otherwise, so the same
            // "base + animated delta" expression is right either way: with a
            // 3D parent it reduces to the pure sampled local value (the chain
            // is applied by the matrix), without one it stays the world value.
            return affineAt(
              ownX + ((anim.sample(node.id, 'x', ti) ?? localX) - localX),
              ownY + ((anim.sample(node.id, 'y', ti) ?? localY) - localY),
              anim.sample(node.id, 'z', ti) ?? z3,
              anim.sample(node.id, 'rotationX', ti) ?? rotX,
              anim.sample(node.id, 'rotationY', ti) ?? rotY,
              ownRot + ((anim.sample(node.id, 'rotation', ti) ?? localRot) - localRot),
              sc ?? anim.sample(node.id, 'scaleX', ti) ?? ownScaleX,
              sc ?? anim.sample(node.id, 'scaleY', ti) ?? ownScaleY,
              scaleZ,
              // The sub-frame camera, when the camera itself is animated. Note
              // the COMP time `tc`, not the remapped `ti`: time remap retimes
              // the layer's own animation, never the camera's clock.
              projectAtTime ? projectAtTime(tc) : project,
            ).matrix;
          }
        : undefined;
      // `blurCfg`, not `motionBlur` — otherwise the forced shutter and sample
      // count are computed above and then thrown away, and Force Motion Blur
      // becomes a switch with two controls that do nothing.
      const samples = sampleMotion(anim, node.id, base, ghost, t, blurCfg, remapOf(node.id), matrixAt);
      if (samples.length > 1) layer.motionSamples = samples;
    }

    // Text animators (MG Phase D): resolve per-glyph offsets when the text layer
    // carries animator groups. Their numeric params come from `a` (the node's
    // sampled values), so keyframed selectors/offsets animate for free.
    if (layerKind === 'text' && base.text) {
      const anims = resolveAnimators(node, a);
      // Layer-local time drives wiggly-mode selectors (range mode ignores it).
      if (anims.length > 0) layer.glyphs = evaluateTextAnimators(base.text, anims, remapOf(node.id)(t));
      // Per-character styling. Normalized here rather than at paint so both
      // backends see the same disjoint, clamped spans — and so a document
      // written by an older build can't hand the pen a NaN index. Emitted only
      // when non-empty: presence is what costs a layer the whole-string draw.
      const runs = normalizeRuns(readRuns(node), [...base.text].length);
      if (runs.length > 0) layer.runs = runs;

      // Text on a path. The mask is flattened here, once per frame, so both
      // backends get plain geometry instead of reaching into the scene graph.
      // firstMargin comes from `a`, so keyframing it crawls the text along.
      const tp = resolveTextPath(node, a);
      if (tp) {
        const mask = resolveTextPathMask(node, tp);
        if (mask) {
          const { pts, closed } = flattenMaskPath(mask);
          if (pts.length >= 2) {
            layer.textPath = {
              points: pts,
              closed,
              firstMargin: tp.firstMargin,
              reversed: tp.reversed,
              perpendicular: tp.perpendicular,
            };
          }
        }
      }
    }

    // Content hash (Phase 1 — rasterizer seam). All content-affecting fields are
    // now settled (geometry, path-ops, trim, glyphs/runs/textPath). Compute the
    // transform-invariant digest ONCE here so echo ghosts and repeater copies —
    // which spread `...layer` below — inherit it for free (exactly the
    // transform-only-variation reuse case the rasterizer cache exploits).
    layer.contentHash = contentHashOf(layer);

    // DOF blur + light-cast shadow as REAL effect entries for the GPU path
    // (`filter` above is the same math as a CSS string, kept only for tests /
    // legacy readers — nothing on the GPU path reads it). Appended AFTER
    // contentHash on purpose: both depend on depth/position, so hashing them
    // would let a pure move bust the rasterizer cache — the exact reason
    // contentHash.ts excludes `filter`. Same gating and order as the filter:
    // DOF for every layer, cast shadow only for non-solid shadow-casters.
    {
      const gpuFx: Effect[] = [];
      // 3D only — see the `filter` twin above.
      const dofFx = is3D ? dofEffectOf(depth) : null;
      if (dofFx) gpuFx.push(dofFx);
      const mat = readNodeMaterial(node, a);
      if (!isSolid && mat.castsShadows) {
        // A 3D layer under a shadow-casting light gets a REAL projected shadow
        // (emitted after this walk, once every receiver plane is known). The
        // screen-space drop-shadow stays for 2D layers, where there is no depth
        // to project through and it is the only thing that reads as a shadow.
        if (is3D && shadowLight) {
          // The WORLD matrix rides along. The projection below used to build the
          // shadow from `layer.x`/`layer.y`, which for a 3D layer are already
          // PROJECTED screen coordinates, while the light's x/y/z are world —
          // so the two were subtracted in different spaces and only agreed when
          // the projection happened to be identity (default camera, comp plane).
          // Orbit or dolly the camera and every shadow slid off its caster.
          shadowCasters.push({ layer, z: z3, transmission: mat.lightTransmission / 100, world3d: world3d ?? Matrix4Math.identity() });
        } else {
          const castFx = shadowEffectOf(px, py);
          if (castFx) gpuFx.push(castFx);
        }
      }
      if (is3D && mat.acceptsShadows) shadowReceivers.push({ z: z3, depth });
      // A lit plane is a plane a beam can land on. Same {z, depth} record, taken
      // at the same moment, so the wash projection and the shadow projection
      // measure the scene identically.
      if (is3D && mat.acceptsLights) lightReceivers.push({ z: z3, depth });
      // AE's `Only` modes — how shadow-catcher setups are built. The layer stays
      // fully present as a caster and/or receiver (both lists are already
      // populated above), it just isn't drawn: `Casts Shadows: Only` throws a
      // shadow from an invisible object, `Accepts Shadows: Only` catches one
      // onto transparency so it can be comped over live footage.
      if (mat.shadowOnly) layer.visible = false;
      if (gpuFx.length > 0) layer.effects = [...(layer.effects ?? []), ...gpuFx];
    }

    /*
      Temporal ghosts (Echo, Wide Time): draw the layer at OTHER points in time.

      Which times and how bright is the effects' business — `readGhostSpec` —
      and this is the emission they share. Deterministic, a pure function of the
      animation, so scrubbing is stable and no frame cache is needed; and it
      renders on both backends because the ghosts are ordinary render layers.

      One emission for both effects deliberately. The alternative is a second
      copy of these forty lines, which is the shape CompositionPass already got
      burned by — a duplicate that silently dropped whatever the original had
      learned since.
    */
    const ghosts = readGhostSpec(resolvedEffects, fps);
    /*
      Composite In Front holds the ghosts back until after the layer itself is
      emitted — z-order here IS emission order, and that operator is the only
      thing separating it from Composite In Back. Flushed at the bottom of this
      node's iteration; every other operator emits inline exactly as before.
    */
    const echoesInFront: RenderLayer[] = [];
    if (ghosts) {
      const eLocalX = (a?.get('x') as number | undefined) ?? base.x;
      const eLocalY = (a?.get('y') as number | undefined) ?? base.y;
      const eLocalRot = (a?.get('rotation') as number | undefined) ?? base.rotation;
      // Farthest first (readGhostSpec orders them), so nearer copies paint over
      // more distant ones and the current layer lands on top.
      ghosts.steps.forEach((step, k) => {
        const ti = t + step.dt;
        if (ti < 0) return;
        const op = layer.opacity * step.opacity;
        if (op <= 0.002) return;
        const gx = px + ((anim.sample(node.id, 'x', ti) ?? eLocalX) - eLocalX);
        const gy = py + ((anim.sample(node.id, 'y', ti) ?? eLocalY) - eLocalY);
        const grot = rot + ((anim.sample(node.id, 'rotation', ti) ?? eLocalRot) - eLocalRot);
        const ghost: RenderLayer = {
          ...layer,
          id: `${layer.id}__echo${k}`,
          opacity: op,
          // AE's Echo Operator. The ghosts are ordinary layers, so "how do the
          // copies combine" is their blend mode — no second compositing path.
          // All five operators are fixed-function blends, so none of them drags
          // the ghosts onto the advanced-blend (BLEND_COMBINE) route.
          blend: ghosts.blend,
          // Ghosts don't cast/consume mattes or motion-blur individually.
          matte: undefined,
          isMatteSource: undefined,
          isAdjustment: undefined,
          motionSamples: undefined,
          ...(is3D && matrix
            ? (() => {
                // Rebuild BOTH forms at the echoed transform — spreading the
                // base layer would leave the ghost's world3d at the live pose,
                // so the GPU depth path would draw every echo in one place.
                const g3 = affineAt(
                  ownX + ((anim.sample(node.id, 'x', ti) ?? eLocalX) - eLocalX),
                  ownY + ((anim.sample(node.id, 'y', ti) ?? eLocalY) - eLocalY),
                  anim.sample(node.id, 'z', ti) ?? z3,
                  anim.sample(node.id, 'rotationX', ti) ?? rotX,
                  anim.sample(node.id, 'rotationY', ti) ?? rotY,
                  ownRot + ((anim.sample(node.id, 'rotation', ti) ?? eLocalRot) - eLocalRot),
                  ownScaleX, ownScaleY,
                );
                return { matrix: g3.matrix, world3d: g3.world as readonly number[] };
              })()
            : { x: gx, y: gy, rotation: grot }),
        };
        if (ghosts.inFront) echoesInFront.push(ghost);
        else emitLayer(ghost, node);
      });
    }

    // TRUE 3D extrusion: a 3D layer with extrusionDepth d > 0 is a real
    // object — synthesize a back cap + side walls as extra RenderLayers
    // ADJACENT in paint order (they share the front face's sort depth, so
    // the painter sort — stable — keeps the run contiguous and
    // CompositionPass groups all faces into ONE depth-tested pass; the
    // depth buffer then resolves face occlusion automatically). Faces are
    // snapshot-only: hit-testing / timeline read the scene graph, so the
    // synthetic `::ext-*` ids are invisible to selection by construction.
    // Front-cap inset (px per side) applied to the emitted front face when a
    // bevel is active — the front face is the layer's own content (emitted
    // below), which extrusionFaces cannot shrink, so we inset it here so the
    // shrunk front edge meets the front chamfer ring. 0 = no bevel.
    let frontInset = 0;
    /** The extrusion mesh drew the front cap itself — do not emit the quad. */
    let frontDrawnByMesh = false;
    if (is3D && world3d && extrusionDepth > 0) {
      const isComplexContent =
        layer.kind === 'text' ||
        (layer.kind === 'shape' && layer.primitive !== 'rect' && layer.primitive !== 'ellipse');

      const extMat = readNodeMaterial(node, a);
      // Per-face materials (front / side / bevel / back). Absent → the previous
      // single-colour behaviour, since resolveFaceMaterial falls back to the
      // layer fill × the kind's original hardcoded gain.
      const faceMats = readNodeFaceMaterials(node);
      const extLit = extMat.acceptsLights && sceneLights.length > 0;
      // Derived from the layer's STYLED surface colour, not its raw fill: a
      // Colour/Gradient Overlay repaints the front face, and taking the raw
      // fill here left every other face the old colour — one object in two
      // colours, split exactly along the front edge. See styledSurfaceFill.
      const extStyles = readNodeLayerStyles(node);
      const wallFill = styledSurfaceFill(
        extStyles,
        typeof layer.fill === 'string' ? layer.fill : EXTRUSION_WALL_FALLBACK_FILL,
      );
      /**
       * The wall colour AT one face's own position on the object.
       *
       * A synthesized wall is a flat strip, so it gets exactly one colour —
       * but `layer.fill` is the layer's BASE colour, which a gradient fill
       * never writes to (only a SOLID paint updates it). So a gradient-filled
       * box drew its caps as the gradient and all four walls as the base
       * blue. Every face already carries its centre in the layer's centred
       * frame — the same space the gradient is built in — as the translation
       * of its own matrix, so sampling the paint there needs no per-face
       * special-casing and works for box walls, rounded-rect and cylinder
       * segments, and the bevel chamfer rings alike.
       */
      // EXPERIMENT: the interior styles, for the synthesized faces. Exterior
      // ones (drop shadow, outer glow) belong to the object's silhouette and
      // would stack N times; the overlays already reached the faces via
      // wallFill and would double-apply.
      const FACE_SURFACE_IDS = new Set([
        'layerstyle:innerShadow', 'layerstyle:innerGlow',
        'layerstyle:satin', 'layerstyle:bevel', 'layerstyle:stroke',
      ]);
      const faceSurfaceFx = layerStylesToEffects(extStyles, globalLight.angle, globalLight.altitude)
        .filter((e) => FACE_SURFACE_IDS.has(e.id));
      const faceStyles = faceSurfaceFx.length > 0 ? faceSurfaceFx : undefined;
      /**
       * Interior styles belong on a face that is a whole SURFACE of the
       * object — the four walls of a box — and not on a facet that only
       * exists to approximate a curve.
       *
       * An inner shadow hugs the contour of whatever it is applied to. On a
       * box wall that contour is a real edge of the object and the result
       * reads as one softly-shaded solid. On a cylinder it is the edge of a
       * chord strip, so each of the twenty facets drew its own dark band and
       * you saw the tessellation instead of the cylinder. Same for the strips
       * a wall is split into for a gradient, and for the narrow chamfer rings
       * of a bevel.
       *
       * Suffixes: `r`/`l`/`t`/`b` are the undivided box walls, `back` the
       * back cap; `w0…wN` are curve facets, `r0…`/`l0…` gradient
       * subdivisions, and `cf*`/`cb*` chamfer rings.
       */
      const faceFxFor = (suffix: string): typeof faceStyles =>
        (/^[rltb]$/.test(suffix) || suffix === 'back') ? faceStyles : undefined;
      const wallFillAt = (m: import('@motion/scene').Matrix4): string =>
        styledSurfaceFill(extStyles, sampleFillAt(layer.fillPaint, layerW, layerH, m[12]!, m[13]!) ?? wallFill);

      /*
        MESH path — the preferred one. The outline of the layer (rect, rounded
        rect, ellipse, path, traced text) is swept into ONE solid with real
        side walls, bevel rings and a back cap, carrying per-vertex normals
        (core/scene/extrusionMesh.ts). It replaces both branches below: the
        plate stack for text/paths (no walls, visible combing when yawed) and
        the flat-strip quads for rect/ellipse (20 facets, a seam at every
        join, flat lighting per facet). Those remain as the FALLBACK for an
        outline that cannot be produced — text with no canvas to trace from,
        an open path — so nothing ever renders without a body.

        The front face is still the layer's own quad, emitted after this
        (inset by the bevel the mesh actually applied), drawn on top so its
        antialiased edge blends over the opaque wall rather than against the
        background.
      */
      const meshBevel = Math.max(0, a?.get('bevelDepth') ?? d3.bevelDepth);
      const meshOutline = extrusionOutlineFor(layer, node, layerW, layerH);
      /*
        Who draws the FRONT cap. Normally the layer's own quad — it carries the
        content, styles, mask and effects, and a bevel merely insets it. That
        inset is the layer box shrunk by `bevel` per side, which is exact for a
        rect and near enough for an ellipse, but WRONG for text and paths: a
        smaller box re-lays the glyphs out smaller instead of insetting their
        outline, and the full-size raster then sits over the chamfer ring it
        was meant to meet. So a bevelled complex outline hands the front cap to
        the mesh — the inset polygon, textured with the layer's own raster —
        and the quad is not emitted.
      */
      const complexOutline = layer.kind === 'text' || (layer.kind === 'shape' && layer.primitive === 'path');
      const meshOwnsFront = complexOutline && meshBevel > 0;
      /*
        Effect REACH decides the path. COLOUR effects (invert, tint, …) fold
        into the mesh's range colours / colour matrix on the CPU, so they reach
        every surface of the body. SPATIAL effects (blur, glow, DOF's appended
        blur, drop shadow) need per-face offscreen resolves that only the quad
        synthesis can stage — so their presence sends the whole object down the
        fallback, where each face still carries them (see faceEffectsFor).
      */
      const meshBlockedByFx = (layer.effects ?? []).some((e) => e.enabled !== false && !isColorEffect(e.type));
      const builtMesh = meshOutline && !meshBlockedByFx
        ? extrusionMeshFor(meshOutline, layerW, layerH, { depth: extrusionDepth, bevel: meshBevel, bevelStyle: d3.bevelStyle, frontCap: meshOwnsFront })
        : null;
      let meshEmitted = false;
      if (builtMesh) {
        const { key, mesh } = builtMesh;
        frontInset = mesh.bevel;
        const M = world3d as import('@motion/scene').Matrix4;
        const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
        // Same near-plane rule as the faces: an origin behind the camera must
        // not be drawn through the clamped projector.
        if (!O.clipped) {
          const isMedia = layer.kind === 'image' || layer.kind === 'video';
          const hasFrontCap = mesh.ranges.some((r) => r.role === 'front');
          const ranges = mesh.ranges.map((r) => {
            if (r.role === 'front') {
              // The layer's own content, on the inset cap, undimmed.
              return { role: r.role, first: r.first, count: r.count, fill: wallFill, gain: 1, textured: true };
            }
            const fm = resolveFaceMaterial(faceMats, r.role, wallFill);
            // An explicit per-face colour is taken literally; a derived one is
            // dimmed by the kind's gain (same rule as the quad path).
            const gain = faceMats[r.role]?.fill ? 1 : fm.gain;
            // Media keeps its picture on the back cap unless a back colour
            // was chosen, as the quad path's spread back cap did.
            const textured = isMedia && r.role === 'back' && !faceMats.back?.fill;
            return { role: r.role, first: r.first, count: r.count, fill: fm.fill, gain, ...(textured ? { textured: true } : {}) };
          });
          // A carrier that samples the layer's raster (media back cap, or a
          // front cap the mesh owns) must keep the layer's content fields so
          // the texture provider rasterises the same thing under the new id.
          const carriesContent = isMedia || hasFrontCap;
          const scrub = {
            // Colour-only by the gate above; the adapter folds them into the
            // range colours (solid) / colour matrix (textured).
            effects: layer.effects,
            matte: undefined,
            isMatteSource: undefined,
            isAdjustment: undefined,
            motionSamples: undefined,
            deformedMesh: undefined,
            frameBlend: undefined,
            glass: undefined,
            backdropBlur: undefined,
            preserveTransparency: undefined,
            lighting: undefined as RenderLayer['lighting'],
            shade3d: undefined as RenderLayer['shade3d'],
          };
          const meshLayer: RenderLayer = carriesContent
            ? {
                ...layer,
                ...scrub,
                id: `${layer.id}::ext-mesh`,
                extrudedMesh: { key, vertices: mesh.vertices, indices: mesh.indices, ranges },
              }
            : {
                ...scrub,
                id: `${layer.id}::ext-mesh`,
                kind: 'shape',
                primitive: 'rect',
                blend: layer.blend,
                x: layer.x,
                y: layer.y,
                rotation: layer.rotation,
                scaleX: layer.scaleX,
                scaleY: layer.scaleY,
                matrix: layer.matrix,
                world3d: layer.world3d,
                depth: layer.depth,
                opacity: layer.opacity,
                width: layerW,
                height: layerH,
                fill: resolveFaceMaterial(faceMats, 'side', wallFill).fill,
                visible: layer.visible,
                flatFacet: true,
                extrudedMesh: { key, vertices: mesh.vertices, indices: mesh.indices, ranges },
              };
          if (extLit) {
            // Per-fragment lighting from the interpolated vertex normals, one
            // sided: every face of the mesh bounds the volume.
            meshLayer.lighting = [1, 1, 1];
            meshLayer.shade3d = {
              specular: extMat.specular / 100,
              shininess: extMat.shininess,
              oneSided: true,
              ambient: extMat.ambient,
              diffuse: extMat.diffuse,
              ...(extMat.shading === 'pbr' ? { roughness: extMat.roughness / 100, metal: extMat.metal / 100 } : {}),
            };
          }
          emitLayer(meshLayer, node);
          meshEmitted = true;
          if (hasFrontCap) frontDrawnByMesh = true;
        }
      }

      if (meshEmitted) {
        // Body drawn; the quad synthesis below is the fallback only.
      } else if (isComplexContent) {
        // Contour Volume Extrusion: For text and complex shapes, slice the
        // depth axis (z ∈ [1, extrusionDepth]) into continuous slices matching the exact
        // glyph/path silhouette so text extrudes as a solid 3D body without empty gaps.
        const stepPx = EXTRUSION_SLICE_STEP_PX;
        const sliceCount = Math.min(MAX_EXTRUSION_SLICES, Math.max(2, Math.ceil(extrusionDepth / stepPx)));
        const sliceStep = extrusionDepth / sliceCount;

        // Emit BACK-TO-FRONT (i counts down), matching the geometric path and
        // the painter order extrusion.ts documents.
        //
        // This loop used to run i = 1 → sliceCount, i.e. nearest slice FIRST,
        // and the 3D materials use depth test LEQUAL with depthWrite ON. So the
        // nearest slice wrote depth at every anti-aliased glyph fringe pixel
        // with partial alpha, and all 44 slices behind it were then depth-
        // rejected there — the volume never filled in. What you saw was a dark
        // ragged outline around every glyph (the wall gain is 0.72, so the
        // fringe is darker than the face) with the background leaking through
        // it. That is the "dark dots / border inside the 3D object".
        for (let i = sliceCount; i >= 1; i--) {
          const zOffset = i * sliceStep;
          const isBackCap = i === sliceCount;
          const sliceMat = Matrix4Math.compose({
            position: { x: 0, y: 0, z: zOffset },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            anchor: { x: 0, y: 0, z: 0 },
          });
          const M = Matrix4Math.multiply(world3d as import('@motion/scene').Matrix4, sliceMat);
          const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
          // Behind the near plane ⇒ drop this slice, exactly as the layer
          // origin is dropped above. `projectPoint` CLAMPS rather than
          // rejects, so an unguarded slice resolves to focalLength/1 — a
          // ~2666× scale on a 1920-wide comp, i.e. one slice smeared opaque
          // across and far beyond the frame. The layer ORIGIN can sit safely
          // in front while the extruded body sweeps through the near plane,
          // so the origin's guard does not cover this.
          if (O.clipped) continue;
          const FX = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
          const FY = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
          const fm = [FX.x - O.x, FX.y - O.y, FY.x - O.x, FY.y - O.y, O.x, O.y] as const;

          const sliceLayer: RenderLayer = {
            ...layer,
            id: `${layer.id}::ext-${isBackCap ? 'back' : `slice-${i}`}`,
            x: O.x,
            y: O.y,
            rotation: Math.atan2(fm[1], fm[0]) / DEG,
            scaleX: Math.hypot(fm[0], fm[1]),
            scaleY: Math.hypot(fm[2], fm[3]),
            matrix: fm,
            world3d: M as readonly number[],
            depth: O.depth,
            width: layerW,
            height: layerH,
            // Scrub the per-layer passes, exactly as the geometric path does in
            // `common` below. A bare `...layer` spread carried `effects` into
            // every slice — and `castsShadows` defaults ON, so a scene with one
            // shadow-casting light stacked up to 45 copies of the same 45%-black
            // drop shadow inside the object's own bounds (the dark blob), and
            // forced 45 full-viewport offscreen effect resolves PER FRAME.
            // Carrying `matte`/`motionSamples` also disqualified the slices from
            // the depth-tested 3D group, dropping them onto the painter path.
            //
            // `effects` is now DECIDED per effect rather than dropped wholesale
            // (see faceEffects.ts): the shadow-casting and CPU-baked ones — the
            // two populations that reason describes — are still kept off the
            // slices, and everything else reaches them. Losing the whole list
            // also lost depth of field, which arrives as an ordinary `blur`
            // entry appended a few lines above, so an extruded body never
            // defocused with the layer it belongs to.
            effects: faceEffectsFor(layer.effects, { faceCount: sliceCount }),
            matte: undefined,
            isMatteSource: undefined,
            isAdjustment: undefined,
            motionSamples: undefined,
            deformedMesh: undefined,
            frameBlend: undefined,
            // Same scrub as the geometric path's `common` below, and for the
            // same reason: these sample the backdrop, so a slice carrying one
            // leaves the depth group while its siblings stay in it. A slice
            // stack splitting that way is worse than a box doing it — there are
            // up to 400 of them.
            glass: undefined,
            backdropBlur: undefined,
            preserveTransparency: undefined,
            fill: resolveFaceMaterial(faceMats, isBackCap ? 'back' : 'side', wallFill).fill,
          };

          if (extLit) {
            const lg = shadeLayer(planeNormalOf(M), { x: world.x, y: world.y, z: z3 }, sceneLights);
            if (lg) {
              sliceLayer.lighting = lg;
              sliceLayer.shade3d = { specular: extMat.specular / 100, shininess: extMat.shininess, ambient: extMat.ambient, diffuse: extMat.diffuse, ...(extMat.shading === 'pbr' ? { roughness: extMat.roughness / 100, metal: extMat.metal / 100 } : {}) };
            }
          } else {
            // Same rule as the geometric path: an explicit per-face colour is
            // used as picked, only a derived one is dimmed by the gain.
            const sliceKind = isBackCap ? 'back' as const : 'side' as const;
            const sm = resolveFaceMaterial(faceMats, sliceKind, wallFill);
            const g = faceMats[sliceKind]?.fill ? 1 : sm.gain;
            sliceLayer.lighting = [g, g, g];
          }
          emitLayer(sliceLayer, node);
        }
      } else {
        // Geometric Face Extrusion: For rect and ellipse primitives, use
        // exact 3D wall planes + optional bevel chamfer rings.
        const extShape = layer.kind === 'shape' && layer.primitive === 'ellipse' ? 'ellipse' : 'rect';
        const bevelRequested = Math.max(0, a?.get('bevelDepth') ?? d3.bevelDepth);

        // Corner radius drives the extruded OUTLINE too, so a rounded card
        // is a rounded solid rather than a rounded face on a square block.
        const extCorner = extShape === 'rect' ? (layer.cornerRadius ?? 0) : 0;
        // A gradient varies ALONG a wall, and a wall is one flat colour — so
        // split the straight walls into strips that can each sample their own
        // position. Only for a gradient: a solid fill is already exact at one
        // strip per side, and leaving it at 1 keeps that geometry untouched.
        const wallSegments = layer.fillPaint && layer.fillPaint.type !== 'solid' ? GRADIENT_WALL_SEGMENTS : 1;
        // Materialized rather than iterated lazily: the per-face effect decision
        // needs to know how MANY faces there are before it can price a spatial
        // effect (see SPATIAL_FACE_BUDGET), and a face cannot be told that by a
        // loop it is already inside.
        const extGeom = extrusionGeometry(layerW, layerH, extrusionDepth, extShape, undefined, { bevel: bevelRequested, bevelStyle: d3.bevelStyle, cornerRadius: extCorner, wallSegments });
        const extFaces = extGeom.faces;
        // The bevel the GEOMETRY emitted, not the one that was asked for.
        //
        // This was `clampBevel(layerW, layerH, extrusionDepth, bevelRequested)`,
        // computed unconditionally for any rect — but the rounded-outline branch
        // returns before the bevel path and emits no chamfer ring at all. So a
        // rounded card with a bevel set had its front face shrunk by the full
        // inset to meet a ring that was never drawn, leaving a rounded front
        // face floating inside the outline with the darker back cap visible
        // straight through the gap. Reading the emitted value cannot make that
        // mistake, and does not require this module to know which shapes are
        // rounded — which is the coupling that produced the bug.
        frontInset = extGeom.bevel;
        for (const f of extFaces) {
          const M = Matrix4Math.multiply(
            world3d as import('@motion/scene').Matrix4,
            f.m,
          );
          const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
          // Same near-plane rule as the slices and the layer origin: a face
          // whose own origin is behind the camera must not be drawn, or the
          // clamped divide flings it across the frame at focal-length scale.
          if (O.clipped) continue;
          const FX = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
          const FY = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
          const fm = [FX.x - O.x, FX.y - O.y, FY.x - O.x, FY.y - O.y, O.x, O.y] as const;
          // The layer's own effects, filtered for what a face may carry, plus
          // the interior layer styles this particular face qualifies for. One
          // decision, used by both branches below — they used to differ only by
          // accident, and the back cap's `...layer` spread is exactly the kind
          // of asymmetry that let a style reach one face and not the others.
          const faceFx = faceEffectsFor(layer.effects, {
            faceCount: extFaces.length,
            extra: faceFxFor(f.suffix),
          });
          const common = {
            id: `${layer.id}::ext-${f.suffix}`,
            x: O.x,
            y: O.y,
            rotation: Math.atan2(fm[1], fm[0]) / DEG,
            scaleX: Math.hypot(fm[0], fm[1]),
            scaleY: Math.hypot(fm[2], fm[3]),
            matrix: fm,
            world3d: M as readonly number[],
            // Each face's OWN view depth, from its own projected origin.
            //
            // This was `layer.depth` — the parent layer's depth — so all six
            // faces of a cube came out bit-identical (verified live: every face
            // reported depth 5333.0051595167515). The painter sort
            // `(q.depth ?? 0) - (p.depth ?? 0)` then had nothing to order them
            // by, so the back cap and the walls drew in arbitrary array order
            // and could land ON TOP of the front cap. That is the "dark patch
            // inside the object with a border around it": you are seeing a
            // darker back/side face (gain 0.55 / 0.72) punched over the front
            // face. It also made the whole body sort as a single flat plane
            // against other 3D layers, so nothing could interpenetrate it.
            depth: O.depth,
            width: f.w,
            height: f.h,
            matte: undefined,
            isMatteSource: undefined,
            isAdjustment: undefined,
            motionSamples: undefined,
            deformedMesh: undefined,
            frameBlend: undefined,
            /*
              Backdrop-sampling styles do not ride onto a synthesized face.

              The back cap is built by spreading `...layer` while the walls are
              built field-by-field, so anything outside this scrub list reached
              the back cap ALONE. Glass and backdrop blur are the observed case
              and were not the only candidates: both are excluded from the
              depth-tested group (they read what is composited beneath, which
              the depth pass cannot supply), so the object rendered its walls in
              the depth group and its two caps on the affine painter path, and
              the glass panel detached from the body.

              Scrubbing them here is only half the answer, because the FRONT
              face is the layer itself and legitimately keeps its glass. The
              other half is `enforceExtrusionPathAgreement` in the snapshot
              adapter, which keeps every face of one object on whichever path
              the object as a whole takes. This half is what stops a wall and a
              back cap disagreeing about what they are; that half is what stops
              the object disagreeing with its own front face.
            */
            glass: undefined,
            backdropBlur: undefined,
            preserveTransparency: undefined,
            effects: faceFx,
            lighting: undefined as RenderLayer['lighting'],
            shade3d: undefined as RenderLayer['shade3d'],
          };
          const faceLayer: RenderLayer = f.role === 'back'
            ? { ...layer, ...common, fill: resolveFaceMaterial(faceMats, 'back', wallFill).fill }
            : {
                id: common.id,
                kind: 'shape',
                blend: layer.blend,
                x: common.x,
                y: common.y,
                rotation: common.rotation,
                scaleX: common.scaleX,
                scaleY: common.scaleY,
                matrix: common.matrix,
                world3d: common.world3d,
                depth: common.depth,
                opacity: layer.opacity,
                width: f.w,
                height: f.h,
                // Sampled at THIS wall's own position on the object, so a
                // gradient-filled solid keeps one continuous surface instead
                // of gradient caps bolted onto flat base-coloured walls.
                fill: resolveFaceMaterial(faceMats, faceKindOf(f.role, f.suffix), wallFillAt(f.m)).fill,
                visible: layer.visible,
                // Flat strips along the outline — no corner radius of their
                // own. (The back cap takes the branch above, which spreads
                // `layer` and so already carries the layer's radius.)
                primitive: 'rect',
                effects: faceFx,
                // Facets of one body: they tile against each other, so SDF
                // edge coverage would draw a dark hairline at every join —
                // twenty of them around a cylinder. See RenderLayer.flatFacet.
                flatFacet: true,
              };
          if (extLit) {
            /*
              ONE-SIDED, and only here.

              These faces bound a volume and are wound outward (extrusion.ts),
              so a light behind a wall must not light it. Two-sided shading —
              `abs(dot(N, L))`, which cannot tell a normal from its negation —
              lit both walls of every pair identically, which is what "it
              doesn't read as a solid" actually was.

              Deliberately NOT applied to the front face (it is the layer
              itself, and its outward direction is −Z, the opposite of the
              convention `planeNormalOf` returns) nor to the text depth slices
              above (their normals are all +Z, so clamping would black the whole
              stack out under a front light).
            */
            const lg = shadeLayer(planeNormalOf(M), { x: world.x, y: world.y, z: z3 }, sceneLights, undefined, true);
            if (lg) {
              faceLayer.lighting = lg;
              faceLayer.shade3d = { specular: extMat.specular / 100, shininess: extMat.shininess, oneSided: true, ambient: extMat.ambient, diffuse: extMat.diffuse, ...(extMat.shading === 'pbr' ? { roughness: extMat.roughness / 100, metal: extMat.metal / 100 } : {}) };
            }
          } else {
            // An explicit per-face fill is taken literally — dimming a colour
            // the user picked would make the picker lie. Only a DERIVED fill
            // gets the kind's gain.
            const kind = faceKindOf(f.role, f.suffix);
            const fm2 = resolveFaceMaterial(faceMats, kind, wallFill);
            const g = faceMats[kind]?.fill ? 1 : fm2.gain;
            faceLayer.lighting = [g, g, g];
          }
          emitLayer(faceLayer, node);
        }
      }
    }
    // Front face. With a bevel it shrinks by `frontInset` on each side
    // (w−2b × h−2b), centred on the box so its edge meets the front chamfer
    // ring; the depth-path bridge (model3dFor) re-centres the smaller quad on
    // the same world3d origin, so it stays glued. No bevel ⇒ emitted verbatim
    // (byte-identical).
    // Per-character 3D: replace the single string plane with one plane per
    // glyph, each carried by its own world matrix so glyphs depth-test,
    // intersect, and light individually — and a text animator's z /
    // rotationX / rotationY channels can tumble them in real 3D.
    const perCharGlyphs =
      is3D && world3d && layer.kind === 'text' && isPerChar3D(node)
        ? layoutPerChar3D({
            text: layer.text ?? '',
            style: {
              fontSize: layer.fontSize ?? 16,
              fontFamily: layer.fontFamily,
              fontWeight: layer.fontWeight,
              fontStyle: layer.fontStyle,
              letterSpacing: layer.letterSpacing,
              fill: typeof layer.fill === 'string' ? layer.fill : undefined,
              align: layer.align as ParagraphStyle['align'],
              lineHeight: layer.lineHeight,
              paragraphSpacing: layer.paragraphSpacing,
            },
            boxWidth: layerW,
            transforms: layer.glyphs,
            runs: layer.runs,
          })
        : [];

    if (perCharGlyphs.length > 0 && world3d) {
      const pcMat = readNodeMaterial(node, a);
      const pcLit = pcMat.acceptsLights && sceneLights.length > 0;
      for (const g of perCharGlyphs) {
        // Glyph frame: offset within the text box, its own depth, tumble
        // about its own axes, then the animator's uniform scale.
        const gm = Matrix4Math.compose({
          position: { x: g.offsetX, y: g.offsetY, z: g.offsetZ },
          rotation: { x: g.rotationX * DEG, y: g.rotationY * DEG, z: g.rotation * DEG },
          scale: { x: g.scale, y: g.scale, z: 1 },
          anchor: { x: 0, y: 0, z: 0 },
        });
        const M = Matrix4Math.multiply(world3d as import('@motion/scene').Matrix4, gm);
        const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
        // A per-character glyph is its OWN plane in depth: tumbling the text
        // block, or animating glyph z, sends individual glyphs behind the
        // camera while the text layer's origin stays comfortably in front.
        // Unguarded, such a glyph came back at focal-length scale (2666× on a
        // 1920 comp) and painted over the whole composition — the "3D text
        // renders wrong while 2D text is fine" symptom.
        if (O.clipped) continue;
        const GX = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
        const GY = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
        const gfm = [GX.x - O.x, GX.y - O.y, GY.x - O.x, GY.y - O.y, O.x, O.y] as const;
        const glyphLayer: RenderLayer = {
          ...layer,
          // Synthetic id: snapshot-only, so hit-testing / timeline / layer
          // list (which read the scene graph) never see the glyph planes.
          id: `${layer.id}::ch${g.index}`,
          text: g.char,
          // One glyph per plane — the string's own animators/runs already
          // resolved into this glyph's placement and fill.
          glyphs: undefined,
          runs: undefined,
          width: g.width,
          height: g.height,
          x: O.x,
          y: O.y,
          rotation: Math.atan2(gfm[1], gfm[0]) / DEG,
          scaleX: Math.hypot(gfm[0], gfm[1]),
          scaleY: Math.hypot(gfm[2], gfm[3]),
          matrix: gfm,
          world3d: M as readonly number[],
          depth: layer.depth,
          opacity: layer.opacity * g.opacity,
          ...(g.fill ? { fill: g.fill } : {}),
          lighting: undefined,
          shade3d: undefined,
        };
        if (pcLit) {
          const lg = shadeLayer(planeNormalOf(M), { x: O.x, y: O.y, z: z3 + g.offsetZ }, sceneLights);
          if (lg) {
            glyphLayer.lighting = lg;
            glyphLayer.shade3d = { specular: pcMat.specular / 100, shininess: pcMat.shininess, ambient: pcMat.ambient, diffuse: pcMat.diffuse, ...(pcMat.shading === 'pbr' ? { roughness: pcMat.roughness / 100, metal: pcMat.metal / 100 } : {}) };
          }
        }
        emitLayer(glyphLayer, node);
      }
    } else if (frontDrawnByMesh) {
      // Front cap already drawn as part of the extrusion mesh (see meshOwnsFront).
    } else if (frontInset > 0) {
      emitLayer({ ...layer, width: layerW - 2 * frontInset, height: layerH - 2 * frontInset }, node);
    } else if (
      is3D &&
      dof &&
      layer.matrix &&
      world3d &&
      extrusionDepth <= 0 &&
      !layer.deformedMesh
    ) {
      // Depth-spanning flat quads: per-pixel planar CoC (corner radii) when the
      // blur span is meaningful; otherwise a single uniform dof blur on the layer.
      const corners = layerCornerDepths(world3d, layer.width, layer.height, project);
      const planar = corners ? planDofCocCorners(corners, dof) : null;
      if (planar) {
        const iris = dofIrisParams(dof);
        const effects = (layer.effects ?? [])
          .filter((e) => e.id !== 'dof')
          .concat([{
            id: 'dof',
            type: 'blur' as const,
            params: {
              amount: planar.maxPx,
              coc0: planar.corners[0],
              coc1: planar.corners[1],
              coc2: planar.corners[2],
              coc3: planar.corners[3],
              ...(iris.blades !== undefined ? { blades: iris.blades } : {}),
              ...(iris.roundness !== undefined ? { roundness: iris.roundness } : {}),
              ...(iris.highlightGain !== undefined && iris.highlightGain > 0
                ? { highlightGain: iris.highlightGain }
                : {}),
            },
          }]);
        emitLayer({ ...layer, effects }, node);
      } else {
        emitLayer(layer, node);
      }
    } else {
      emitLayer(layer, node);
    }

    // Echo ▸ Composite In Front: the ghosts held back above, now that the layer
    // they trail is on the canvas. Empty for every other operator.
    for (const ghost of echoesInFront) emitLayer(ghost, node);
  }

  // ── Beams that land: project an aimed light's pool onto the plane it lits ──
  //
  // A spot's wash was drawn at the FIXTURE — a glow centred on the emitter, the
  // same shape whatever the light was pointed at. That is what makes an aimed
  // light read as "light piling up on itself" rather than as a beam: in a real
  // scene you do not see the lamp, you see the pool it throws on the wall.
  //
  // Same construction as the shadow projection below, and for the same reason:
  // the light's axis is intersected with the nearest lit plane behind it, and
  // the result is flattened onto that plane. A cone crossing a plane is a DISC
  // (`pool`), not the wedge you see when the axis lies in the plane — so the
  // wash swaps its cone-masked texture for a feathered one, and the distance the
  // beam travelled moves out of the texture and into the intensity.
  //
  // Deliberately narrow. It applies only to a spot or parallel light with a real
  // 3D aim (a Point of Interest) pointing INTO depth at a plane that accepts
  // lights. An untargeted light aims within the comp plane by construction — it
  // has no depth component to travel along — so it keeps the wedge at the
  // fixture, which for an axis lying in the plane is the correct footprint
  // anyway. A point light radiates in every direction and has no beam to land.
  if (washLights.length > 0 && lightReceivers.length > 0) {
    for (const w of washLights) {
      const L = sceneLightById.get(w.nodeId);
      if (!L) continue;
      const aim = lightAim3D(L);
      // No target ⇒ the comp-plane aim, which cannot point at another depth.
      if (!aim || aim[2] <= 1e-3) continue;

      // Nearest lit plane in front of the light, in the light's own sense of
      // "in front": the direction its axis actually travels.
      const behind = lightReceivers.filter((r) => r.z > L.z + 1);
      if (behind.length === 0) continue;
      const receiver = behind.reduce((a, b) => (b.z < a.z ? b : a));

      // Distance along the AXIS to the plane — not the gap in z, which would
      // under-measure every angled beam and land the pool short.
      const travel = (receiver.z - L.z) / aim[2];
      if (!Number.isFinite(travel) || travel <= 0) continue;
      // The beam dies before it arrives: leave the fixture glow alone rather
      // than painting a pool the light cannot actually throw.
      const carried = lightAttenuationAt(travel, L);
      if (carried <= 0.004) continue;

      // Where the axis meets the plane, and how wide the cone has opened by
      // then. A parallel light does not spread — that is what makes it
      // parallel — so its pool stays the size of its radius.
      const cx = L.x + aim[0] * travel;
      const cy = L.y + aim[1] * travel;
      const half = Math.max(1e-3, ((L.cone ?? 0) / 2) * (Math.PI / 180));
      const footprint = L.type === 'parallel'
        ? w.reach
        : Math.max(1, travel * Math.tan(Math.min(half, 1.5)));

      const cp = project({ x: cx, y: cy, z: receiver.z });
      if (cp.clipped) continue;

      const light = w.layer.light!;
      w.layer.x = cp.x;
      w.layer.y = cp.y;
      // Sits on the surface it lands on, so depth readers (DOF) defocus the pool
      // with the wall rather than with the lamp.
      w.layer.depth = receiver.depth - 0.5;
      // A disc is radially symmetric; carrying the fixture's aim would only spin
      // the dither pattern.
      w.layer.rotation = 0;
      w.layer.light = {
        ...light,
        screenRadius: footprint * cp.scale,
        intensity: light.intensity * carried,
        pool: true,
      };
    }
  }

  // ── Real cast shadows: project each caster onto the planes behind it ──────
  //
  // What was here before was a CSS drop-shadow attached to the caster itself:
  // one light only, a fixed 6-16px offset from the light's 2D direction, no Z
  // term, and — decisively — it never landed on another layer, which is why
  // `acceptsShadows` had no consumer and 3D scenes read as flat cut-outs.
  //
  // This projects properly. For a point light L and a receiver plane z = zp, a
  // caster point V maps to L + t·(V − L) with t = (zp − Lz)/(Vz − Lz). For a
  // caster parallel to the receiver (the usual case) that is a uniform scale
  // about L, so it stays expressible as the layer's own transform: the shadow is
  // a copy of the caster, blackened, scaled by t about the light, and sorted onto
  // the receiver's plane. It grows as the caster nears the light and shrinks as
  // it approaches the receiver — the depth cue the fake never gave.
  //
  // Every shadow-casting light contributes a projection (AE-style multi-light
  // cast shadows). Shadow-map soft contact remains a later renderer target.
  if (shadowLights.length > 0 && shadowCasters.length > 0 && shadowReceivers.length > 0) {
    let lightIndex = 0;
    for (const L of shadowLights) {
      const strength = Math.max(0, Math.min(1, (L.intensity / 100) * L.darkness));
      if (strength <= 0) { lightIndex++; continue; }
      for (const caster of shadowCasters) {
        // Only planes BEHIND the caster can catch its shadow.
        const behind = shadowReceivers.filter((r) => r.z > caster.z + 1);
        if (behind.length === 0) continue;
        // Nearest receiver behind it — the surface the shadow actually falls on.
        const receiver = behind.reduce((a, b) => (b.z < a.z ? b : a));

        const denom = caster.z - L.z;
        if (Math.abs(denom) < 1) continue; // caster in the light's own plane
        const t = (receiver.z - L.z) / denom;
        if (!Number.isFinite(t) || t <= 0) continue; // receiver is behind the light
        // Runaway projections (caster almost touching the light) would smear a
        // black sheet over the frame.
        if (t > 8) continue;

        const src = caster.layer;
        const gap = receiver.z - caster.z;
        // Softer and fainter the further the shadow has to travel; Shadow
        // Diffusion adds a flat amount on top of that distance-driven softness.
        const softness = Math.min(200, 4 + gap * 0.05 + L.diffusion);
        const opacity = src.opacity * strength * 0.55 * Math.max(0.25, 1 - gap / 4000);

        // ── The shadow as real geometry, built in WORLD space ───────────────
        //
        // This used to scale the caster's SCREEN x/y about the light's WORLD
        // x/y and emit a plain 2D quad. Two things were wrong with that. The
        // arithmetic mixed spaces, so the shadow only landed correctly while
        // the projection was identity — orbit or dolly and it slid off. And a
        // quad with no matrix is not depth-eligible, so the shadow could not be
        // occluded by anything: it painted at the end of the stack, over the
        // objects standing in front of the wall it had supposedly landed on.
        //
        // Scaling about the light by `t` is exact for a caster parallel to the
        // receiver, which is the same whole-quad approximation used everywhere
        // here; a tilted caster gets the flattened silhouette it always got.
        const cw = caster.world3d;
        const cScaleX = Math.hypot(cw[0]!, cw[1]!, cw[2]!);
        const cScaleY = Math.hypot(cw[4]!, cw[5]!, cw[6]!);
        // Nudged toward the camera so it is not coplanar with the surface it
        // lands on. Coplanar quads z-fight on the GPU depth path and sort
        // arbitrarily on the painter path; one unit per light also keeps two
        // lights' shadows from fighting each other.
        const zBias = 1 + lightIndex * 0.5;
        const M = Matrix4Math.compose({
          position: {
            x: L.x + (cw[12]! - L.x) * t,
            y: L.y + (cw[13]! - L.y) * t,
            z: receiver.z - zBias,
          },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: cScaleX * t, y: cScaleY * t, z: 1 },
          anchor: { x: 0, y: 0, z: 0 },
        });
        const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
        // Behind the near plane — the same guard every other projected quad in
        // this file applies, for the same reason (`projectPoint` clamps).
        if (O.clipped) continue;
        const FX = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
        const FY = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
        const sm = [FX.x - O.x, FX.y - O.y, FY.x - O.x, FY.y - O.y, O.x, O.y] as const;

        shadowLayers.push({
          ...src,
          id: lightIndex === 0 ? `${src.id}::shadow` : `${src.id}::shadow:${lightIndex}`,
          // The caster may be hidden (`Casts Shadows: Only`) — its SHADOW is
          // the whole point, so it must not inherit that invisibility.
          visible: true,
          x: O.x,
          y: O.y,
          scaleX: Math.hypot(sm[0], sm[1]),
          scaleY: Math.hypot(sm[2], sm[3]),
          rotation: Math.atan2(sm[1], sm[0]) / DEG,
          // Real 3D geometry on the receiver's plane: it depth-sorts with the
          // scene and joins the GPU depth run, so an object standing in front of
          // the wall now occludes the shadow on it.
          matrix: sm,
          world3d: M,
          depth: O.depth,
          opacity,
          // A shadow is a dark silhouette, not a copy of the caster's
          // compositing. Inheriting `blend` through the spread meant a
          // screen-blended caster threw an invisible shadow (black screened is a
          // no-op) and a multiply-blended one threw a double-dark hole. Both
          // also cost the shadow its depth eligibility.
          blend: 'normal',
          preserveTransparency: undefined,
          // Silhouette, tinted by Light Transmission. At 0 the shadow is the
          // usual black; as transmission rises the caster's own colour bleeds
          // through, which is what makes a coloured or translucent layer throw
          // a coloured shadow instead of a black hole.
          fill: shadowTint(src.fill, caster.transmission),
          fillPaint: undefined,
          fillPaints: undefined,
          stroke: undefined,
          lighting: [0, 0, 0],
          shade3d: undefined,
          effects: [{ id: 'shadow-blur', type: 'blur', params: { amount: Number(softness.toFixed(1)) } }],
          // `brightness(0)` would crush a transmitted colour back to black, so
          // it only applies to an untinted shadow.
          filter: caster.transmission > 0
            ? `blur(${softness.toFixed(1)}px)`
            : `blur(${softness.toFixed(1)}px) brightness(0)`,
          matte: undefined,
          isMatteSource: undefined,
          isAdjustment: undefined,
          motionSamples: undefined,
          frameBlend: undefined,
        } as RenderLayer);
      }
      lightIndex++;
    }
  }
  if (shadowLayers.length > 0) layers.push(...shadowLayers);

  // 3D depth sort (painter's order: farthest first), applied WITHIN runs bounded
  // by order-dependent layers rather than abandoned when any exists.
  //
  // The old code disabled all sorting the moment a single adjustment layer or
  // matte appeared, so every 3D layer then rendered in list order — wrong depth,
  // silently. Adjustment layers and matte pairs genuinely can't be reordered
  // (an adjustment affects everything beneath it; a matte pairs with an
  // adjacent source), so they act as BARRIERS: sortable layers between two
  // barriers sort among themselves. This also mirrors After Effects, where an
  // adjustment layer breaks 3D layers into separately-sorted render groups.
  const anyThreeD = layers.some((l) => l.matrix);
  if (anyThreeD) {
    const locked = new Array<boolean>(layers.length).fill(false);
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]!;
      if (l.isAdjustment) locked[i] = true;
      // 2D layers are BARRIERS, exactly as in After Effects — they hold their
      // stacking position and split the 3D layers around them into separate
      // render groups.
      //
      // They used to be sorted alongside the 3D ones, using a `depth` that
      // `project` produces for every layer including flat ones. That made the
      // camera leak into 2D stacking: with an orbited camera the projected depth
      // varies with a 2D layer's x/y, so 2D layers REORDERED AMONG THEMSELVES as
      // you orbited; in a Top view they sorted by their Y position. Their
      // positions were always camera-independent (correct); only their paint
      // order was not.
      if (!l.matrix) locked[i] = true;
      if (l.matte) {
        locked[i] = true; // the matted layer
        const sourceId = readMatte(l.matte)?.sourceId;
        if (sourceId) {
          const j = layers.findIndex((x) => x.id === sourceId);
          if (j >= 0) locked[j] = true;
        } else if (i + 1 < layers.length) {
          // Positional matte consumes the layer ABOVE in the stack — the row
          // above is the front-most neighbour, i.e. the NEXT layer in paint
          // order (paint runs back→front). i-1 here paired with the layer
          // *beneath*, which matched the timeline only while its rows listed
          // back-most first.
          locked[i + 1] = true;
        }
      }
    }

    const sorted: RenderLayer[] = [];
    /**
     * Light washes, lifted out of the sort and put back afterwards.
     *
     * A wash is a screen-blended overlay: it occludes nothing and composites
     * nothing, so it is not a barrier. But it has no `matrix` — there is no
     * plane to project, a light is a point — so the `!l.matrix` rule above read
     * it as a 2D wall and split the 3D layers around it into separately-sorted
     * groups. Dropping a light anywhere in the middle of the timeline therefore
     * broke depth sorting for everything around it: `[near, light, far]` kept
     * list order, so the FAR layer painted OVER the near one. AE's lights do not
     * break the 3D stack, and this one has no business doing it either.
     *
     * `at` is the slot the wash occupies once the sort is done — measured in the
     * light-free array, because sorting reorders a run but never changes its
     * length. Re-inserting there keeps the wash exactly where the timeline put
     * it, so what it brightens is still what the user stacked it over; only the
     * 3D layers on either side are now free to sort against each other.
     */
    const parkedWashes: Array<{ at: number; layer: RenderLayer }> = [];
    let run: RenderLayer[] = [];
    const flushRun = (): void => {
      run.sort((p, q) => (q.depth ?? 0) - (p.depth ?? 0));
      sorted.push(...run);
      run = [];
    };
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i]!;
      if (l.light) { parkedWashes.push({ at: sorted.length + run.length, layer: l }); continue; }
      if (locked[i]) { flushRun(); sorted.push(l); }
      else run.push(l);
    }
    flushRun();
    // `at` rises monotonically (every non-wash layer advances it by one), so the
    // k-th re-insertion has k earlier washes sitting in front of its recorded
    // slot.
    parkedWashes.forEach((w, k) => sorted.splice(Math.min(w.at + k, sorted.length), 0, w.layer));
    layers.splice(0, layers.length, ...sorted);
  }

  resolveMatteSources(layers);

  // 3D camera in matrix form for the GPU depth-tested path — derived from the
  // SAME scalar camera / ortho view the affine projection above used, so both
  // paths place layers identically. Emitted only when the frame has 3D layers.
  const hasWorld3d = (ls: ReadonlyArray<RenderLayer>): boolean =>
    ls.some((l) => l.world3d !== undefined || (l.precompLayers ? hasWorld3d(l.precompLayers) : false));
  const has3d = hasWorld3d(layers);
  const camera3d = has3d
    ? orthoView
      ? Project3D.orthoCameraMatrices(orthoView, comp.width, comp.height)
      : {
          view: Project3D.cameraViewMatrix(camera!),
          projection: Project3D.cameraProjectionMatrix(camera!),
          // Eye for Blinn-Phong specular on the per-fragment path. Ortho views
          // have no eye — specular degrades gracefully there (adapter omits it).
          eye: [camera!.position.x, camera!.position.y, camera!.position.z] as const,
        }
    : undefined;
  // Scene lights in shader terms — only worth carrying when a 3D layer exists
  // (per-fragment shading is gated on Accepts Lights per layer anyway).
  const lights3d = has3d && sceneLights.length > 0 ? toShaderLights(sceneLights) : undefined;

  return {
    width: comp.width,
    height: comp.height,
    background: comp.background,
    backgroundPaint: comp.backgroundPaint,
    transparent: comp.transparent,
    time: t,
    fps,
    layers,
    overlays,
    view,
    camera3d,
    lights3d,
  };
}

/**
 * Every camera property whose animation moves the VIEW — the camera-side twin
 * of `moves()` below. Mirrors what `cameraFromNode` actually samples; a prop
 * added there without being added here is a camera move that never blurs.
 */
export const CAMERA_MOTION_PROPS = [
  'x', 'y', 'z', 'focalLength',
  'orbitYaw', 'orbitPitch',
  'poiX', 'poiY', 'poiZ',
  'orientationX', 'orientationY', 'orientationZ',
] as const;

/** True when a node animates a transform property (so motion blur has motion). */
function moves(anim: AnimationEngine, nodeId: string): boolean {
  // The 3D channels were missing, so motion blur NEVER fired on 3D motion: a card
  // flip (rotationY only), a depth push (z only) or an orientation tumble was
  // gated out entirely even with motion blur switched on — while the per-sample
  // 3D matrix path that would blur it (matrixAt) was sitting right there, working.
  // An un-blurred 3D flip is the classic tell of amateur 3D.
  return ([
    'x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY',
    'z', 'rotationX', 'rotationY',
    'orientationX', 'orientationY', 'orientationZ',
  ] as const).some((p) => anim.isAnimated(nodeId, p));
}

/** Sample a layer's transform at each sub-frame time across the shutter. Each
 *  comp sub-time is mapped through the layer's time remap (E6) before sampling. */
function sampleMotion(
  anim: AnimationEngine,
  nodeId: string,
  base: ReturnType<typeof readBase>,
  ghost: boolean,
  t: number,
  cfg: MotionBlurConfig,
  remap: (tt: number) => number,
  /** 3D only: the projected affine at (layer source time, comp time). Without
   *  it the backend would use the layer's single baked matrix for every sample
   *  and blur nothing. The comp time is what the sub-frame CAMERA samples at —
   *  time remap retimes the layer, never the camera. */
  matrixAt?: (ti: number, tc: number) => readonly [number, number, number, number, number, number],
): MotionSample[] {
  const limit = cfg.adaptiveSampleLimit ?? 128;
  // Probe the shutter endpoints to size the sample count to on-screen travel.
  // Fixed sample counts either strobe on fast kinetic type or waste budget on
  // near-static layers; AE's adaptive limit exists for the same reason.
  const probe = motionBlurSampleTimes(t, cfg.fps, cfg.shutterAngle, 2, cfg.shutterPhase ?? -90, limit);
  let travelPx = 0;
  if (probe.length >= 2 && matrixAt) {
    // 3D: measure PROJECTED travel — it is what lands on screen. The raw x/y
    // probe below reads zero for a card flip (rotationY only), a depth push
    // (z only) and every camera move, so exactly the showiest 3D motion was
    // sampled at the static-layer floor and strobed.
    const ta = probe[0]!;
    const tb = probe[probe.length - 1]!;
    const ma = matrixAt(remap(ta), ta);
    const mb = matrixAt(remap(tb), tb);
    travelPx = Math.hypot(mb[4]! - ma[4]!, mb[5]! - ma[5]!);
  } else if (probe.length >= 2) {
    const a = remap(probe[0]!);
    const b = remap(probe[probe.length - 1]!);
    const xa = anim.sample(nodeId, 'x', a) ?? base.x;
    const ya = anim.sample(nodeId, 'y', a) ?? base.y;
    const xb = anim.sample(nodeId, 'x', b) ?? base.x;
    const yb = anim.sample(nodeId, 'y', b) ?? base.y;
    travelPx = Math.hypot(xb - xa, yb - ya);
  }
  const samples = adaptiveMotionBlurSamples(cfg.samples, travelPx, limit);
  const times = motionBlurSampleTimes(t, cfg.fps, cfg.shutterAngle, samples, cfg.shutterPhase ?? -90, limit);
  const g = ghost ? GHOST_OPACITY : 1;
  return times.map((tc) => {
    const ti = remap(tc);
    const sc = anim.sample(nodeId, 'scale', ti);
    const op = anim.sample(nodeId, 'opacity', ti);
    return {
      x: anim.sample(nodeId, 'x', ti) ?? base.x,
      y: anim.sample(nodeId, 'y', ti) ?? base.y,
      rotation: anim.sample(nodeId, 'rotation', ti) ?? base.rotation,
      scaleX: sc ?? anim.sample(nodeId, 'scaleX', ti) ?? base.scaleX,
      scaleY: sc ?? anim.sample(nodeId, 'scaleY', ti) ?? base.scaleY,
      opacity: (op !== undefined ? op / 100 : base.opacity) * g,
      ...(matrixAt ? { matrix: matrixAt(ti, tc) } : {}),
    };
  });
}

/**
 * Mark each matted layer's source: if the matte defines an explicit `sourceId`,
 * that layer becomes the matte source and is drawn only as the matte. Otherwise,
 * falls back to AE positional convention (the layer directly above).
 */
export function resolveMatteSources(layers: RenderLayer[]): void {
  const layerMap = new Map<string, RenderLayer>();
  for (const l of layers) layerMap.set(l.id, l);

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    if (!layer.matte || (layer.matte as any) === 'none') continue;
    const sourceId = readMatte(layer.matte)?.sourceId;
    if (sourceId && layerMap.has(sourceId)) {
      layerMap.get(sourceId)!.isMatteSource = true;
      layer.matteSourceId = sourceId;
    } else if (i + 1 < layers.length) {
      // AE's positional convention: the matte source is the layer directly
      // ABOVE in the stack — the front-most neighbour, i.e. the NEXT layer in
      // paint order (paint runs back→front, timeline rows list front first).
      layers[i + 1]!.isMatteSource = true;
      // Store the resolved source id so the GPU path can pair the matted layer
      // with its source by a map lookup instead of re-deriving adjacency.
      layer.matteSourceId = layers[i + 1]!.id;
    }
  }
}

export { COMP_WIDTH, COMP_HEIGHT };
