/**
 * SnapshotBuilder — projects (SceneGraph + animated values @ time) into an
 * immutable RenderSnapshot (TAD §6.4.3). Pure: reads only, mutates nothing.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { flattenComposition, readNodeKind, KIND_FILL } from '@core/scene/sceneDerive';
import { readNodeRenderEffects, effectsToFilter, resolveEffectParams, type Effect } from '@core/effects/effects';
import { readNodeLayerStyles, layerStylesToFilter } from '@core/effects/layerStyles';
import { readNodeBlend } from '@core/effects/blendMode';
import { readNodeMaskAt } from '@core/effects/mask';
import { readNodeMatte, getMatteSourceId } from '@core/effects/matte';
import { readNodeAdjustment } from '@core/effects/adjustment';
import { readNodeMotionBlur, motionBlurSampleTimes, type MotionBlurConfig } from '@core/effects/motionBlur';
import { readNodeFill, readNodeFills, type FillPaint } from '@core/paint/fill';
import { readNodeStroke, readNodeRenderStrokes } from '@core/paint/stroke';
import { assetUrl } from '@core/api/client';
import { useAssetStore } from '@stores/assetStore';
import { worldTransformOf, type LocalOf, type ParentOf } from '@core/scene/worldTransform';
import { readNodeLayerTime, remapTime } from '@core/scene/layerTime';
import { readNode3D, is3DEnabled } from '@core/scene/threeD';
import { readNodeAutoOrient } from '@core/scene/autoOrient';
import { autoOrientAngleDeg } from '@core/motion/motionPath';
import { resolveRepeater, repeaterCopies } from '@core/scene/repeater';
import { resolveTrim, trimSegments } from '@core/scene/trimPath';
import { nearestPrecompRoot, precompAncestorChain } from '@core/scene/precomp';
import { readNodeAnchor } from '@core/scene/anchor';
import { readNodeLight } from '@core/scene/light';
import { readNodeParticle, resolveParticleConfig } from '@core/particles/particleSim';
import { measureTextNodeSize } from '@core/text/measureText';
import { readEchoConfig } from '@core/effects/echo';
import { readNodeQuality } from '@core/effects/layerQuality';
import { readNodeMaterial } from '@core/scene/material';
import { readNodePaint } from '@core/paint/paintStrokes';
import { readNodeSequence, sequenceSrcAt } from '@core/scene/imageSequence';
import { resolvePathOp, applyPathOp, shapeOutline } from '@core/scene/pathOps';
import { corner } from '../../../packages/workspace/src/math/BezierPoint';
import { resolveAnimators, evaluateTextAnimators } from '@core/text/textAnimators';
import { readRuns, normalizeRuns } from '@core/text/richText';
import { resolveTextPath, resolveTextPathMask, flattenMaskPath } from '@core/text/textPath';
import { bracketFrames } from './videoFrameCache';
import { readSceneCamera, readSceneDof, dofBlurPx } from '@core/scene/camera3d';
import { expandCompInstances, instanceSourceOf } from '@core/scene/compInstance';
import type { PropPath } from '@motion/animation';
import { Project3D, Matrix4Math, type Matrix2D } from '@motion/scene';
import { Color } from '@motion/renderer';

import { getTimelineController } from '@core/timeline/TimelineController';

const DEG = Math.PI / 180;
import type { MotionSample } from './RenderBackend';
import type { AnimationEngine } from '@motion/animation';
import type { RenderSnapshot, RenderLayer, LayerKind } from './RenderBackend';
import { contentHashOf } from './contentHash';
import { rasterPadding } from './raster/vectorDraw';
import { readNodePuppet, getCachedRestMesh, deform, silhouetteFromPathPoints } from '../rig/puppet';
import { readNodeAudioWaveform, resolveAudioWaveformPoints } from '@core/audio/audioWaveformGen';
import { readNodeSkeleton } from '../rig/skeletonCommands';
import { computeWorldTransforms, type Bone } from '../rig/skeleton';
import { applyIk, getSkeletonBinding, skinRigVertices, type IkTargetResolved } from '../rig/rigDeform';
import { getImageCoverageMask } from './imageAlphaCoverage';

const COMP_WIDTH = 1920;
const COMP_HEIGHT = 1080;
const COMP_BG = '#101014';

/** Comp-level render inputs. When omitted, the hardcoded defaults are used so
 *  headless callers (export presets, tests) keep working unchanged. */
export interface SnapshotComp {
  width: number;
  height: number;
  background: string;
  /** Rich background paint (gradient). When set, the Canvas2D backend paints
   *  this over the flat `background`. Undefined = plain solid `background`. */
  backgroundPaint?: FillPaint;
  transparent?: boolean;
  camera3dMode?: 'active' | Project3D.OrthoView;
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
  fill?: string; text?: string; fontSize: number;
  fontFamily?: string; fontWeight?: string; fontStyle?: string;
  letterSpacing?: number; lineHeight?: number; align?: string;
  paragraphSpacing?: number;
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
  let src: string | undefined;
  let assetId: string | undefined;
  let color: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let cornerRadius: number | undefined;
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
    if (typeof p.src === 'string') src = p.src;
    if (typeof p.assetId === 'string') assetId = p.assetId;
    if (typeof p.color === 'string') color = p.color;
    width = num(p.width) ?? width;
    height = num(p.height) ?? height;
    if (num(p.cornerRadius) !== undefined) cornerRadius = num(p.cornerRadius);
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

/** Opacity multiplier applied to layers that are ghosted in Focus Mode. */
const GHOST_OPACITY = 0.12;

export interface SnapshotFocus {
  /** Returns true when a node should render as a dim ghost reference. */
  isGhost: (nodeId: string) => boolean;
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

  // Solo (AE-style): when any node is soloed, only soloed nodes render.
  // Scoped to the active composition's root — other comps are separate subtrees.
  // Comp instances expand into render-only clones of their referenced comp's
  // subtree (routed through the precomp path); clones carry `__instanceSource`
  // so animation and clips sample the ORIGINAL nodes via `srcId` below.
  const nodes = expandCompInstances(graph, flattenComposition(graph, comp.rootId), comp.rootId);
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

    // Per-layer time (E6): stretch / reverse / freeze on the node itself.
    const cfg = n ? readNodeLayerTime(n) : undefined;
    const own: (tt: number) => number = cfg
      ? (tt) => remapTime(baseMap(tt), cfg, anim.timeSpan(id) ?? { start: 0, end: 1 })
      : (tt) => baseMap(tt);
    // Precomp time remap (Prompt 10): a layer inside a precomp whose group has a
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
    return {
      x: av.get('x') ?? b.x,
      y: av.get('y') ?? b.y,
      rotation: av.get('rotation') ?? b.rotation,
      scaleX: sc ?? b.scaleX,
      scaleY: sc ?? b.scaleY,
    };
  };
  const parentOf: ParentOf = (id) => nodeById.get(id)?.parent ?? null;

  // Precomp routing (Prompt 10): a layer whose node sits inside a precomp group
  // is collected into that group's texture instead of the top-level comp. The
  // precomp container layer is emitted (once) at the first descendant's position
  // and itself routed, so nested precomps nest correctly.
  const precompInner = new Map<string, RenderLayer[]>();
  const precompEmitted = new Set<string>();
  const buildPrecompContainer = (groupNode: SceneNode): RenderLayer => {
    const gv = valuesOf(groupNode.id);
    const gBase = readBase(groupNode);
    const inner = precompInner.get(groupNode.id) ?? [];
    // Resolve the container's effect stack once — the CSS string stays for
    // tests/legacy readers, the structured list is what the GPU path renders
    // (without it a precomp's effects were silently dropped on composite).
    const gFx = resolveEffectParams(readNodeRenderEffects(groupNode), (path) => {
      const v = gv?.get(path);
      return typeof v === 'number' ? v : undefined;
    });
    const filter = [
      effectsToFilter(gFx),
      layerStylesToFilter(readNodeLayerStyles(groupNode)),
    ].filter(Boolean).join(' ') || undefined;
    return {
      id: groupNode.id,
      kind: 'shape',
      blend: readNodeBlend(groupNode),
      mask: readNodeMaskAt(groupNode, remapOf(groupNode.id)(t)),
      matte: readNodeMatte(groupNode),
      x: comp.width / 2,
      y: comp.height / 2,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      depth: 0,
      opacity: gv?.has('opacity') ? (gv.get('opacity') as number) / 100 : gBase.opacity,
      width: comp.width,
      height: comp.height,
      fill: '#000',
      visible: groupNode.visible !== false,
      filter,
      effects: gFx.length ? gFx : undefined,
      precompLayers: inner,
      sourceTime: (() => {
        const remapped = anim.sample(groupNode.id, 'timeRemap', t) ?? anim.sample(groupNode.id, 'precompTime', t);
        if (remapped !== undefined) return remapOf(groupNode.id)(remapped);
        return remapOf(groupNode.id)(t);
      })(),
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
  const camera = orthoView
    ? null
    : readSceneCamera(graph, comp.width, comp.height, (id, p) => valuesOf(id).get(p));
  const project = orthoView
    ? (p: { x: number; y: number; z: number }) => Project3D.projectOrtho(p, orthoView, comp.width, comp.height)
    : (p: { x: number; y: number; z: number }) => Project3D.projectPoint(p, camera!);

  // Depth of field: layers blur by how far their depth sits from the camera's
  // focus distance (linear ramp, capped at `strength` px). Orthographic views
  // have no lens, so DOF is off.
  const dof = orthoView ? null : readSceneDof(graph, comp.width, comp.height, (id, p) => valuesOf(id).get(p));
  const withDof = (f: string | undefined, depth: number): string | undefined => {
    if (!dof) return f;
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
    for (const n of nodes) {
      if (readNodeKind(n) !== 'light') continue;
      const lt = readNodeLight(n);
      if (!lt.shadows || lt.type === 'ambient') continue;
      const av = valuesOf(n.id);
      const g = readBase(n);
      return {
        x: av.get('x') ?? g.x,
        y: av.get('y') ?? g.y,
        intensity: av.get('intensity') ?? lt.intensity,
      };
    }
    return null;
  })();
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
    const strength = Math.max(0, Math.min(1, shadowLight.intensity / 100));
    const off = 6 + 10 * strength;
    const s = `drop-shadow(${(dx * off).toFixed(1)}px ${(dy * off).toFixed(1)}px ${(6 + 8 * strength).toFixed(0)}px rgba(0,0,0,${(0.45 * strength).toFixed(2)}))`;
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
    const strength = Math.max(0, Math.min(1, shadowLight.intensity / 100));
    if (strength <= 0) return null;
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return {
      id: 'cast-shadow',
      type: 'drop-shadow',
      params: {
        distance: Number((6 + 10 * strength).toFixed(1)),
        angle: Number(angle.toFixed(1)),
        softness: Number((6 + 8 * strength).toFixed(0)),
        color: '#000000',
        opacity: Number((45 * strength).toFixed(1)),
      },
    };
  };

  for (const node of nodes) {
    const kind = readNodeKind(node);
    // Groups / nulls / cameras / audio are structural — they never draw.
    if (kind === 'group' || kind === 'null' || kind === 'camera' || kind === 'audio' || kind === 'comp') continue;

    // AE-style layer in/out points: when the timeline has clip bars for this
    // node and NONE is active at the current frame, the layer sits outside its
    // trimmed range and must not draw. Safe now that remapOf() maps sampling
    // through clip.sourceFrameAt for active clips — gating and retime agree.
    // The gate frame clamps to the last comp frame so a full-length layer
    // doesn't blink out at the exactly-end playhead (clip spans are
    // end-exclusive).
    {
      const nodeClips = controller.getLayersForNode(node.id);
      if (nodeClips.length > 0) {
        const lastFrame = Math.max(0, Math.round((comp.durationSeconds ?? t) * fps) - 1);
        const gateFrame = Math.min(Math.round(t * fps), lastFrame);
        if (!nodeClips.some((l) => l.isActiveAt(gateFrame))) continue;
      }
    }

    // Light: a radial glow at its world position, composited (screen) to
    // brighten what's beneath. Intensity / radius are keyframeable.
    if (kind === 'light') {
      const w = worldTransformOf(node.id, localOf, parentOf, worldCache);
      const av = valuesOf(node.id);
      const lt = readNodeLight(node);
      emitLayer({
        id: node.id, kind: 'shape',
        x: w.x, y: w.y, rotation: 0, scaleX: 1, scaleY: 1, depth: 0,
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
      if (staticCfg) {
        // Per-param keyframing: every numeric field (and the two colors, via
        // channel tracks) samples its `particle.<key>` track at this frame.
        const cfg = resolveParticleConfig(staticCfg, (path) => pv?.get(path));
        emitLayer({
          id: node.id, kind: 'shape',
          x: w.x, y: w.y, rotation: w.rotation, scaleX: w.scaleX, scaleY: w.scaleY, depth: 0,
          opacity: pOpacity, width: comp.width, height: comp.height,
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
    const layerKind = (kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video')
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
    const resolvedEffects = resolveEffectParams(readNodeRenderEffects(node), (path) => {
      const v = a?.get(path);
      return typeof v === 'number' ? v : undefined;
    });
    const filter = [
      effectsToFilter(resolvedEffects),
      layerStylesToFilter(readNodeLayerStyles(node)),
    ].filter(Boolean).join(' ') || undefined;

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
    
    // Text layers with no explicit size use their MEASURED content box (point
    // text) — the fixed SIZE.text fallback boxed every text layer at 320×80
    // while the glyphs drew at natural width, overflowing the outline, the hit
    // box, masks and layer-style extents.
    const measuredText = layerKind === 'text' && base.width === undefined && !a?.has('width')
      ? measureTextNodeSize(node)
      : null;
    const layerW = isSolid ? comp.width : ((a?.has('width') ? (a.get('width') as number) : base.width) ?? measuredText?.w ?? size.w);
    const layerH = isSolid ? comp.height : ((a?.has('height') ? (a.get('height') as number) : base.height) ?? measuredText?.h ?? size.h);

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
    const is3D = !isSolid && is3DEnabled(node);
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
    ): { matrix: readonly [number, number, number, number, number, number]; O: Project3D.Projected } => {
      const M = Matrix4Math.compose({
        position: { x: wx, y: wy, z: wz },
        // AE composes Orientation THEN Rotation about the same anchor; summing
        // the euler angles per axis gives the identical composed facing. Anchor
        // x/y are applied at draw time (RenderLayer.anchorX/Y) so only anchorZ
        // enters the matrix — dropping it was why anchor-Z did nothing.
        rotation: { x: (rX + oriX) * DEG, y: (rY + oriY) * DEG, z: (rZ + oriZ) * DEG },
        scale: { x: sX, y: sY, z: 1 },
        anchor: { x: 0, y: 0, z: anchorZ },
      });
      const O = project(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
      const X = project(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
      const Y = project(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
      return { matrix: [X.x - O.x, X.y - O.y, Y.x - O.x, Y.y - O.y, O.x, O.y], O };
    };

    let matrix: readonly [number, number, number, number, number, number] | undefined;
    // Painter depth (distance from camera); far layers draw first.
    let depth = project({ x: world.x, y: world.y, z: z3 }).depth;
    if (is3D) {
      const { matrix: m, O } = affineAt(world.x, world.y, z3, rotX, rotY, world.rotation, scaleX, scaleY);
      matrix = m;
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
    let finalFill = base.fill ?? KIND_FILL[kind];
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
      x: isSolid ? comp.width / 2 : px,
      y: isSolid ? comp.height / 2 : py,
      rotation: isSolid ? 0 : rot,
      scaleX: isSolid ? 1 : sx,
      scaleY: isSolid ? 1 : sy,
      matrix: isSolid ? undefined : matrix,
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
      pathPoints,
      pathOpen: pathOpen || undefined,
      // Source Text keyframes (hold-interpolated data track, like AE) beat the
      // component's static content.
      text: (() => {
        const live = anim.sampleData(node.id, 'text.source', remapOf(node.id)(t));
        return typeof live === 'string' ? live : base.text;
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
      filter: isSolid || !readNodeMaterial(node).castsShadows
        ? withDof(filter, depth)
        : withShadow(withDof(filter, depth), px, py),
      effects: resolvedEffects.length ? resolvedEffects : undefined,
      // Heal absolute backend URLs baked into older documents → same-origin path.
      src: (() => {
        // Image sequence: pick the frame for this layer's source time (holds the
        // last frame past the end). Deterministic — scrubbing is stable.
        const seq = readNodeSequence(node);
        if (seq) return assetUrl(sequenceSrcAt(seq, remapOf(node.id)(t)));
        if (base.assetId) {
          const asset = useAssetStore.getState().assets.find((a) => a.id === base.assetId);
          if (asset && asset.src) return asset.src;
        }
        return assetUrl(base.src);
      })(),
      assetId: base.assetId,
    };

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
      const coverage = (!silhouette && layerKind === 'image' && layer.src)
        ? getImageCoverageMask(base.assetId ?? layer.src, layer.src)
        : undefined;
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
          // and .stiffness), falling back to the pin's static values.
          const liveRot = anim.sample(node.id, `puppet.${pin.id}.rotation`, rigT);
          const liveStiff = anim.sample(node.id, `puppet.${pin.id}.stiffness`, rigT);
          return {
            id: pin.id,
            x: px,
            y: py,
            rotation: typeof liveRot === 'number' ? liveRot : pin.rotation,
            stiffness: typeof liveStiff === 'number' ? liveStiff : pin.stiffness,
          };
        });
        deformedVertices = deform(animatedPins, restMesh, puppetRig!.solver ?? 'arap');
      }

      if (hasSkel) {
        // FK: sample the bone tracks (rotation stored in radians — the unit
        // fromTRS consumes; the UI converts at the display boundary).
        const animatedBones: Bone[] = skelRig!.bones.map((b) => {
          const liveRot = anim.sample(node.id, `bone.${b.id}.rotation`, rigT);
          const liveX = anim.sample(node.id, `bone.${b.id}.x`, rigT);
          const liveY = anim.sample(node.id, `bone.${b.id}.y`, rigT);
          return {
            ...b,
            rotation: typeof liveRot === 'number' ? liveRot : b.rotation,
            x: typeof liveX === 'number' ? liveX : b.x,
            y: typeof liveY === 'number' ? liveY : b.y,
          };
        });
        // IK: each enabled target overrides its chain's rotations so the end
        // bone's tip reaches the (keyframeable) target position.
        const ikTargets: IkTargetResolved[] = (skelRig!.ikTargets ?? [])
          .filter((tg) => tg.enabled !== false)
          .map((tg) => {
            const liveX = anim.sample(node.id, `ikTarget.${tg.boneId}.x`, rigT);
            const liveY = anim.sample(node.id, `ikTarget.${tg.boneId}.y`, rigT);
            return {
              boneId: tg.boneId,
              x: typeof liveX === 'number' ? liveX : tg.x,
              y: typeof liveY === 'number' ? liveY : tg.y,
              chainLength: tg.chainLength,
            };
          });
        const posedBones = applyIk(animatedBones, ikTargets);
        const poseWorld = computeWorldTransforms({ bones: posedBones });
        // Weights bound once per (mesh × rest skeleton) and cached — not
        // recomputed per frame. Skinning positions come from the (possibly
        // puppet-deformed) vertex buffer; weights always from rest positions.
        const binding = getSkeletonBinding(restMesh, skelRig!.bones);
        deformedVertices = skinRigVertices(binding, poseWorld, deformedVertices);
      }

      layer.deformedMesh = {
        vertices: deformedVertices,
        triangles: restMesh.triangles,
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
            return affineAt(
              world.x + ((anim.sample(node.id, 'x', ti) ?? localX) - localX),
              world.y + ((anim.sample(node.id, 'y', ti) ?? localY) - localY),
              anim.sample(node.id, 'z', ti) ?? z3,
              anim.sample(node.id, 'rotationX', ti) ?? rotX,
              anim.sample(node.id, 'rotationY', ti) ?? rotY,
              world.rotation + ((anim.sample(node.id, 'rotation', ti) ?? localRot) - localRot),
              sc ?? anim.sample(node.id, 'scaleX', ti) ?? scaleX,
              sc ?? anim.sample(node.id, 'scaleY', ti) ?? scaleY,
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
      const dofFx = dofEffectOf(depth);
      if (dofFx) gpuFx.push(dofFx);
      if (!isSolid && readNodeMaterial(node).castsShadows) {
        const castFx = shadowEffectOf(px, py);
        if (castFx) gpuFx.push(castFx);
      }
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
            ? {
                matrix: affineAt(
                  world.x + ((anim.sample(node.id, 'x', ti) ?? eLocalX) - eLocalX),
                  world.y + ((anim.sample(node.id, 'y', ti) ?? eLocalY) - eLocalY),
                  anim.sample(node.id, 'z', ti) ?? z3,
                  anim.sample(node.id, 'rotationX', ti) ?? rotX,
                  anim.sample(node.id, 'rotationY', ti) ?? rotY,
                  world.rotation + ((anim.sample(node.id, 'rotation', ti) ?? eLocalRot) - eLocalRot),
                  scaleX, scaleY,
                ).matrix,
              }
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
      emitLayer(layer, node);
    }
  }

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
  };
}

/** True when a node animates a transform property (so motion blur has motion). */
function moves(anim: AnimationEngine, nodeId: string): boolean {
  return (['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY'] as const).some((p) =>
    anim.isAnimated(nodeId, p),
  );
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
