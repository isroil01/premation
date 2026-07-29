/**
 * Lottie → scene import.
 *
 * Split in two:
 *   • planLottieImport(json) — PURE. Lottie JSON → a typed ImportPlan
 *     (nodes, transform tracks, animated outlines, paints, parent links,
 *     visibility windows, warnings). No scene/DOM deps, fully unit-tested.
 *   • applyImportPlan(plan, ctx) — the thin I/O layer that realises a plan
 *     against the live scene via the AI ToolContext facade + insertPathNode +
 *     defaultAnimation.
 *
 * A baked After Effects / Rive character rig arrives as `ty:'sh'` layers whose
 * paths animate per frame (IK + mesh already flattened to vertices at export),
 * so this needs no solver — `lottiePathKeyframes` turns those into `points`
 * data-track keyframes and the renderer's animated-outline hook plays them back.
 *
 * Unit conventions invert exportManager.ts exactly: scale ÷100 (engine 1.0 =
 * Lottie 100), opacity as-authored, position split into scalar x/y tracks,
 * bezier tangents relative→absolute (handled in lottiePath.ts).
 *
 * ## Shape trees are expanded, not collapsed
 *
 * One Lottie `ty:4` layer can hold MANY drawable items, nested in `gr` groups
 * that each carry their own `tr` transform and paint. This used to keep the
 * FIRST path per layer and drop the rest: a real 65-path export came in as 18
 * paths, and the lettering of a word became one stray glyph. Now every
 * `sh`/`rc`/`el` becomes its own node, each `gr` with a non-identity `tr`
 * becomes a container node, and paint (including gradients and strokes)
 * resolves per group with inheritance — so the layer tree mirrors the source
 * and the artwork survives.
 *
 * A layer whose whole shape tree is ONE drawable under identity transforms
 * still collapses onto a single node: no pointless wrapper for the common case.
 */

import {
  lottiePathKeyframes,
  type DataKeyframe,
  type DataPoint,
  type LottieShapeProp,
} from '@motion/animation';

// ── Minimal Lottie shapes (only what we read) ──────────────────────

interface LottieKf {
  t: number;
  s?: number[];
  i?: { x: number[]; y: number[] };
  o?: { x: number[]; y: number[] };
  h?: number;
}
/** A transform/property channel: static (`a:0`) or animated (`a:1`). */
interface LottieProp {
  a?: 0 | 1;
  k?: number | number[] | LottieKf[];
  /** Split-position form. */
  s?: boolean;
  x?: LottieProp;
  y?: LottieProp;
}
/** A gradient's stop ramp: `p` stops packed into a flat `k` array. */
interface LottieGradient {
  p?: number;
  k?: LottieProp;
}
interface LottieShapeItem {
  ty: string;
  it?: LottieShapeItem[];
  ks?: LottieShapeProp;
  c?: LottieProp; // fill / stroke colour
  o?: LottieProp; // paint or group-transform opacity
  s?: LottieProp; // size (rc/el), or gradient start point
  e?: LottieProp; // gradient end point
  g?: LottieGradient; // gradient stops
  t?: number; // gradient type: 1 = linear, 2 = radial
  w?: LottieProp; // stroke width
  r?: LottieProp; // corner radius (rc) / rotation (tr)
  p?: LottieProp; // position (tr) / centre (rc, el)
  a?: LottieProp; // anchor (tr)
  sk?: LottieProp; // skew (tr) — warned, not applied
  nm?: string;
}
interface LottieLayer {
  ty: number;
  ind?: number;
  parent?: number;
  nm?: string;
  /** Precomp layers (`ty:0`) reference an entry in `assets[]` by id. */
  refId?: string;
  /** Visibility window, in the CONTAINING composition's frames. */
  ip?: number;
  op?: number;
  /** Start time: the layer's own frame 0 sits at this parent frame. */
  st?: number;
  /** Time stretch (1 = none) — warned, not applied. */
  sr?: number;
  ks?: { o?: LottieProp; r?: LottieProp; p?: LottieProp; s?: LottieProp; a?: LottieProp };
  shapes?: LottieShapeItem[];
  hasMask?: boolean;
  masksProperties?: unknown[];
  bm?: number;
  ef?: unknown[];
}
/** An `assets[]` entry. Precomps carry `layers`; image assets carry `p`/`u`. */
interface LottieAsset {
  id?: string;
  layers?: LottieLayer[];
  w?: number;
  h?: number;
}
export interface LottieJson {
  v?: string;
  fr?: number;
  ip?: number;
  op?: number;
  w?: number;
  h?: number;
  layers?: LottieLayer[];
  assets?: LottieAsset[];
}

// ── Plan types ─────────────────────────────────────────────────────

export interface PlannedScalarKf {
  t: number; // composition seconds
  value: number;
  easing: string;
  bezier?: [number, number, number, number];
}
export interface PlannedScalarTrack {
  prop: string;
  keyframes: PlannedScalarKf[];
}

/** A colour stop on a planned gradient. */
export interface PlannedStop {
  offset: number;
  color: string;
}
/**
 * A resolved paint. Lottie gradients used to be dropped with a warning, which
 * left the layer on the scene facade's PLACEHOLDER blue — worse than flat,
 * because the colour was invented. They now map to the engine's real
 * linear/radial fills (colour ramp + independent opacity ramp, exactly the
 * model `core/paint/fill` already has).
 */
export interface PlannedFill {
  type: 'solid' | 'linear' | 'radial';
  /** Solid colour, and the fallback colour for gradient-unaware consumers. */
  color: string;
  /** Paint opacity, 0..1. */
  opacity: number;
  /** Linear: direction in degrees (0 = →, 90 = ↓). */
  angle?: number;
  /** Radial: centre + radius in the relative [0..1] box. */
  cx?: number;
  cy?: number;
  radius?: number;
  stops?: PlannedStop[];
  opacityStops?: Array<{ offset: number; opacity: number }>;
}
export interface PlannedStroke {
  color: string;
  width: number;
  opacity: number;
}

export type PlannedKind = 'shape' | 'text' | 'image' | 'null' | 'solid' | 'group';
export interface PlannedLayer {
  /** Original Lottie `ind` within its own (possibly nested) scope — for
   *  debugging and the legacy top-level parent-link tests only. */
  ind: number;
  /** Lottie `parent` within the same scope (debug / legacy). Apply uses
   *  `parentUid`, which is nesting-aware. */
  parentInd?: number;
  /** Globally-unique id assigned by the planner. Precomps expand into many
   *  layers across scopes whose `ind`s collide, so the apply layer parents by
   *  `uid`/`parentUid`, not `ind`. */
  uid: string;
  parentUid?: string;
  name: string;
  kind: PlannedKind;
  x: number;
  y: number;
  staticProps: Record<string, number | string>;
  scalarTracks: PlannedScalarTrack[];
  pointsTrack?: { keyframes: DataKeyframe[]; closed: boolean };
  /** Resolved fill paint (solid or gradient). */
  fill?: PlannedFill;
  /** Resolved stroke. */
  stroke?: PlannedStroke;
  /**
   * Visibility window in COMPOSITION SECONDS, from the layer's `ip`/`op`
   * (offset by any enclosing precomp `st`, and clipped to the precomp's own
   * window). Absent when the layer is visible for the whole comp. The apply
   * layer turns this into the node's timeline clip bar.
   */
  timing?: { inSec: number; outSec: number };
}
export interface ImportPlan {
  comp: { width: number; height: number; fps: number; durationSeconds: number };
  layers: PlannedLayer[];
  warnings: string[];
}

// ── Channel helpers ────────────────────────────────────────────────

/** Invert lottieEase: a Lottie keyframe's out/in tangents → engine easing. */
function easingOf(kf: LottieKf): { easing: string; bezier?: [number, number, number, number] } {
  if (kf.h === 1) return { easing: 'hold' };
  const ox = kf.o?.x?.[0];
  const oy = kf.o?.y?.[0];
  const ix = kf.i?.x?.[0];
  const iy = kf.i?.y?.[0];
  if (ox === undefined || oy === undefined || ix === undefined || iy === undefined) return { easing: 'linear' };
  return { easing: 'bezier', bezier: [ox, oy, ix, iy] };
}

/**
 * Extract one component (`comp` index) of a Lottie property as either a static
 * value or a scalar keyframe list. Handles split-position (`s:true`) by reading
 * the `x`/`y` sub-props. `mul`/`add` apply the unit conversion.
 */
function channel(
  lp: LottieProp | undefined,
  comp: number,
  fr: number,
  mul = 1,
  add = 0,
): { static?: number; kfs?: PlannedScalarKf[] } {
  if (!lp) return {};
  // Split position: caller reads x (comp 0) and y (comp 1) from sub-props.
  if (lp.s === true && (lp.x || lp.y)) {
    return channel(comp === 0 ? lp.x : lp.y, 0, fr, mul, add);
  }
  if (lp.a === 1 && Array.isArray(lp.k)) {
    const kfs: PlannedScalarKf[] = [];
    let prev = 0;
    for (const raw of lp.k as LottieKf[]) {
      const arr = raw.s;
      const v = Array.isArray(arr) ? arr[comp] ?? prev : prev;
      prev = v;
      kfs.push({ t: raw.t / fr, value: v * mul + add, ...easingOf(raw) });
    }
    kfs.sort((a, b) => a.t - b.t);
    return { kfs };
  }
  const k = lp.k;
  const v = Array.isArray(k) ? (k as number[])[comp] ?? 0 : typeof k === 'number' ? k : 0;
  return { static: v * mul + add };
}

/** Push a channel onto the layer as a static prop or an animated track. */
function emit(
  layer: PlannedLayer,
  prop: string,
  lp: LottieProp | undefined,
  comp: number,
  fr: number,
  mul = 1,
  add = 0,
): void {
  const c = channel(lp, comp, fr, mul, add);
  if (c.kfs && c.kfs.length >= 2) layer.scalarTracks.push({ prop, keyframes: c.kfs });
  else if (c.kfs && c.kfs.length === 1) layer.staticProps[prop] = c.kfs[0]!.value;
  else if (c.static !== undefined) layer.staticProps[prop] = c.static;
}

/** Static value of a channel component (first keyframe when animated). */
function staticOf(lp: LottieProp | undefined, comp: number, fr: number, dflt = 0): number {
  const c = channel(lp, comp, fr);
  if (c.static !== undefined) return c.static;
  return c.kfs?.[0]?.value ?? dflt;
}

// ── Paint ──────────────────────────────────────────────────────────

const hex2 = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');

function hexFromLottieColor(lp: LottieProp | undefined): string | undefined {
  const k = lp?.k;
  // An ANIMATED colour has keyframes rather than a raw triple; take the first
  // (the engine has no colour tracks for fills yet — see fill.ts).
  const arr = Array.isArray(k) && typeof k[0] === 'number'
    ? (k as number[])
    : Array.isArray(k) && k.length > 0 && typeof (k[0] as LottieKf)?.t === 'number'
      ? (k[0] as LottieKf).s
      : undefined;
  if (!arr || arr.length < 3) return undefined;
  return `#${hex2(arr[0]!)}${hex2(arr[1]!)}${hex2(arr[2]!)}`;
}

/** The flat ramp array of a gradient (`g.k.k`), or null when absent/animated. */
function gradientRamp(g: LottieGradient | undefined): number[] | null {
  const k = g?.k?.k;
  if (Array.isArray(k) && typeof k[0] === 'number') return k as number[];
  if (Array.isArray(k) && k.length > 0 && Array.isArray((k[0] as LottieKf).s)) return (k[0] as LottieKf).s!;
  return null;
}

/**
 * Lottie gradient → the engine's paint model.
 *
 * The ramp packs `p` colour stops as [offset, r, g, b] quads, then any opacity
 * stops as [offset, alpha] pairs — two independent lists, which is exactly the
 * split `core/paint/fill` already models (colour stops + opacityStops).
 *
 * `box` is the drawable's local bounding box; the radial centre/radius are
 * normalised against it because the engine stores them relative to the layer.
 */
function planGradient(
  it: LottieShapeItem,
  fr: number,
  box: { x0: number; y0: number; x1: number; y1: number } | null,
): PlannedFill | undefined {
  const ramp = gradientRamp(it.g);
  const count = it.g?.p ?? 0;
  if (!ramp || count <= 0) return undefined;

  const stops: PlannedStop[] = [];
  for (let i = 0; i < count; i++) {
    const o = ramp[i * 4];
    if (o === undefined) break;
    stops.push({ offset: o, color: `#${hex2(ramp[i * 4 + 1] ?? 0)}${hex2(ramp[i * 4 + 2] ?? 0)}${hex2(ramp[i * 4 + 3] ?? 0)}` });
  }
  if (stops.length === 0) return undefined;

  const opacityStops: Array<{ offset: number; opacity: number }> = [];
  for (let i = count * 4; i + 1 < ramp.length; i += 2) {
    opacityStops.push({ offset: ramp[i]!, opacity: ramp[i + 1]! });
  }

  const sx = staticOf(it.s, 0, fr);
  const sy = staticOf(it.s, 1, fr);
  const ex = staticOf(it.e, 0, fr);
  const ey = staticOf(it.e, 1, fr);
  const opacity = Math.max(0, Math.min(1, staticOf(it.o, 0, fr, 100) / 100));
  const base: PlannedFill = {
    type: it.t === 2 ? 'radial' : 'linear',
    color: stops[0]!.color,
    opacity,
    stops,
    ...(opacityStops.length > 0 ? { opacityStops } : {}),
  };

  if (base.type === 'linear') {
    // y grows downward in both Lottie and the engine, so atan2 maps directly
    // onto the engine's convention (0 = →, 90 = ↓).
    base.angle = (Math.atan2(ey - sy, ex - sx) * 180) / Math.PI;
    return base;
  }

  const w = box ? Math.max(1e-6, box.x1 - box.x0) : 1;
  const h = box ? Math.max(1e-6, box.y1 - box.y0) : 1;
  base.cx = box ? (sx - box.x0) / w : 0.5;
  base.cy = box ? (sy - box.y0) / h : 0.5;
  // Engine radius is a fraction of the box's half-diagonal.
  const half = Math.hypot(w, h) / 2;
  base.radius = half > 0 ? Math.hypot(ex - sx, ey - sy) / half : 1;
  return base;
}

// ── Shape trees ────────────────────────────────────────────────────

/** Paint in force for a group's drawables (inherited by nested groups). */
interface PaintScope {
  fill?: PlannedFill;
  stroke?: PlannedStroke;
}

/** Local bbox of a drawable, for normalising radial-gradient geometry. */
function drawableBox(
  pts: DataPoint[] | undefined,
  size: { w: number; h: number } | null,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (pts && pts.length > 0) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x0, y0, x1, y1 };
  }
  if (size) return { x0: -size.w / 2, y0: -size.h / 2, x1: size.w / 2, y1: size.h / 2 };
  return null;
}

const isIdentityTr = (tr: LottieShapeItem | undefined, fr: number): boolean => {
  if (!tr) return true;
  return (
    staticOf(tr.p, 0, fr) === 0 && staticOf(tr.p, 1, fr) === 0 &&
    staticOf(tr.a, 0, fr) === 0 && staticOf(tr.a, 1, fr) === 0 &&
    staticOf(tr.s, 0, fr, 100) === 100 && staticOf(tr.s, 1, fr, 100) === 100 &&
    staticOf(tr.r, 0, fr) === 0 &&
    staticOf(tr.o, 0, fr, 100) === 100 &&
    // An ANIMATED transform is never identity, however its first frame reads.
    ![tr.p, tr.a, tr.s, tr.r, tr.o].some((c) => c?.a === 1)
  );
};

interface ShapeCtx {
  fr: number;
  out: PlannedLayer[];
  warnings: string[];
  nextUid: () => string;
  hostName: string;
  /** Every drawable/wrapper this walk produced, so the caller can collapse a
   *  single-drawable layer back onto the host node. */
  produced: PlannedLayer[];
}

function newPlanned(uid: string, name: string, kind: PlannedKind, parentUid: string | undefined): PlannedLayer {
  return { ind: 0, uid, name, kind, parentUid, x: 0, y: 0, staticProps: {}, scalarTracks: [] };
}

/**
 * Expand one level of a Lottie shape list into planned nodes.
 *
 * `gr` groups with a real `tr` become container nodes (their children offset by
 * minus the group anchor — the engine composes parent transforms with anchor 0,
 * so an anchor has to be baked into children exactly like the precomp path).
 * Every `sh`/`rc`/`el` becomes a drawable node carrying the group's paint.
 */
function planShapeItems(
  items: readonly LottieShapeItem[],
  ctx: ShapeCtx,
  parentUid: string | undefined,
  inherited: PaintScope,
): void {
  const fr = ctx.fr;

  // A group's paint operators are listed alongside (usually after) its paths
  // and apply to all of them, so resolve this level's paint up front.
  const scope: PaintScope = { ...inherited };
  for (const it of items) {
    switch (it.ty) {
      case 'fl': {
        const hex = hexFromLottieColor(it.c);
        if (hex) scope.fill = { type: 'solid', color: hex, opacity: Math.max(0, Math.min(1, staticOf(it.o, 0, fr, 100) / 100)) };
        break;
      }
      case 'gf': {
        const g = planGradient(it, fr, null);
        if (g) scope.fill = g;
        else ctx.warnings.push(`Layer "${ctx.hostName}": a gradient fill had no readable stops — left unpainted.`);
        break;
      }
      case 'st': {
        const hex = hexFromLottieColor(it.c);
        if (hex) {
          scope.stroke = {
            color: hex,
            width: staticOf(it.w, 0, fr, 1),
            opacity: Math.max(0, Math.min(1, staticOf(it.o, 0, fr, 100) / 100)),
          };
        }
        break;
      }
      case 'gs': {
        const g = planGradient(it, fr, null);
        if (g) {
          scope.stroke = { color: g.color, width: staticOf(it.w, 0, fr, 1), opacity: g.opacity };
          ctx.warnings.push(`Layer "${ctx.hostName}": gradient STROKE flattened to its first stop (gradient strokes are not supported).`);
        }
        break;
      }
      case 'tm':
        ctx.warnings.push(`Layer "${ctx.hostName}": trim-path animation not imported (the full path is drawn).`);
        break;
      case 'rp':
        ctx.warnings.push(`Layer "${ctx.hostName}": repeater not imported (one copy is drawn).`);
        break;
      case 'mm':
        ctx.warnings.push(`Layer "${ctx.hostName}": merge-paths not imported (shapes are drawn separately).`);
        break;
      default:
        break;
    }
  }

  let drawableIndex = 0;
  for (const it of items) {
    if (it.ty === 'gr') {
      if (!it.it) continue;
      const tr = it.it.find((x) => x.ty === 'tr');
      let childParent = parentUid;
      if (!isIdentityTr(tr, fr)) {
        const wrap = newPlanned(ctx.nextUid(), it.nm ?? `${ctx.hostName} Group`, 'group', parentUid);
        // Position/scale/rotation/opacity of the group transform.
        const px = channel(tr!.p, 0, fr);
        const py = channel(tr!.p, 1, fr);
        if (px.static !== undefined) wrap.x = px.static;
        if (py.static !== undefined) wrap.y = py.static;
        if (px.kfs && px.kfs.length >= 2) wrap.scalarTracks.push({ prop: 'x', keyframes: px.kfs });
        else if (px.kfs?.[0]) wrap.x = px.kfs[0].value;
        if (py.kfs && py.kfs.length >= 2) wrap.scalarTracks.push({ prop: 'y', keyframes: py.kfs });
        else if (py.kfs?.[0]) wrap.y = py.kfs[0].value;
        emit(wrap, 'opacity', tr!.o, 0, fr);
        emit(wrap, 'rotation', tr!.r, 0, fr);
        emit(wrap, 'scaleX', tr!.s, 0, fr, 1 / 100);
        emit(wrap, 'scaleY', tr!.s, 1, fr, 1 / 100);
        if (tr!.sk && staticOf(tr!.sk, 0, fr) !== 0) {
          ctx.warnings.push(`Layer "${ctx.hostName}": a group skew was dropped (skew is not supported on groups).`);
        }
        ctx.out.push(wrap);
        ctx.produced.push(wrap);
        childParent = wrap.uid;

        // The engine composes a parent's transform with anchor 0, so the
        // group's anchor has to move its CHILDREN instead (same keystone as
        // the precomp expansion).
        const ax = staticOf(tr!.a, 0, fr);
        const ay = staticOf(tr!.a, 1, fr);
        planShapeItems(it.it, { ...ctx }, childParent, scope);
        if (ax !== 0 || ay !== 0) {
          for (const child of ctx.out) {
            if (child.parentUid === childParent) {
              child.x -= ax;
              child.y -= ay;
              for (const t of child.scalarTracks) {
                if (t.prop === 'x') t.keyframes = t.keyframes.map((k) => ({ ...k, value: k.value - ax }));
                if (t.prop === 'y') t.keyframes = t.keyframes.map((k) => ({ ...k, value: k.value - ay }));
              }
            }
          }
        }
        continue;
      }
      planShapeItems(it.it, ctx, childParent, scope);
      continue;
    }

    if (it.ty !== 'sh' && it.ty !== 'rc' && it.ty !== 'el') continue;

    drawableIndex++;
    const node = newPlanned(
      ctx.nextUid(),
      it.nm ?? (drawableIndex > 1 ? `${ctx.hostName} ${drawableIndex}` : ctx.hostName),
      'shape',
      parentUid,
    );

    let box: ReturnType<typeof drawableBox> = null;
    if (it.ty === 'sh') {
      if (!it.ks) continue;
      const conv = lottiePathKeyframes(it.ks, fr);
      if (conv.keyframes.length === 0) continue;
      node.pointsTrack = { keyframes: conv.keyframes, closed: conv.closed };
      box = drawableBox(conv.keyframes[0]?.value as DataPoint[] | undefined, null);
    } else {
      const w = staticOf(it.s, 0, fr);
      const h = staticOf(it.s, 1, fr);
      node.staticProps.width = w;
      node.staticProps.height = h;
      node.staticProps.shapeType = it.ty === 'el' ? 'ellipse' : 'rect';
      const cr = staticOf(it.r, 0, fr);
      if (cr) node.staticProps.cornerRadius = cr;
      // `p` centres the primitive inside its layer.
      node.x = staticOf(it.p, 0, fr);
      node.y = staticOf(it.p, 1, fr);
      box = drawableBox(undefined, { w, h });
    }

    // Radial gradients need the drawable's box to normalise centre/radius, so
    // re-resolve the group's gradient now that the box is known.
    let fill = scope.fill;
    if (fill && fill.type === 'radial' && box) {
      const src = items.find((x) => x.ty === 'gf');
      if (src) fill = planGradient(src, fr, box) ?? fill;
    }
    if (fill) {
      node.fill = fill;
      node.staticProps.fill = fill.color; // flat fallback for solid readers
    }
    if (scope.stroke) node.stroke = scope.stroke;

    ctx.out.push(node);
    ctx.produced.push(node);
  }
}

// ── The planner ────────────────────────────────────────────────────

const KIND_BY_TY: Record<number, PlannedKind | undefined> = {
  4: 'shape',
  5: 'text',
  2: 'image',
  3: 'null',
  1: 'solid',
};

/** Static value of an anchor component (`ks.a`), taking the first keyframe if
 *  animated. Used to bake a precomp's anchor into its children (see below). */
function anchorComponent(lp: LottieProp | undefined, comp: number, fr: number): number {
  return staticOf(lp, comp, fr);
}

/**
 * Build the transform-only part of a planned layer (position/opacity/rotation/
 * scale/anchor). `off` is baked into the layer's position (x/y and any x/y
 * tracks) — used to offset a precomp's ROOT children by minus the precomp
 * anchor, since the engine ignores anchor in parent→child composition.
 */
function buildTransformLayer(
  ll: LottieLayer,
  ind: number,
  uid: string,
  kind: PlannedKind,
  fr: number,
  off: { x: number; y: number },
): PlannedLayer {
  const layer: PlannedLayer = {
    ind,
    parentInd: ll.parent,
    uid,
    name: ll.nm ?? `Layer ${ind}`,
    kind,
    x: 0,
    y: 0,
    staticProps: {},
    scalarTracks: [],
  };
  const ks = ll.ks ?? {};

  // Position → static x/y or split scalar tracks (offset baked in).
  const px = channel(ks.p, 0, fr);
  const py = channel(ks.p, 1, fr);
  if (px.static !== undefined) layer.x = px.static + off.x;
  if (py.static !== undefined) layer.y = py.static + off.y;
  if (px.kfs && px.kfs.length >= 2)
    layer.scalarTracks.push({ prop: 'x', keyframes: px.kfs.map((k) => ({ ...k, value: k.value + off.x })) });
  else if (px.kfs?.[0]) layer.x = px.kfs[0].value + off.x;
  if (py.kfs && py.kfs.length >= 2)
    layer.scalarTracks.push({ prop: 'y', keyframes: py.kfs.map((k) => ({ ...k, value: k.value + off.y })) });
  else if (py.kfs?.[0]) layer.y = py.kfs[0].value + off.y;

  emit(layer, 'opacity', ks.o, 0, fr); // Lottie 0..100 == engine opacity
  emit(layer, 'rotation', ks.r, 0, fr);
  emit(layer, 'scaleX', ks.s, 0, fr, 1 / 100); // Lottie 100 == engine 1.0
  emit(layer, 'scaleY', ks.s, 1, fr, 1 / 100);
  // A precomp group bakes its anchor into its children instead (the engine
  // ignores anchor when composing a parent's transform onto its children), so
  // it must NOT also carry the anchor itself.
  if (kind !== 'group') {
    emit(layer, 'anchorX', ks.a, 0, fr);
    emit(layer, 'anchorY', ks.a, 1, fr);
  }
  return layer;
}

/** Depth guard for pathological / self-referential precomp graphs. */
const MAX_PRECOMP_DEPTH = 12;

/** A scope's time mapping: child frame `f` sits at parent frame `f + shift`,
 *  and nothing in the scope is visible outside [lo, hi] parent frames. */
interface TimeScope {
  shift: number;
  lo: number;
  hi: number;
}

/**
 * The layer's visibility window in COMPOSITION SECONDS, or undefined when it
 * covers the whole comp.
 *
 * Lottie layers carry `ip`/`op` — the frames between which they exist — and a
 * precomp's children are expressed in the precomp's own clock, offset by its
 * `st`. Ignoring all of this made every imported layer visible from frame 0:
 * a "Book a call" export whose two title layers only appear at frame 133 drew
 * them immediately, over the top of the intro.
 */
function timingOf(ll: LottieLayer, fr: number, scope: TimeScope, compFrames: number): { inSec: number; outSec: number } | undefined {
  const rawIn = typeof ll.ip === 'number' ? ll.ip : -Infinity;
  const rawOut = typeof ll.op === 'number' ? ll.op : Infinity;
  const lo = Math.max(scope.lo, rawIn + scope.shift);
  const hi = Math.min(scope.hi, rawOut + scope.shift);
  const clampedLo = Math.max(0, lo);
  const clampedHi = Math.min(compFrames, hi);
  // Covers everything → no clip trim needed.
  if (clampedLo <= 0 && clampedHi >= compFrames) return undefined;
  if (clampedHi <= clampedLo) return { inSec: 0, outSec: 0 }; // never visible
  return { inSec: clampedLo / fr, outSec: clampedHi / fr };
}

/** Linear sample of a planned scalar track at `t` (clamped at both ends). */
function sampleTrack(kfs: readonly PlannedScalarKf[], t: number): number {
  if (kfs.length === 0) return 0;
  if (t <= kfs[0]!.t) return kfs[0]!.value;
  const last = kfs[kfs.length - 1]!;
  if (t >= last.t) return last.value;
  for (let i = 1; i < kfs.length; i++) {
    const a = kfs[i - 1]!;
    const b = kfs[i]!;
    if (t <= b.t) {
      if (a.easing === 'hold' || b.t === a.t) return a.value;
      return a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t);
    }
  }
  return last.value;
}

/**
 * Express a visibility window as a HOLD-keyframed opacity gate.
 *
 * Only a composition's immediate children get timeline clip bars, so a nested
 * layer's `ip`/`op` cannot be trimmed — and in a real file that is most of them
 * (6 of 7 in the "Book a call" export, including the whole "Call" subtree, which
 * therefore appeared 2.2s early). Hold keyframes are the engine-native way to
 * say "not yet": 0 until the in-point, the layer's own opacity through the
 * window, 0 after. The one-frame hold before the out-point makes it a hard cut
 * rather than a fade the file never asked for.
 */
function gateOpacity(layer: PlannedLayer, window: { inSec: number; outSec: number }, fr: number, compFrames: number): void {
  const existingIdx = layer.scalarTracks.findIndex((t) => t.prop === 'opacity');
  const existing = existingIdx >= 0 ? layer.scalarTracks[existingIdx]!.keyframes : null;
  const baseAt = (t: number): number =>
    existing ? sampleTrack(existing, t) : typeof layer.staticProps.opacity === 'number' ? layer.staticProps.opacity : 100;

  if (window.outSec <= window.inSec) {
    // Never visible in this comp.
    if (existingIdx >= 0) layer.scalarTracks.splice(existingIdx, 1);
    layer.staticProps.opacity = 0;
    return;
  }

  const step = 1 / fr;
  const out: PlannedScalarKf[] = [];
  if (window.inSec > 0) {
    out.push({ t: 0, value: 0, easing: 'hold' });
    out.push({ t: window.inSec, value: baseAt(window.inSec), easing: existing ? 'linear' : 'hold' });
  }
  if (existing) {
    for (const kf of existing) {
      if (kf.t > window.inSec && kf.t < window.outSec - step) out.push(kf);
    }
  }
  const endsEarly = window.outSec < compFrames / fr - 1e-6;
  if (endsEarly) {
    out.push({ t: Math.max(window.inSec, window.outSec - step), value: baseAt(window.outSec - step), easing: 'hold' });
    out.push({ t: window.outSec, value: 0, easing: 'hold' });
  } else if (!existing && window.inSec > 0) {
    // Nothing more to say — the gate above already holds the base value on.
  }
  out.sort((a, b) => a.t - b.t);

  if (out.length >= 2) {
    if (existingIdx >= 0) layer.scalarTracks[existingIdx] = { prop: 'opacity', keyframes: out };
    else layer.scalarTracks.push({ prop: 'opacity', keyframes: out });
    delete layer.staticProps.opacity;
  }
}

/**
 * Attach a visibility window to a layer by whichever mechanism it can actually
 * use: a timeline clip bar for a composition's immediate children (`timing`,
 * realised by the apply layer), an opacity gate for everything nested.
 */
function applyWindow(
  layer: PlannedLayer,
  window: { inSec: number; outSec: number } | undefined,
  fr: number,
  compFrames: number,
): void {
  if (!window) return;
  if (layer.parentUid === undefined) layer.timing = window;
  else gateOpacity(layer, window, fr, compFrames);
}

/**
 * Plan one scope of Lottie layers (the top-level `layers`, or a precomp asset's
 * `layers`) into flat `PlannedLayer`s appended to `out`. Precomp layers (`ty:0`)
 * become a `group` node and recurse into their referenced asset; the asset's
 * root layers are offset by minus the precomp's anchor so the precomp lands
 * where the group sits. Parenting is resolved by globally-unique `uid`, because
 * a precomp's `ind` namespace is independent of its host's.
 */
function planScope(
  layers: readonly LottieLayer[],
  ctx: {
    fr: number;
    compFrames: number;
    assets: Map<string, LottieAsset>;
    out: PlannedLayer[];
    warnings: string[];
    nextUid: () => string;
  },
  parentUidForRoots: string | undefined,
  rootOffset: { x: number; y: number },
  time: TimeScope,
  depth: number,
  seenRefs: ReadonlySet<string>,
): void {
  // Assign uids first so parent links resolve regardless of declaration order.
  const uidByInd = new Map<number, string>();
  const prepared = layers.map((ll, i) => {
    const ind = ll.ind ?? i + 1;
    const uid = ctx.nextUid();
    uidByInd.set(ind, uid);
    return { ll, ind, uid };
  });

  for (const { ll, ind, uid } of prepared) {
    const name = ll.nm ?? `Layer ${ind}`;
    const isRoot = ll.parent === undefined;
    const parentUid = ll.parent !== undefined ? uidByInd.get(ll.parent) ?? parentUidForRoots : parentUidForRoots;
    // Only this scope's ROOTS carry the incoming offset; parented layers move
    // with their parent.
    const off = isRoot ? rootOffset : { x: 0, y: 0 };
    const timing = timingOf(ll, ctx.fr, time, ctx.compFrames);
    if (typeof ll.sr === 'number' && ll.sr !== 1) {
      ctx.warnings.push(`Layer "${name}": time stretch (${ll.sr}×) not applied.`);
    }
    if (ll.hasMask || (Array.isArray(ll.masksProperties) && ll.masksProperties.length > 0)) {
      ctx.warnings.push(`Layer "${name}": layer mask not imported (content is drawn unmasked).`);
    }
    if (typeof ll.bm === 'number' && ll.bm !== 0) {
      ctx.warnings.push(`Layer "${name}": blend mode not imported (drawn normal).`);
    }

    if (ll.ty === 0) {
      const asset = ll.refId ? ctx.assets.get(ll.refId) : undefined;
      if (!asset || !asset.layers || asset.layers.length === 0) {
        ctx.warnings.push(`Layer "${name}": precomp could not be resolved (missing asset) — skipped.`);
        continue;
      }
      if (ll.refId && (seenRefs.has(ll.refId) || depth >= MAX_PRECOMP_DEPTH)) {
        ctx.warnings.push(`Layer "${name}": precomp nests too deeply or references itself — skipped.`);
        continue;
      }
      // The precomp becomes a group carrying the layer's transform.
      const group = buildTransformLayer(ll, ind, uid, 'group', ctx.fr, off);
      group.parentUid = parentUid;
      applyWindow(group, timing, ctx.fr, ctx.compFrames);
      ctx.out.push(group);
      if (Array.isArray(ll.ef) && ll.ef.length > 0)
        ctx.warnings.push(`Layer "${name}": ${ll.ef.length} Lottie effect(s) not mapped.`);

      // Children render in the precomp's own space; the precomp anchor shifts
      // that whole space, so offset the asset's roots by minus the anchor.
      const ax = anchorComponent(ll.ks?.a, 0, ctx.fr);
      const ay = anchorComponent(ll.ks?.a, 1, ctx.fr);
      const nextSeen = ll.refId ? new Set(seenRefs).add(ll.refId) : seenRefs;
      // The precomp's own clock: its frame 0 sits at parent frame `st`, and
      // nothing inside it outlives the precomp layer's own window.
      const shift = time.shift + (typeof ll.st === 'number' ? ll.st : 0);
      const lo = Math.max(time.lo, (typeof ll.ip === 'number' ? ll.ip : -Infinity) + time.shift);
      const hi = Math.min(time.hi, (typeof ll.op === 'number' ? ll.op : Infinity) + time.shift);
      planScope(asset.layers, ctx, uid, { x: -ax, y: -ay }, { shift, lo, hi }, depth + 1, nextSeen);
      continue;
    }

    const kind = KIND_BY_TY[ll.ty];
    if (!kind) {
      ctx.warnings.push(`Layer "${name}": unsupported layer type ${ll.ty} — skipped.`);
      continue;
    }

    const layer = buildTransformLayer(ll, ind, uid, kind, ctx.fr, off);
    layer.parentUid = parentUid;
    applyWindow(layer, timing, ctx.fr, ctx.compFrames);
    ctx.out.push(layer);

    if (ll.shapes) {
      const produced: PlannedLayer[] = [];
      planShapeItems(
        ll.shapes,
        { fr: ctx.fr, out: ctx.out, warnings: ctx.warnings, nextUid: ctx.nextUid, hostName: name, produced },
        uid,
        {},
      );
      // A layer whose whole shape tree is ONE drawable under identity group
      // transforms collapses back onto the host node — no wrapper for the
      // common case, and the shape of the plan older callers expect.
      if (produced.length === 1 && produced[0]!.kind === 'shape' && produced[0]!.parentUid === uid) {
        const only = produced[0]!;
        const idx = ctx.out.indexOf(only);
        if (idx >= 0) ctx.out.splice(idx, 1);
        layer.staticProps = { ...only.staticProps, ...layer.staticProps };
        if (only.pointsTrack) layer.pointsTrack = only.pointsTrack;
        if (only.fill) layer.fill = only.fill;
        if (only.stroke) layer.stroke = only.stroke;
        // An `rc`/`el` centred inside its layer keeps that offset.
        layer.x += only.x;
        layer.y += only.y;
      } else if (produced.length > 0) {
        // The host now only carries the layer transform; groups draw nothing,
        // which is what a container must do (a 'shape' host with no geometry
        // would fall back to the facade's placeholder rectangle).
        layer.kind = 'group';
      }
    }

    if (ll.ty === 5) ctx.warnings.push(`Layer "${name}": text imported as an empty text layer (glyph outlines/fonts are not embedded in Lottie).`);
    if (ll.ty === 2) ctx.warnings.push(`Layer "${name}": image layer needs its asset resolved before it renders.`);
    if (Array.isArray(ll.ef) && ll.ef.length > 0) ctx.warnings.push(`Layer "${name}": ${ll.ef.length} Lottie effect(s) not mapped.`);
  }
}

export function planLottieImport(json: LottieJson): ImportPlan {
  const fr = json.fr && json.fr > 0 ? json.fr : 30;
  const warnings: string[] = [];
  const out: PlannedLayer[] = [];
  const compFrames = json.op ?? fr * 5;

  // Precomp assets are those carrying `layers`; image assets (no layers) are
  // ignored here (image layers warn separately).
  const assets = new Map<string, LottieAsset>();
  for (const a of json.assets ?? []) {
    if (a && typeof a.id === 'string' && Array.isArray(a.layers)) assets.set(a.id, a);
  }

  let uidSeq = 0;
  planScope(
    json.layers ?? [],
    { fr, compFrames, assets, out, warnings, nextUid: () => `L${uidSeq++}` },
    undefined,
    { x: 0, y: 0 },
    { shift: 0, lo: -Infinity, hi: Infinity },
    0,
    new Set<string>(),
  );

  return {
    comp: {
      width: json.w ?? 1920,
      height: json.h ?? 1080,
      fps: fr,
      durationSeconds: compFrames / fr,
    },
    layers: out,
    // One line per distinct problem — a file with 40 identical trim-path
    // warnings should tell the user "trim paths" once, not forty times.
    warnings: [...new Set(warnings)],
  };
}
