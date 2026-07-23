/**
 * Lottie → scene import.
 *
 * Split in two:
 *   • planLottieImport(json)  — PURE. Lottie JSON → a typed ImportPlan
 *     (nodes, transform tracks, animated outlines, parent links, warnings).
 *     No scene/DOM deps, fully unit-tested.
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
 */

import {
  lottiePathKeyframes,
  type DataKeyframe,
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
interface LottieShapeItem {
  ty: string;
  it?: LottieShapeItem[];
  ks?: LottieShapeProp;
  c?: LottieProp; // fill color
  s?: LottieProp; // size (rc/el)
  r?: LottieProp; // corner radius
}
interface LottieLayer {
  ty: number;
  ind?: number;
  parent?: number;
  nm?: string;
  /** Precomp layers (`ty:0`) reference an entry in `assets[]` by id. */
  refId?: string;
  ks?: { o?: LottieProp; r?: LottieProp; p?: LottieProp; s?: LottieProp; a?: LottieProp };
  shapes?: LottieShapeItem[];
  hasMask?: boolean;
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

// ── Shape walking ──────────────────────────────────────────────────

function hexFromLottieColor(lp: LottieProp | undefined): string | undefined {
  const k = lp?.k;
  const arr = Array.isArray(k) ? (k as number[]) : undefined;
  if (!arr || arr.length < 3) return undefined;
  const h = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(arr[0]!)}${h(arr[1]!)}${h(arr[2]!)}`;
}

/** Walk a layer's shape items, collecting the first path + fill + rc/el size. */
function walkShapes(
  items: LottieShapeItem[],
  fr: number,
  out: { layer: PlannedLayer; warnings: string[] },
): void {
  for (const it of items) {
    switch (it.ty) {
      case 'gr':
        if (it.it) walkShapes(it.it, fr, out);
        break;
      case 'sh': {
        if (it.ks && !out.layer.pointsTrack) {
          const conv = lottiePathKeyframes(it.ks, fr);
          out.layer.pointsTrack = { keyframes: conv.keyframes, closed: conv.closed };
        }
        break;
      }
      case 'rc':
      case 'el': {
        const size = channel(it.s, 0, fr);
        const sizeY = channel(it.s, 1, fr);
        if (size.static !== undefined) out.layer.staticProps.width = size.static;
        if (sizeY.static !== undefined) out.layer.staticProps.height = sizeY.static;
        out.layer.staticProps.shapeType = it.ty === 'el' ? 'ellipse' : 'rect';
        const cr = channel(it.r, 0, fr);
        if (cr.static) out.layer.staticProps.cornerRadius = cr.static;
        break;
      }
      case 'fl': {
        const hex = hexFromLottieColor(it.c);
        if (hex) out.layer.staticProps.fill = hex;
        break;
      }
      case 'gf':
      case 'gs':
        out.warnings.push(`Layer "${out.layer.name}": gradient fill/stroke imported as flat (gradient stops not mapped).`);
        break;
      default:
        break;
    }
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
  const c = channel(lp, comp, fr);
  if (c.static !== undefined) return c.static;
  return c.kfs?.[0]?.value ?? 0;
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
    assets: Map<string, LottieAsset>;
    out: PlannedLayer[];
    warnings: string[];
    nextUid: () => string;
  },
  parentUidForRoots: string | undefined,
  rootOffset: { x: number; y: number },
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
      ctx.out.push(group);
      if (Array.isArray(ll.ef) && ll.ef.length > 0)
        ctx.warnings.push(`Layer "${name}": ${ll.ef.length} Lottie effect(s) not mapped.`);

      // Children render in the precomp's own space; the precomp anchor shifts
      // that whole space, so offset the asset's roots by minus the anchor.
      const ax = anchorComponent(ll.ks?.a, 0, ctx.fr);
      const ay = anchorComponent(ll.ks?.a, 1, ctx.fr);
      const nextSeen = ll.refId ? new Set(seenRefs).add(ll.refId) : seenRefs;
      planScope(asset.layers, ctx, uid, { x: -ax, y: -ay }, depth + 1, nextSeen);
      continue;
    }

    const kind = KIND_BY_TY[ll.ty];
    if (!kind) {
      ctx.warnings.push(`Layer "${name}": unsupported layer type ${ll.ty} — skipped.`);
      continue;
    }

    const layer = buildTransformLayer(ll, ind, uid, kind, ctx.fr, off);
    layer.parentUid = parentUid;

    if (ll.shapes) walkShapes(ll.shapes, ctx.fr, { layer, warnings: ctx.warnings });

    if (ll.ty === 5) ctx.warnings.push(`Layer "${name}": text imported as an empty text layer (glyph outlines/fonts are not embedded in Lottie).`);
    if (ll.ty === 2) ctx.warnings.push(`Layer "${name}": image layer needs its asset resolved before it renders.`);
    if (Array.isArray(ll.ef) && ll.ef.length > 0) ctx.warnings.push(`Layer "${name}": ${ll.ef.length} Lottie effect(s) not mapped.`);

    ctx.out.push(layer);
  }
}

export function planLottieImport(json: LottieJson): ImportPlan {
  const fr = json.fr && json.fr > 0 ? json.fr : 30;
  const warnings: string[] = [];
  const out: PlannedLayer[] = [];

  // Precomp assets are those carrying `layers`; image assets (no layers) are
  // ignored here (image layers warn separately).
  const assets = new Map<string, LottieAsset>();
  for (const a of json.assets ?? []) {
    if (a && typeof a.id === 'string' && Array.isArray(a.layers)) assets.set(a.id, a);
  }

  let uidSeq = 0;
  planScope(
    json.layers ?? [],
    { fr, assets, out, warnings, nextUid: () => `L${uidSeq++}` },
    undefined,
    { x: 0, y: 0 },
    0,
    new Set<string>(),
  );

  return {
    comp: {
      width: json.w ?? 1920,
      height: json.h ?? 1080,
      fps: fr,
      durationSeconds: (json.op ?? fr * 5) / fr,
    },
    layers: out,
    warnings,
  };
}
