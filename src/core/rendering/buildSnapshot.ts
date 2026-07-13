/**
 * SnapshotBuilder — projects (SceneGraph + animated values @ time) into an
 * immutable RenderSnapshot (TAD §6.4.3). Pure: reads only, mutates nothing.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { flattenScene, readNodeKind, KIND_FILL } from '@core/scene/sceneDerive';
import { readNodeEffects, effectsToFilter, resolveEffectAmounts, effectPropPath } from '@core/effects/effects';
import { readNodeLayerStyles, layerStylesToFilter } from '@core/effects/layerStyles';
import { readNodeBlend } from '@core/effects/blendMode';
import { readNodeMaskAt } from '@core/effects/mask';
import { readNodeMatte } from '@core/effects/matte';
import { readNodeAdjustment } from '@core/effects/adjustment';
import { readNodeMotionBlur, motionBlurSampleTimes, type MotionBlurConfig } from '@core/effects/motionBlur';
import { readNodeFill } from '@core/paint/fill';
import { readNodeStroke } from '@core/paint/stroke';
import { worldTransformOf, type LocalOf, type ParentOf } from '@core/scene/worldTransform';
import { readNodeLayerTime, remapTime } from '@core/scene/layerTime';
import { readNode3D } from '@core/scene/threeD';
import { readNodeAutoOrient } from '@core/scene/autoOrient';
import { autoOrientAngleDeg } from '@core/motion/motionPath';
import { resolveRepeater, repeaterCopies } from '@core/scene/repeater';
import { resolveTrim, trimSegments } from '@core/scene/trimPath';
import { nearestPrecompRoot } from '@core/scene/precomp';
import { readNodeAnchor } from '@core/scene/anchor';
import { readNodeLight } from '@core/scene/light';
import { resolvePathOp, applyPathOp, shapeOutline } from '@core/scene/pathOps';
import { corner } from '../../../packages/workspace/src/math/BezierPoint';
import { resolveAnimators, evaluateTextAnimators } from '@core/text/textAnimators';
import { readSceneCamera } from '@core/scene/camera3d';
import type { PropPath } from '@motion/animation';
import { Project3D, Matrix4Math, type Matrix2D } from '@motion/scene';

const DEG = Math.PI / 180;
import type { MotionSample } from './RenderBackend';
import type { AnimationEngine } from '@motion/animation';
import type { RenderSnapshot, RenderLayer, LayerKind } from './RenderBackend';

const COMP_WIDTH = 1920;
const COMP_HEIGHT = 1080;
const COMP_BG = '#101014';

/** Comp-level render inputs. When omitted, the hardcoded defaults are used so
 *  headless callers (export presets, tests) keep working unchanged. */
export interface SnapshotComp {
  width: number;
  height: number;
  background: string;
  transparent?: boolean;
  camera3dMode?: 'active' | 'front';
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
  fill?: string; text?: string; fontSize: number;
  fontFamily?: string; fontWeight?: string; fontStyle?: string;
  letterSpacing?: number; lineHeight?: number; align?: string;
  src?: string; assetId?: string;
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
  let src: string | undefined;
  let assetId: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
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
    if (typeof p.src === 'string') src = p.src;
    if (typeof p.assetId === 'string') assetId = p.assetId;
    width = num(p.width) ?? width;
    height = num(p.height) ?? height;
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
    fill,
    text,
    fontSize,
    fontFamily,
    fontWeight,
    fontStyle,
    letterSpacing,
    lineHeight,
    align,
    src,
    assetId,
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
  anim: AnimationEngine,
  t: number,
  focus?: SnapshotFocus,
  overlays?: import('./RenderBackend').RenderOverlays,
  view?: import('./RenderBackend').RenderView,
  motionBlur?: MotionBlurConfig,
  comp: SnapshotComp = DEFAULT_COMP,
): RenderSnapshot {
  const layers: RenderLayer[] = [];

  // Solo (AE-style): when any node is soloed, only soloed nodes render.
  const nodes = flattenScene(graph);
  const anySolo = nodes.some((n) => n.solo === true);

  // Parenting: each layer's on-screen transform is its local transform composed
  // with its parent chain's world transform (E3). Groups/nulls don't draw but
  // still participate as parents. Composition uses each node's ANIMATED local
  // values so parented children follow their parent live.
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
  const worldCache = new Map<string, Matrix2D>();

  // Per-layer time (E6): each layer maps comp time → its own source time
  // (stretch / reverse / freeze), so its animation is sampled at that time.
  // Default (100% / no reverse / no freeze) is identity → no behaviour change.
  const remapOf = (id: string): (tt: number) => number => {
    const n = nodeById.get(id);
    // Per-layer time (E6): stretch / reverse / freeze on the node itself.
    const cfg = n ? readNodeLayerTime(n) : undefined;
    const own: (tt: number) => number = cfg
      ? (tt) => remapTime(tt, cfg, anim.timeSpan(id) ?? { start: 0, end: 1 })
      : (tt) => tt;
    // Precomp time remap (Prompt 10): a layer inside a precomp whose group has a
    // keyframed `precompTime` is sampled at that remapped internal time. The
    // group's own animation stays on comp time — only its nested content remaps.
    if (n) {
      const pc = nearestPrecompRoot(n, nodeById);
      if (pc && anim.isAnimated(pc.id, 'precompTime')) {
        return (tt) => own(anim.sample(pc.id, 'precompTime', tt) ?? tt);
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
    const filter = [
      effectsToFilter(resolveEffectAmounts(readNodeEffects(groupNode), (id) => {
        const v = gv?.get(effectPropPath(id));
        return typeof v === 'number' ? v : undefined;
      })),
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
      precompLayers: inner,
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
  // output is byte-for-byte unchanged.
  const cameraMode = comp.camera3dMode ?? 'active';
  const camera = cameraMode === 'front'
    ? Project3D.defaultCamera(comp.width, comp.height)
    : readSceneCamera(graph, comp.width, comp.height);

  for (const node of nodes) {
    const kind = readNodeKind(node);
    // Groups / nulls / cameras / audio are structural — they never draw.
    if (kind === 'group' || kind === 'null' || kind === 'camera' || kind === 'audio') continue;

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
        light: { color: lt.color, intensity: av?.get('intensity') ?? lt.intensity, radius: av?.get('radius') ?? lt.radius },
      }, node);
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
    const resolvedEffects = resolveEffectAmounts(readNodeEffects(node), (id) => {
      const v = a?.get(effectPropPath(id));
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
    const pathPoints = geomComponent?.props.points as import('../../../packages/workspace/src/math/BezierPoint').BezierPoint[] | undefined;
    
    const layerW = isSolid ? comp.width : (base.width ?? size.w);
    const layerH = isSolid ? comp.height : (base.height ?? size.h);

    // Project 3D layers through the camera into a full 2×3 affine, so X/Y
    // rotation produces real perspective tilt/shear (not just a squish). The
    // affine is derived from three projected points — the layer's local origin
    // and unit axes — through the layer's 3D world matrix. Z-rotation, xy-scale,
    // z-depth (scale + parallax) and tilt all fall out of it. `x/y/scaleX/scaleY/
    // rotation` are kept as the decomposed fallback (hit-testing, motion blur).
    const d3 = readNode3D(node);
    const z3 = a?.get('z') ?? d3.z;
    const rotX = a?.get('rotationX') ?? d3.rotationX;
    const rotY = a?.get('rotationY') ?? d3.rotationY;
    const is3D = !isSolid && (z3 !== 0 || rotX !== 0 || rotY !== 0);
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
    let matrix: readonly [number, number, number, number, number, number] | undefined;
    // Painter depth (distance from camera); far layers draw first.
    let depth = Project3D.projectPoint({ x: world.x, y: world.y, z: z3 }, camera).depth;
    if (is3D) {
      const M = Matrix4Math.compose({
        position: { x: world.x, y: world.y, z: z3 },
        rotation: { x: rotX * DEG, y: rotY * DEG, z: world.rotation * DEG },
        scale: { x: scaleX, y: scaleY, z: 1 },
        anchor: { x: 0, y: 0, z: 0 },
      });
      const O = Project3D.projectPoint(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }), camera);
      const X = Project3D.projectPoint(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }), camera);
      const Y = Project3D.projectPoint(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }), camera);
      const ax = X.x - O.x, ay = X.y - O.y, cx = Y.x - O.x, cy = Y.y - O.y;
      matrix = [ax, ay, cx, cy, O.x, O.y];
      px = O.x;
      py = O.y;
      sx = Math.hypot(ax, ay);
      sy = Math.hypot(cx, cy);
      rot = Math.atan2(ay, ax) / DEG;
      depth = O.depth;
    }

    const layer: RenderLayer = {
      id: node.id,
      kind: layerKind,
      blend: readNodeBlend(node),
      mask: readNodeMaskAt(node, remapOf(node.id)(t)),
      matte: readNodeMatte(node),
      isAdjustment: readNodeAdjustment(node) || undefined,
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
      fill: base.fill ?? KIND_FILL[kind],
      fillPaint: readNodeFill(node),
      stroke: readNodeStroke(node),
      visible: node.visible !== false && (!anySolo || node.solo === true),
      primitive: pathPoints ? 'path' : (isSolid ? 'rect' : (/circle|ellip|dot|orb/.test(name) ? 'ellipse' : 'rect')),
      pathPoints,
      text: base.text,
      fontSize: base.fontSize,
      fontFamily: base.fontFamily,
      fontWeight: base.fontWeight,
      fontStyle: base.fontStyle,
      letterSpacing: base.letterSpacing,
      lineHeight: base.lineHeight,
      align: base.align,
      filter,
      effects: resolvedEffects.length ? resolvedEffects : undefined,
      src: base.src,
      assetId: base.assetId,
    };

    // Anchor point (E4): shift the pivot. Keyframeable via anchorX/anchorY.
    const anchor = readNodeAnchor(node);
    const ax = a?.get('anchorX') ?? anchor.x;
    const ay = a?.get('anchorY') ?? anchor.y;
    if (ax !== 0 || ay !== 0) { layer.anchorX = ax; layer.anchorY = ay; }

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
      const samples = sampleMotion(anim, node.id, base, ghost, t, motionBlur, remapOf(node.id));
      if (samples.length > 1) layer.motionSamples = samples;
    }

    // Text animators (MG Phase D): resolve per-glyph offsets when the text layer
    // carries animator groups. Their numeric params come from `a` (the node's
    // sampled values), so keyframed selectors/offsets animate for free.
    if (layerKind === 'text' && base.text) {
      const anims = resolveAnimators(node, a);
      if (anims.length > 0) layer.glyphs = evaluateTextAnimators(base.text, anims);
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

  // 3D depth sort (painter's order: farthest first). Only when the scene has 3D
  // layers and no order-dependent compositing (mattes / adjustment layers rely
  // on list order). 2D layers share one plane depth, so a stable sort leaves a
  // pure-2D scene in its original order.
  const anyThreeD = layers.some((l) => l.matrix);
  const orderDependent = layers.some((l) => l.matte || l.isMatteSource || l.isAdjustment);
  if (anyThreeD && !orderDependent) {
    layers.sort((p, q) => (q.depth ?? 0) - (p.depth ?? 0));
  }

  resolveMatteSources(layers);
  return {
    width: comp.width,
    height: comp.height,
    background: comp.background,
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
): MotionSample[] {
  const times = motionBlurSampleTimes(t, cfg.fps, cfg.shutterAngle, cfg.samples);
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
    };
  });
}

/**
 * Mark each matted layer's source: the layer directly above it in the list
 * (its predecessor) becomes the matte source and is drawn only as the matte,
 * never on its own. Mutates the layers in place.
 */
export function resolveMatteSources(layers: RenderLayer[]): void {
  for (let i = 1; i < layers.length; i++) {
    if (layers[i]!.matte) layers[i - 1]!.isMatteSource = true;
  }
}

export { COMP_WIDTH, COMP_HEIGHT };
