/**
 * SnapshotBuilder — projects (SceneGraph + animated values @ time) into an
 * immutable RenderSnapshot (TAD §6.4.3). Pure: reads only, mutates nothing.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import { renderComponentsOf, renderTransformOf } from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { flattenComposition, readNodeKind, KIND_FILL } from '@core/scene/sceneDerive';
import { readNodeRenderEffects, effectsToFilter, resolveEffectParams, type Effect } from '@core/effects/effects';
import { readNodeLayerStyles, layerStylesToEffects } from '@core/effects/layerStyles';
import { resolveGlass } from '@core/effects/glassResolve';
import { resolveGlobalLight } from '@stores/projectStore';
import { readNodeBlend } from '@core/effects/blendMode';
import { readNodeMaskAt } from '@core/effects/mask';
import { readNodeMatte, getMatteSourceId } from '@core/effects/matte';
import { readNodeAdjustment } from '@core/effects/adjustment';
import { readNodeMotionBlur, motionBlurSampleTimes, type MotionBlurConfig } from '@core/effects/motionBlur';
import { readNodeFill, readNodeFills, type FillPaint } from '@core/paint/fill';
import { readNodeStroke, readNodeRenderStrokes } from '@core/paint/stroke';
import { useAssetStore } from '@stores/assetStore';
import { localMatrix, worldTransformOf, type LocalOf, type ParentOf } from '@core/scene/worldTransform';
import { parentWorld3d, resolveNode3DTransform } from '@core/scene/nodeMatrix';
import { readNodeLayerTime, remapTime } from '@core/scene/layerTime';
import { readNode3D, is3DEnabled, isPerChar3D } from '@core/scene/threeD';
import { isAutoOrientedToCamera, readNodeAutoOrient } from '@core/scene/autoOrient';
import { autoOrientAngleDeg } from '@core/motion/motionPath';
import { resolveRepeater, repeaterCopies } from '@core/scene/repeater';
import { resolveTrim, trimSegments } from '@core/scene/trimPath';
import { nearestPrecompRoot, precompAncestorChain } from '@core/scene/precomp';
import { readNodeAnchor } from '@core/scene/anchor';
import { readNodeLight } from '@core/scene/light';
import { readNodeParticle, resolveParticleConfig } from '@core/particles/particleSim';
import { measureTextNodeSize, readMeasuredTextStyle } from '@core/text/measureText';
import { readGeometry } from '@core/workspace/geometry';
import { readEchoConfig } from '@core/effects/echo';
import { readPosterizeTimeFps } from '@core/effects/posterizeTime';
import { readNodeQuality } from '@core/effects/layerQuality';
import { readNodeMaterial } from '@core/scene/material';
import { extrusionFaces, clampBevel, EXTRUSION_WALL_FALLBACK_FILL } from '@core/scene/extrusion';
import { readNodeFaceMaterials, resolveFaceMaterial, faceKindOf } from '@core/scene/faceMaterials';
import { shadeLayer, planeNormalOf, toShaderLights, type SceneLight } from '@core/scene/lightShading';
import { readNodePaint } from '@core/paint/paintStrokes';
import { resolvePathOp, applyPathOp, shapeOutline } from '@core/scene/pathOps';
import { corner } from '../../../packages/workspace/src/math/BezierPoint';
import { resolveAnimators, evaluateTextAnimators } from '@core/text/textAnimators';
import { layoutPerChar3D } from '@core/text/perChar3D';
import type { ParagraphStyle } from '@core/text/textLayout';
import { readRuns, normalizeRuns } from '@core/text/richText';
import { resolveTextPath, resolveTextPathMask, flattenMaskPath } from '@core/text/textPath';
import { bracketFrames } from './videoFrameCache';
import { readSceneCamera, readSceneDof, dofBlurPx } from '@core/scene/camera3d';
import { expandCompInstances, instanceSourceOf, isCompInstanceRoot, readCompRef, readCompCollapse } from '@core/scene/compInstance';
import type { PropPath } from '@motion/animation';
import { Project3D, Matrix4Math, type Matrix2D, type Matrix4 } from '@motion/scene';
import type { LayerMask } from '@core/effects/mask';
import { Color } from '@motion/renderer';

import { getTimelineController } from '@core/timeline/TimelineController';

const DEG = Math.PI / 180;
import type { MotionSample } from './RenderBackend';
import type { AnimationEngine } from '@motion/animation';
import type { RenderSnapshot, RenderLayer, LayerKind } from './RenderBackend';
import { contentHashOf } from './contentHash';
import { rasterPadding } from './raster/vectorDraw';
import { readNodePuppet, getCachedRestMesh, deform, silhouetteFromPathPoints, overlapDepthField, sortTrianglesByDepth } from '../rig/puppet';
import { readNodeAudioWaveform, resolveAudioWaveformPoints } from '@core/audio/audioWaveformGen';
import { readNodeSkeleton } from '../rig/skeletonCommands';
import { computeWorldTransforms, type Bone } from '../rig/skeleton';
import { applyIk, getSkeletonBinding, skinRigVertices, type IkTargetResolved } from '../rig/rigDeform';
import { rigCoverageMask, resolveRigImageSrc } from '../rig/rigMeshInputs';

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

const DEFAULT_COMP: SnapshotComp = { width: COMP_WIDTH, height: COMP_HEIGHT, background: COMP_BG };

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Read base (authoring) props off a node's components. */
function readBase(node: SceneNode): {
  x: number; y: number; rotation: number; opacity: number;
  scaleX: number; scaleY: number;
  width?: number; height?: number;
  cornerRadius?: number;
  backdropBlur?: number;
  fill?: string; text?: string; fontSize: number;
  fontFamily?: string; fontWeight?: string; fontStyle?: string;
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
    backdropBlur,
    fill,
    text,
    fontSize,
    fontFamily,
    fontWeight,
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
  } as SceneNode;
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
  const nodes = expandCompInstances(
    graph, flattenComposition(graph, comp.rootId), comp.rootId, readCompCollapse,
  ).map(materializeForFrame);
  const anySolo = nodes.some((n) => n.solo === true);

  const rawController = getTimelineController();
  const fps = rawController.timeline.getFrameRate().fps;

  // Parenting: each layer's on-screen transform is its local transform composed
  // with its parent chain's world transform (E3). Groups/nulls don't draw but
  // still participate as parents. Composition uses each node's ANIMATED local
  // values so parented children follow their parent live.
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const worldCache = new Map<string, Matrix2D>();

  // Comp-instance id indirection: a clone samples the ORIGINAL node's
  // animation tracks and timeline clips. Real nodes map to themselves.
  const srcId = (id: string): string => instanceSourceOf(nodeById.get(id)) ?? id;
  const anim: AnimationEngine = {
    sample: (id, prop, tt) => rawAnim.sample(srcId(id), prop, tt),
    evaluateNode: (id, tt) => rawAnim.evaluateNode(srcId(id), tt),
    isAnimated: (id, prop) => rawAnim.isAnimated(srcId(id), prop),
    timeSpan: (id) => rawAnim.timeSpan(srcId(id)),
    sampleData: (id: string, prop: string, tt: number) => rawAnim.sampleData(srcId(id), prop, tt),
  } as AnimationEngine;
  const controller = {
    getLayersForNode: (id: string) => rawController.getLayersForNode(srcId(id)),
  };

  // Per-layer time (E6): each layer maps comp time → its own source time
  // (stretch / reverse / freeze), so its animation is sampled at that time.
  // Default (100% / no reverse / no freeze) is identity → no behaviour change.
  const remapOf = (id: string): (tt: number) => number => {
    const hit = remapCache.get(id);
    if (hit) return hit;
    const fn = buildRemap(id);
    remapCache.set(id, fn);
    return fn;
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
    const clips = controller.getLayersForNode(id);
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
    const cfg = n ? readNodeLayerTime(n) : undefined;
    const own: (tt: number) => number = cfg
      ? (tt) => remapTime(posterized(tt), cfg, anim.timeSpan(id) ?? { start: 0, end: 1 })
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
    const gFxOwn = resolveEffectParams(readNodeRenderEffects(groupNode), (path) => {
      const v = gv?.get(path);
      return typeof v === 'number' ? v : undefined;
    });
    // Layer styles append AFTER the container's own effects — After Effects
    // evaluates layer styles after effects, and they are structured effects
    // now rather than a CSS string nothing reads.
    const gFx = [...gFxOwn, ...layerStylesToEffects(readNodeLayerStyles(groupNode), globalLight.angle, globalLight.altitude)];
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
    const authoredMask = readNodeMaskAt(groupNode, remapOf(groupNode.id)(t));
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

  // 3D: the composition camera (a Camera layer if present, else the default)
  // projects each 3D layer's plane — +z dollies + parallaxes, and X/Y rotation
  // tilts it in real perspective. Pure-2D layers skip this entirely, so their
  // output is byte-for-byte unchanged. The camera's keyframed x/y/z/focalLength
  // are sampled at the current (remapped) time via valuesOf, so animating the
  // camera pans / dollies / zooms the whole 3D scene; an unkeyframed camera
  // resolves from its static props exactly as before.
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
      );
  const project = orthoView
    ? (p: { x: number; y: number; z: number }) => Project3D.projectOrtho(p, orthoView, comp.width, comp.height)
    : (p: { x: number; y: number; z: number }) => Project3D.projectPoint(p, camera!);

  // Depth of field: layers blur by how far their depth sits from the camera's
  // focus distance (linear ramp, capped at `strength` px). Orthographic views
  // have no lens, so DOF is off.
  // Draft 3D skips DOF entirely (dof = null ⇒ withDof/dofEffectOf no-op).
  const dof = orthoView || customCamera || comp.draft3d
    ? null
    : readSceneDof(graph, comp.width, comp.height, (id, p) => valuesOf(id).get(p), comp.rootId);
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
    return { id: 'dof', type: 'blur', params: { amount: Number(blur.toFixed(1)) } };
  };

  // 2.5D cast shadows: the FIRST shadow-casting point/spot light throws a
  // soft drop-shadow off every content layer, away from the light. The layer's
  // alpha silhouette is the shadow shape (CSS drop-shadow), so text, paths and
  // masked layers all cast correctly. Keyframeable via the light's position
  // and intensity.
  const shadowLight = (() => {
    if (comp.draft3d) return null; // Draft 3D: no cast shadows.
    for (const n of nodes) {
      if (readNodeKind(n) !== 'light') continue;
      const lt = readNodeLight(n);
      if (!lt.shadows || lt.type === 'ambient') continue;
      const av = valuesOf(n.id);
      const wp = nodeWorldPosition(n);
      return {
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
      };
    }
    return null;
  })();

  /**
   * Planes that can RECEIVE a projected shadow: 3D layers whose material accepts
   * shadows, recorded as {z, depth} once the main loop has placed them.
   *
   * Filled during the layer walk below and consumed after it, because a caster
   * can only be projected onto receivers that exist — and the walk is the only
   * place a layer's resolved world z is known.
   */
  const shadowReceivers: Array<{ z: number; depth: number }> = [];
  /** Casters captured during the walk, projected onto receivers afterwards.
   *  `transmission` is Material Options → Light Transmission as 0..1: how much
   *  of the caster's own colour bleeds into its shadow (0 = a black silhouette,
   *  1 = the caster's colour, which is how stained glass and gels read). */
  const shadowCasters: Array<{ layer: RenderLayer; z: number; transmission: number }> = [];
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
  for (const n of comp.draft3d ? [] : nodes) {
    if (readNodeKind(n) !== 'light') continue;
    const lt = readNodeLight(n);
    const av = valuesOf(n.id);
    const wp = nodeWorldPosition(n);
    sceneLights.push({
      ...lt,
      intensity: av.get('intensity') ?? lt.intensity,
      radius: av.get('radius') ?? lt.radius,
      angle: av.get('lightAngle') ?? lt.angle,
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

  for (const node of nodes) {
    const kind = readNodeKind(node);
    if (kind === 'comp') {
      // A COLLAPSED instance is structural here: its layers were already
      // expanded into this walk, so the node itself draws nothing and must not
      // also mint a container — that would render its content twice, once
      // spliced and once as a card.
      const ref = readCompRef(node);
      const innerLayers =
        ref !== null && !readCompCollapse(node) ? nestedCompLayers(node, ref) : null;
      if (innerLayers) emitLayer(buildPrecompContainer(node, innerLayers), node);
      continue;
    }
    // Groups / nulls / cameras / audio are structural — they never draw.
    if (kind === 'group' || kind === 'null' || kind === 'camera' || kind === 'audio') continue;

    // AE-style layer in/out points: when the timeline has clip bars for this
    // node and NONE is active at the current frame, the layer sits outside its
    // trimmed range and must not draw. Safe now that remapOf maps sampling
    // through clip.sourceFrameAt for active clips — gating and retime agree.
    // The gate frame clamps to the last comp frame so a full-length layer
    // doesn't blink out at the exactly-end playhead (clip spans are
    // end-exclusive).
    {
      const nodeClips = controller.getLayersForNode(node.id);
      if (nodeClips.length > 0) {
        const rawFrame = Math.round(t * fps);
        // Clip spans are end-EXCLUSIVE, so a full-length layer would blink out
        // at the exactly-end playhead; clamping to the comp's last frame fixes
        // that. But the clamp is only meaningful when the caller actually told
        // us the duration. Falling back to `t` made it
        // `min(round(t·fps), round(t·fps) − 1)` — i.e. always one frame BEHIND
        // the playhead — so every clip-gated layer appeared a frame late and
        // its final frame was unreachable. Template previews, the preview
        // controller and component thumbnails all pass a comp with no
        // durationSeconds, so they rendered on that wrong axis while the
        // viewport and export (which do pass it) rendered on the right one.
        const gateFrame = comp.durationSeconds !== undefined
          ? Math.min(rawFrame, Math.max(0, Math.round(comp.durationSeconds * fps) - 1))
          : rawFrame;
        if (!nodeClips.some((l) => l.isActiveAt(gateFrame))) continue;
      }
    }

    // Draft 3D: light layers draw nothing (their glow wash IS lighting).
    if (kind === 'light' && comp.draft3d) continue;

    // Light: a radial glow at its world position, composited (screen) to
    // brighten what's beneath. Intensity / radius are keyframeable.
    if (kind === 'light') {
      const w = worldTransformOf(node.id, localOf, parentOf, worldCache);
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
      const lz = av.get('z') ?? readNode3D(node).z;
      const lp = lt.type === 'ambient'
        ? { x: comp.width / 2, y: comp.height / 2 }
        : project({ x: w.x, y: w.y, z: lz });
      emitLayer({
        id: node.id, kind: 'shape',
        x: lp.x, y: lp.y, rotation: 0, scaleX: 1, scaleY: 1, depth: 0,
        opacity: 1, width: comp.width, height: comp.height,
        fill: '#000', visible: node.visible !== false,
        light: {
          color: lt.color,
          intensity: av?.get('intensity') ?? lt.intensity,
          radius: av?.get('radius') ?? lt.radius,
          type: lt.type,
          angle: av?.get('lightAngle') ?? lt.angle,
          cone: av?.get('lightCone') ?? lt.cone,
        },
      }, node);
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
    const baseOpacity = a?.has('opacity') ? (a.get('opacity') as number) / 100 : base.opacity;
    // Resolve effect amounts once (keyframed → sampled) — the CSS `filter` for
    // Canvas2D, and the structured list attached to the layer for the GPU path.
    // readNodeRenderEffects (not readNodeEffects) so the layer's `fx` switch
    // actually silences the stack — it had no reader at all before.
    const ownEffects = resolveEffectParams(readNodeRenderEffects(node), (path) => {
      const v = a?.get(path);
      return typeof v === 'number' ? v : undefined;
    });
    // Layer styles are STRUCTURED effects appended after the layer's own stack.
    //
    // They used to be folded into the CSS `filter` string below, which no
    // backend reads — so Drop Shadow and Outer Glow rendered nothing at all,
    // and every style preset that specified them (Glass, Neon, Sticker, Long
    // Shadow, …) shipped its fills without its depth. Appending rather than
    // prepending matches AE: layer styles evaluate after effects.
    const resolvedEffects = [...ownEffects, ...layerStylesToEffects(readNodeLayerStyles(node), globalLight.angle, globalLight.altitude)];
    // The CSS form is retained for export/legacy readers only; `RenderLayer.
    // filter` is not consulted by any render path. It deliberately describes
    // the layer's OWN effects, not its styles, so the two cannot double-apply
    // if a future consumer starts reading it.
    const filter = effectsToFilter(ownEffects) || undefined;

    // A solid layer fills the whole composition (background / matte / adjustment
    // base) — pinned to comp centre at comp size, regardless of its transform.
    const isSolid = node.components.find((c) => c.type === 'fx')?.props.solid === true;
    const geomComponent = node.components.find((c) => c.type === 'Geometry');
    const staticPathPoints = geomComponent?.props.points as import('../../../packages/workspace/src/math/BezierPoint').BezierPoint[] | undefined;
    // Animated outline (data track) beats the static Geometry component — this
    // is how baked/imported vector paths (e.g. Lottie character rigs) animate
    // their vertices frame-to-frame. Mirrors the fill.stops / text.source
    // overrides below. DataPoint handles are optional; a corner collapses them
    // onto the vertex, matching BezierPoint's absolute-handle contract.
    const livePathPts = anim.sampleData(node.id, 'path.points', remapOf(node.id)(t));
    let pathPoints =
      Array.isArray(livePathPts) && livePathPts.length > 1 &&
      typeof livePathPts[0] === 'object' && livePathPts[0] !== null && 'x' in (livePathPts[0] as object)
        ? (livePathPts as Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>).map(
            (p) => ({ x: p.x, y: p.y, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y }),
          )
        : staticPathPoints;
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
    const layerW = isSolid ? comp.width : (measuredText?.w ?? (a?.has('width') ? (a.get('width') as number) : base.width) ?? size.w);
    const layerH = isSolid ? comp.height : (measuredText?.h ?? (a?.has('height') ? (a.get('height') as number) : base.height) ?? size.h);

    // Audio Waveform generator (envelope, not spectrum): a referenced audio
    // layer's precomputed peaks become this shape's live outline. Overrides any
    // static/animated path — the shape IS the waveform. Degenerate (draws
    // nothing) until the source audio has decoded. Needs layerW/H, so it runs
    // after they are resolved.
    const audioWaveformCfg = readNodeAudioWaveform(node);
    if (audioWaveformCfg) {
      pathPoints = resolveAudioWaveformPoints(audioWaveformCfg, layerW, layerH, remapOf(node.id)(t));
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
      const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
      const X = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
      const Y = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
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
    if (baseStroke && a?.has('stroke_r')) {
      const r = a.get('stroke_r') ?? 0;
      const g = a.get('stroke_g') ?? 0;
      const b = a.get('stroke_b') ?? 0;
      const alpha = a.get('stroke_a') ?? 1;
      finalStroke = { ...baseStroke, color: Color.toHex({ r, g, b, a: alpha }) };
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
      mask: readNodeMaskAt(node, remapOf(node.id)(t)),
      matte: readNodeMatte(node),
      isAdjustment: readNodeAdjustment(node) || undefined,
      quality: readNodeQuality(node) === 'draft' ? 'draft' : undefined,
      paint: readNodePaint(node) ?? undefined,
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
        if (readNodeLayerTime(node)?.frameBlend !== 'mix') return undefined;
        if (layerKind !== 'video') return undefined;
        const st = (() => {
          const remapped = anim.sample(node.id, 'timeRemap', t) ?? anim.sample(node.id, 'precompTime', t);
          return remapOf(node.id)(remapped !== undefined ? remapped : t);
        })();
        const bracket = bracketFrames(st, fps);
        // Exactly on a frame boundary there is nothing to blend toward.
        return bracket.weight > 1e-3 ? bracket : undefined;
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
      x: isSolid && !is3D ? comp.width / 2 : px,
      y: isSolid && !is3D ? comp.height / 2 : py,
      rotation: isSolid && !is3D ? 0 : rot,
      scaleX: isSolid && !is3D ? 1 : sx,
      scaleY: isSolid && !is3D ? 1 : sy,
      matrix: isSolid && !is3D ? undefined : matrix,
      world3d: isSolid && !is3D ? undefined : world3d,
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
      visible: node.visible !== false && (!anySolo || node.solo === true),
      primitive: pathPoints
        ? 'path'
        : isSolid
          ? 'rect'
          : (shapeType === 'ellipse' || (!shapeType && /circle|ellip|dot|orb/.test(name)))
            ? 'ellipse'
            : 'rect',
      cornerRadius: base.cornerRadius,
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
      fontWeight: base.fontWeight,
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
      filter: isSolid || !readNodeMaterial(node).castsShadows
        ? withDof(filter, is3D ? depth : undefined)
        : withShadow(withDof(filter, is3D ? depth : undefined), px, py),
      effects: resolvedEffects.length ? resolvedEffects : undefined,
      // Heal absolute backend URLs baked into older documents → same-origin path.
      // Resolution order lives in rigMeshInputs so the puppet overlay resolves
      // the SAME source this layer draws (its coverage mask is keyed off it).
      src: resolveRigImageSrc(node, kind, base, remapOf(node.id)(t), (id) => assetById().get(id)),
      assetId: base.assetId,
    };

    // Per-quad Lambert lighting (Material Options → Accepts Lights, default
    // off): the plane normal comes from the layer's 3D world matrix; the
    // accumulated light gain rides the layer as an RGB multiplier which the
    // adapter folds into the draw tint — identical on the GPU depth path and
    // the affine fallback. No lights in the scene ⇒ identity ⇒ nothing added.
    if (is3D && world3d && sceneLights.length > 0) {
      const mat = readNodeMaterial(node);
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
      const silhouette = silhouetteFromPathPoints(pathPoints, pathOpen);
      const coverage = rigCoverageMask(layerKind, layer.src, base.assetId, silhouette);
      // ONE shared rest mesh. Puppet mesh settings win when a puppet rig exists
      // (its pin weights are baked into the mesh); a skeleton-only layer reads
      // density/expansion off its own config.
      const meshRig = hasPuppet
        ? puppetRig!
        : { pins: [], meshDensity: skelRig!.meshDensity, meshExpansion: skelRig!.meshExpansion };
      const restMesh = getCachedRestMesh(
        node.id,
        layer.width ?? 100,
        layer.height ?? 100,
        pad,
        meshRig,
        silhouette,
        coverage
      );
      const rigT = layer.sourceTime ?? t;

      let deformedVertices = restMesh.vertices;
      let overlapDepth: Float32Array | null = null;

      if (hasPuppet) {
        const animatedPins = puppetRig!.pins.map((pin) => {
          // Sample dynamic position from data track, falling back to static pin position
          const livePos = anim.sampleData(node.id, `puppet.${pin.id}.position`, rigT);
          let px = pin.x;
          let py = pin.y;
          if (Array.isArray(livePos) && livePos.length > 0 && livePos[0] && typeof livePos[0] === 'object' && 'x' in livePos[0]) {
            const pt = livePos[0] as { x: number; y: number };
            px = pt.x;
            py = pt.y;
          }
          // Rotation / stiffness: scalar keyframe tracks (puppet.<pinId>.rotation
          // and.stiffness), falling back to the pin's static values.
          const liveRot = anim.sample(node.id, `puppet.${pin.id}.rotation`, rigT);
          const liveStiff = anim.sample(node.id, `puppet.${pin.id}.stiffness`, rigT);
          const liveScale = anim.sample(node.id, `puppet.${pin.id}.scale`, rigT);
          const liveOverlap = anim.sample(node.id, `puppet.${pin.id}.overlap`, rigT);
          return {
            id: pin.id,
            x: px,
            y: py,
            rotation: typeof liveRot === 'number' ? liveRot : pin.rotation,
            stiffness: typeof liveStiff === 'number' ? liveStiff : pin.stiffness,
            scale: typeof liveScale === 'number' ? liveScale : pin.scale,
            overlap: typeof liveOverlap === 'number' ? liveOverlap : pin.overlap,
            overlapExtent: pin.overlapExtent,
          };
        });
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
        const animatedBones: Bone[] = skelRig!.bones.map((b) => {
          const liveRot = anim.sample(node.id, `bone.${b.id}.rotation`, rigT);
          const liveX = anim.sample(node.id, `bone.${b.id}.x`, rigT);
          const liveY = anim.sample(node.id, `bone.${b.id}.y`, rigT);
          // Bone scale is keyframeable too — `scaleX/scaleY` already fed
          // `fromTRS`, but nothing ever sampled a track for them, so squash /
          // stretch on a limb was unreachable.
          const liveSx = anim.sample(node.id, `bone.${b.id}.scaleX`, rigT);
          const liveSy = anim.sample(node.id, `bone.${b.id}.scaleY`, rigT);
          return {
            ...b,
            rotation: typeof liveRot === 'number' ? liveRot : b.rotation,
            x: typeof liveX === 'number' ? liveX : b.x,
            y: typeof liveY === 'number' ? liveY : b.y,
            scaleX: typeof liveSx === 'number' ? liveSx : b.scaleX,
            scaleY: typeof liveSy === 'number' ? liveSy : b.scaleY,
          };
        });
        // IK: each enabled target overrides its chain's rotations so the end
        // bone's tip reaches the (keyframeable) target position.
        const ikTargets: IkTargetResolved[] = (skelRig!.ikTargets ?? [])
          .filter((tg) => tg.enabled !== false)
          .map((tg) => {
            const liveX = anim.sample(node.id, `ikTarget.${tg.boneId}.x`, rigT);
            const liveY = anim.sample(node.id, `ikTarget.${tg.boneId}.y`, rigT);
            const poleX = anim.sample(node.id, `ikPole.${tg.boneId}.x`, rigT);
            const poleY = anim.sample(node.id, `ikPole.${tg.boneId}.y`, rigT);
            const pole =
              typeof poleX === 'number' || typeof poleY === 'number'
                ? { x: typeof poleX === 'number' ? poleX : (tg.pole?.x ?? 0),
                    y: typeof poleY === 'number' ? poleY : (tg.pole?.y ?? 0) }
                : tg.pole;
            return {
              boneId: tg.boneId,
              x: typeof liveX === 'number' ? liveX : tg.x,
              y: typeof liveY === 'number' ? liveY : tg.y,
              chainLength: tg.chainLength,
              ...(pole ? { pole } : {}),
            };
          });
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

    // Path operators (MG Phase C): deform the shape outline into a new path
    // (zig-zag / round corners), keyframeable. Replaces the primitive with the
    // deformed polyline so the renderer draws (and trims/repeats) the result.
    if (layerKind === 'shape') {
      const op = resolvePathOp(node, a);
      if (op && op.type !== 'none') {
        // Pucker/twist deform every vertex, so a rect needs a denser outline.
        const dense = op.type === 'pucker' || op.type === 'twist' ? 8 : 0;
        const base = pathPoints && pathPoints.length > 1
          ? pathPoints.map((p) => ({ x: p.x, y: p.y }))
          : shapeOutline(layer.primitive, layerW, layerH, 48, dense);
        layer.pathPoints = applyPathOp(base, true, op).map((p) => corner(p.x, p.y));
        layer.primitive = 'path';
      }
    }

    // Trim path (MG Phase C): visible outline arcs, resolved with any animated
    // start/end/offset. The backend strokes only these portions.
    const trimCfg = resolveTrim(node, a);
    if (trimCfg) {
      const segs = trimSegments(trimCfg.start, trimCfg.end, trimCfg.offset);
      if (!(segs.length === 1 && segs[0]![0] === 0 && segs[0]![1] === 1)) layer.trim = segs;
    }

    // Motion blur: sub-frame transform samples for a moving, opted-in layer.
    if (motionBlur?.enabled && readNodeMotionBlur(node) && moves(anim, node.id)) {
      // 3D layers need a matrix per sample (see affineAt). The sub-frame world
      // position is the layer's world position plus its own local delta over
      // the shutter — the parent chain is treated as static across the
      // interval, which is exact unless a parent is also moving.
      const localX = (a?.get('x') as number | undefined) ?? base.x;
      const localY = (a?.get('y') as number | undefined) ?? base.y;
      const localRot = (a?.get('rotation') as number | undefined) ?? base.rotation;
      const matrixAt = is3D
        ? (ti: number): readonly [number, number, number, number, number, number] => {
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
            ).matrix;
          }
        : undefined;
      const samples = sampleMotion(anim, node.id, base, ghost, t, motionBlur, remapOf(node.id), matrixAt);
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
      const mat = readNodeMaterial(node);
      if (!isSolid && mat.castsShadows) {
        // A 3D layer under a shadow-casting light gets a REAL projected shadow
        // (emitted after this walk, once every receiver plane is known). The
        // screen-space drop-shadow stays for 2D layers, where there is no depth
        // to project through and it is the only thing that reads as a shadow.
        if (is3D && shadowLight) {
          shadowCasters.push({ layer, z: z3, transmission: mat.lightTransmission / 100 });
        } else {
          const castFx = shadowEffectOf(px, py);
          if (castFx) gpuFx.push(castFx);
        }
      }
      if (is3D && mat.acceptsShadows) shadowReceivers.push({ z: z3, depth });
      // AE's `Only` modes — how shadow-catcher setups are built. The layer stays
      // fully present as a caster and/or receiver (both lists are already
      // populated above), it just isn't drawn: `Casts Shadows: Only` throws a
      // shadow from an invisible object, `Accepts Shadows: Only` catches one
      // onto transparency so it can be comped over live footage.
      if (mat.shadowOnly) layer.visible = false;
      if (gpuFx.length > 0) layer.effects = [...(layer.effects ?? []), ...gpuFx];
    }

    // Echo (temporal): emit decaying ghost copies at PAST (or future) sampled
    // transforms, behind the main layer. Deterministic — a pure function of the
    // animation, so scrubbing is stable and no frame cache is needed — and it
    // renders on both backends because the ghosts are ordinary render layers.
    const echo = readEchoConfig(resolvedEffects);
    if (echo && echo.count > 0 && echo.time !== 0) {
      const eLocalX = (a?.get('x') as number | undefined) ?? base.x;
      const eLocalY = (a?.get('y') as number | undefined) ?? base.y;
      const eLocalRot = (a?.get('rotation') as number | undefined) ?? base.rotation;
      // Oldest first (farthest back), so nearer echoes paint over them and the
      // current layer lands on top.
      for (let k = echo.count; k >= 1; k--) {
        const ti = t + k * echo.time;
        if (ti < 0) continue;
        const op = layer.opacity * echo.startIntensity * Math.pow(echo.decay, k - 1);
        if (op <= 0.002) continue;
        const gx = px + ((anim.sample(node.id, 'x', ti) ?? eLocalX) - eLocalX);
        const gy = py + ((anim.sample(node.id, 'y', ti) ?? eLocalY) - eLocalY);
        const grot = rot + ((anim.sample(node.id, 'rotation', ti) ?? eLocalRot) - eLocalRot);
        const ghost: RenderLayer = {
          ...layer,
          id: `${layer.id}__echo${k}`,
          opacity: op,
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
        emitLayer(ghost, node);
      }
    }

    // Shape repeater (MG Phase C): emit N cumulative copies. Copy 0 is the base
    // layer; each further copy is a translated/rotated/scaled/faded clone. Pure
    // visual duplicates — they don't participate in matte/adjustment ordering.
    const rep = !isSolid && !is3D ? resolveRepeater(node, a) : null;
    if (rep && rep.copies > 1) {
      for (const c of repeaterCopies(rep)) {
        if (c.index === 0) {
          emitLayer(layer, node);
          continue;
        }
        emitLayer({
          ...layer,
          id: `${layer.id}__rep${c.index}`,
          x: px + c.dx,
          y: py + c.dy,
          rotation: rot + c.drot,
          scaleX: sx * c.scaleMul,
          scaleY: sy * c.scaleMul,
          opacity: layer.opacity * c.opacityMul,
          matte: undefined,
          isMatteSource: undefined,
          isAdjustment: undefined,
        }, node);
      }
    } else {
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
      if (is3D && world3d && extrusionDepth > 0) {
        const isComplexContent =
          layer.kind === 'text' ||
          (layer.kind === 'shape' && layer.primitive !== 'rect' && layer.primitive !== 'ellipse');

        const extMat = readNodeMaterial(node);
        // Per-face materials (front / side / bevel / back). Absent → the previous
        // single-colour behaviour, since resolveFaceMaterial falls back to the
        // layer fill × the kind's original hardcoded gain.
        const faceMats = readNodeFaceMaterials(node);
        const extLit = extMat.acceptsLights && sceneLights.length > 0;
        const wallFill = typeof layer.fill === 'string' ? layer.fill : EXTRUSION_WALL_FALLBACK_FILL;

        if (isComplexContent) {
          // Contour Volume Extrusion: For text and complex shapes, slice the
          // depth axis (z ∈ [1, extrusionDepth]) into continuous slices matching the exact
          // glyph/path silhouette so text extrudes as a solid 3D body without empty gaps.
          const stepPx = 1.5;
          const sliceCount = Math.min(45, Math.max(2, Math.ceil(extrusionDepth / stepPx)));
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
              effects: undefined,
              matte: undefined,
              isMatteSource: undefined,
              isAdjustment: undefined,
              motionSamples: undefined,
              deformedMesh: undefined,
              frameBlend: undefined,
              fill: resolveFaceMaterial(faceMats, isBackCap ? 'back' : 'side', wallFill).fill,
            };

            if (extLit) {
              const lg = shadeLayer(planeNormalOf(M), { x: world.x, y: world.y, z: z3 }, sceneLights);
              if (lg) {
                sliceLayer.lighting = lg;
                sliceLayer.shade3d = { specular: extMat.specular / 100, shininess: extMat.shininess };
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
          const bevel = extShape === 'rect' ? clampBevel(layerW, layerH, extrusionDepth, bevelRequested) : 0;
          frontInset = bevel;

          // Corner radius drives the extruded OUTLINE too, so a rounded card
          // is a rounded solid rather than a rounded face on a square block.
          const extCorner = extShape === 'rect' ? (layer.cornerRadius ?? 0) : 0;
          for (const f of extrusionFaces(layerW, layerH, extrusionDepth, extShape, undefined, { bevel: bevelRequested, bevelStyle: d3.bevelStyle, cornerRadius: extCorner })) {
            const M = Matrix4Math.multiply(
              world3d as import('@motion/scene').Matrix4,
              f.m,
            );
            const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
            const FX = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
            const FY = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
            const fm = [FX.x - O.x, FX.y - O.y, FY.x - O.x, FY.y - O.y, O.x, O.y] as const;
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
              effects: undefined,
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
                  fill: resolveFaceMaterial(faceMats, faceKindOf(f.role, f.suffix), wallFill).fill,
                  visible: layer.visible,
                  // Flat strips along the outline — no corner radius of their
                  // own. (The back cap takes the branch above, which spreads
                  // `layer` and so already carries the layer's radius.)
                  primitive: 'rect',
                };
            if (extLit) {
              const lg = shadeLayer(planeNormalOf(M), { x: world.x, y: world.y, z: z3 }, sceneLights);
              if (lg) {
                faceLayer.lighting = lg;
                faceLayer.shade3d = { specular: extMat.specular / 100, shininess: extMat.shininess };
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
        const pcMat = readNodeMaterial(node);
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
              glyphLayer.shade3d = { specular: pcMat.specular / 100, shininess: pcMat.shininess };
            }
          }
          emitLayer(glyphLayer, node);
        }
      } else if (frontInset > 0) {
        emitLayer({ ...layer, width: layerW - 2 * frontInset, height: layerH - 2 * frontInset }, node);
      } else {
        emitLayer(layer, node);
      }
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
  if (shadowLight && shadowCasters.length > 0 && shadowReceivers.length > 0) {
    const strength = Math.max(0, Math.min(1, (shadowLight.intensity / 100) * shadowLight.darkness));
    if (strength > 0) {
      const L = shadowLight;
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

        shadowLayers.push({
          ...src,
          id: `${src.id}::shadow`,
          // The caster may be hidden (`Casts Shadows: Only`) — its SHADOW is
          // the whole point, so it must not inherit that invisibility.
          visible: true,
          // Scale about the light, in world space.
          x: L.x + (src.x - L.x) * t,
          y: L.y + (src.y - L.y) * t,
          scaleX: src.scaleX * t,
          scaleY: src.scaleY * t,
          // Flatten onto the receiver: no matrix/world3d, so it draws as a plain
          // quad on that plane instead of re-projecting through its own 3D pose.
          matrix: undefined,
          world3d: undefined,
          depth: receiver.depth - 0.5, // just in front of the surface it lands on
          opacity,
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
        const sourceId = getMatteSourceId(l.matte);
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
    let run: RenderLayer[] = [];
    const flushRun = (): void => {
      run.sort((p, q) => (q.depth ?? 0) - (p.depth ?? 0));
      sorted.push(...run);
      run = [];
    };
    for (let i = 0; i < layers.length; i++) {
      if (locked[i]) { flushRun(); sorted.push(layers[i]!); }
      else run.push(layers[i]!);
    }
    flushRun();
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
    layers,
    overlays,
    view,
    camera3d,
    lights3d,
  };
}

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
  /** 3D only: the projected affine at a sample time. Without it the backend
   *  would use the layer's single baked matrix for every sample and blur
   *  nothing. */
  matrixAt?: (ti: number) => readonly [number, number, number, number, number, number],
): MotionSample[] {
  const times = motionBlurSampleTimes(t, cfg.fps, cfg.shutterAngle, cfg.samples, cfg.shutterPhase ?? -90, cfg.adaptiveSampleLimit ?? 128);
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
      ...(matrixAt ? { matrix: matrixAt(ti) } : {}),
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
    const sourceId = getMatteSourceId(layer.matte);
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
