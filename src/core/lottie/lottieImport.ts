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
  ks?: { o?: LottieProp; r?: LottieProp; p?: LottieProp; s?: LottieProp; a?: LottieProp };
  shapes?: LottieShapeItem[];
  hasMask?: boolean;
  ef?: unknown[];
}
export interface LottieJson {
  v?: string;
  fr?: number;
  op?: number;
  w?: number;
  h?: number;
  layers?: LottieLayer[];
  assets?: unknown[];
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
export type PlannedKind = 'shape' | 'text' | 'image' | 'null' | 'solid';
export interface PlannedLayer {
  ind: number;
  parentInd?: number;
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

export function planLottieImport(json: LottieJson): ImportPlan {
  const fr = json.fr && json.fr > 0 ? json.fr : 30;
  const warnings: string[] = [];
  const layers: PlannedLayer[] = [];

  for (const [i, ll] of (json.layers ?? []).entries()) {
    const ind = ll.ind ?? i + 1;
    const name = ll.nm ?? `Layer ${ind}`;

    if (ll.ty === 0) {
      warnings.push(`Layer "${name}": precomp layers are not imported yet (flatten in the source, or import the sub-comp separately).`);
      continue;
    }
    const kind = KIND_BY_TY[ll.ty];
    if (!kind) {
      warnings.push(`Layer "${name}": unsupported layer type ${ll.ty} — skipped.`);
      continue;
    }

    const layer: PlannedLayer = { ind, parentInd: ll.parent, name, kind, x: 0, y: 0, staticProps: {}, scalarTracks: [] };
    const ks = ll.ks ?? {};

    // Position → static x/y or split scalar tracks.
    const px = channel(ks.p, 0, fr);
    const py = channel(ks.p, 1, fr);
    if (px.static !== undefined) layer.x = px.static;
    if (py.static !== undefined) layer.y = py.static;
    if (px.kfs && px.kfs.length >= 2) layer.scalarTracks.push({ prop: 'x', keyframes: px.kfs });
    else if (px.kfs?.[0]) layer.x = px.kfs[0].value;
    if (py.kfs && py.kfs.length >= 2) layer.scalarTracks.push({ prop: 'y', keyframes: py.kfs });
    else if (py.kfs?.[0]) layer.y = py.kfs[0].value;

    emit(layer, 'opacity', ks.o, 0, fr); // Lottie 0..100 == engine opacity
    emit(layer, 'rotation', ks.r, 0, fr);
    emit(layer, 'scaleX', ks.s, 0, fr, 1 / 100); // Lottie 100 == engine 1.0
    emit(layer, 'scaleY', ks.s, 1, fr, 1 / 100);
    emit(layer, 'anchorX', ks.a, 0, fr);
    emit(layer, 'anchorY', ks.a, 1, fr);

    if (ll.shapes) walkShapes(ll.shapes, fr, { layer, warnings });

    if (ll.ty === 5) warnings.push(`Layer "${name}": text imported as an empty text layer (glyph outlines/fonts are not embedded in Lottie).`);
    if (ll.ty === 2) warnings.push(`Layer "${name}": image layer needs its asset resolved before it renders.`);
    if (Array.isArray(ll.ef) && ll.ef.length > 0) warnings.push(`Layer "${name}": ${ll.ef.length} Lottie effect(s) not mapped.`);

    layers.push(layer);
  }

  return {
    comp: {
      width: json.w ?? 1920,
      height: json.h ?? 1080,
      fps: fr,
      durationSeconds: (json.op ?? fr * 5) / fr,
    },
    layers,
    warnings,
  };
}
