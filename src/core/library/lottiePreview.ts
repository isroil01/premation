/**
 * Lottie preview — draw a Lottie document from the SAME plan the import applies.
 *
 * The library cards used to be hand-drawn SVG impressions of each item. They
 * were the only thing a user could judge an item by, and nothing tied them to
 * the document that actually got inserted — so when the documents were wrong,
 * the cards went on looking right, and "it doesn't come in like the preview"
 * was impossible to see coming.
 *
 * This renders `planLottieImport(doc)` — the exact plan `applyImportPlan` turns
 * into scene nodes — through the same transform composition the engine uses
 * (`world = parentWorld · T(x,y) · R · S`, with the node's own drawing offset by
 * its anchor; see `worldTransform.ts`). A card can therefore only be wrong in
 * the way the insert is wrong, which is the point: the preview is a measurement
 * of the document, not an illustration of it.
 *
 * Deliberately NOT a second renderer: no effects, mattes, masks or blend modes.
 * The bundled items are solid/gradient-filled rects, ellipses and paths, and
 * anything richer belongs on the real canvas.
 */

import { sampleTrack, type Keyframe, type PropertyTrack } from '@motion/animation';
import { planLottieImport, type ImportPlan, type LottieJson, type PlannedFill, type PlannedLayer } from '@core/lottie/lottieImport';

/** A 2×3 affine as [a, b, c, d, e, f] — the Canvas2D `setTransform` order. */
type Affine = readonly [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
function apply(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface LottiePreviewScene {
  plan: ImportPlan;
  /** Layers in draw order, parent links resolved to indices. */
  order: Array<{ layer: PlannedLayer; parent: number }>;
  /**
   * What the document covers AT REST, not its comp box. These items are wide
   * pills authored in a square 200×200 box, so fitting the comp box left a card
   * mostly empty and the artwork unreadably small.
   *
   * At rest rather than over the whole run because transient elements are
   * enormous — Glass Action's glow ring swells to 154px at 40% opacity and then
   * vanishes, and framing for it shrank the pill the card is actually about to
   * 45%. Peak-of-motion overshoot can spill past the edge during hover playback;
   * a card is judged on its resting frame.
   */
  content: Box;
  durationSec: number;
  /** The frame a still card shows — late enough that intros have settled. */
  restSec: number;
}

/** Value of a planned property at `t`: animated track first, static prop next. */
function valueAt(layer: PlannedLayer, prop: string, t: number, dflt: number): number {
  const track = layer.scalarTracks.find((s) => s.prop === prop);
  if (track) {
    const v = sampleTrack(
      { nodeId: layer.uid, prop: prop as PropertyTrack['prop'], keyframes: track.keyframes as unknown as Keyframe[] },
      t,
    );
    if (v !== undefined) return v;
  }
  const s = layer.staticProps[prop];
  return typeof s === 'number' ? s : dflt;
}

/** The local box a layer draws into (0 × 0 when it draws nothing). */
function drawBox(layer: PlannedLayer): { w: number; h: number } {
  const pts = layer.pointsTrack?.keyframes[0]?.value as Array<{ x: number; y: number }> | undefined;
  if (pts && pts.length > 0) {
    let m = 0;
    let n = 0;
    for (const p of pts) {
      m = Math.max(m, Math.abs(p.x));
      n = Math.max(n, Math.abs(p.y));
    }
    return { w: m * 2, h: n * 2 };
  }
  return {
    w: typeof layer.staticProps.width === 'number' ? layer.staticProps.width : 0,
    h: typeof layer.staticProps.height === 'number' ? layer.staticProps.height : 0,
  };
}

const drawsAnything = (l: PlannedLayer): boolean =>
  l.kind !== 'group' && l.kind !== 'null' && (l.pointsTrack !== undefined || drawBox(l).w > 0);

/**
 * World matrix + inherited opacity per layer at `t`, composed through the
 * parent chain exactly as `worldTransform.worldMatrixOf` does — anchor 0 in the
 * composition, because a node's anchor moves only its own drawing.
 */
function worldsAt(scene: LottiePreviewScene, t: number): Array<{ m: Affine; opacity: number }> {
  const out: Array<{ m: Affine; opacity: number }> = [];
  for (let i = 0; i < scene.order.length; i++) {
    const { layer, parent } = scene.order[i]!;
    const rot = (valueAt(layer, 'rotation', t, 0) * Math.PI) / 180;
    const sx = valueAt(layer, 'scaleX', t, 1);
    const sy = valueAt(layer, 'scaleY', t, 1);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const local: Affine = [
      cos * sx, sin * sx,
      -sin * sy, cos * sy,
      valueAt(layer, 'x', t, layer.x), valueAt(layer, 'y', t, layer.y),
    ];
    const base = parent >= 0 && out[parent] ? out[parent]! : { m: IDENTITY, opacity: 1 };
    // Lottie opacity is 0..100, as the planner leaves it.
    out.push({ m: multiply(base.m, local), opacity: base.opacity * (valueAt(layer, 'opacity', t, 100) / 100) });
  }
  return out;
}

/** Union of everything visibly drawn at `t`, in composition space. */
function contentBounds(scene: LottiePreviewScene, t: number): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const worlds = worldsAt(scene, t);
  for (let i = 0; i < scene.order.length; i++) {
    const { layer } = scene.order[i]!;
    if (!drawsAnything(layer)) continue;
    const w = worlds[i]!;
    if (w.opacity <= 0.01) continue;
    const box = drawBox(layer);
    const ax = valueAt(layer, 'anchorX', t, 0);
    const ay = valueAt(layer, 'anchorY', t, 0);
    for (const [cx, cy] of [
      [-box.w / 2, -box.h / 2], [box.w / 2, -box.h / 2],
      [box.w / 2, box.h / 2], [-box.w / 2, box.h / 2],
    ] as const) {
      const p = apply(w.m, cx - ax, cy - ay);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  // Nothing drawable (or a degenerate document): fall back to the comp box.
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) {
    return { x0: 0, y0: 0, x1: scene.plan.comp.width, y1: scene.plan.comp.height };
  }
  return { x0, y0, x1, y1 };
}

/** Plan a document once; the result is immutable and safe to memoize per item. */
export function prepareLottiePreview(doc: LottieJson): LottiePreviewScene {
  const plan = planLottieImport(doc);
  const indexByUid = new Map(plan.layers.map((l, i) => [l.uid, i]));
  const scene: LottiePreviewScene = {
    plan,
    order: plan.layers.map((layer) => ({
      layer,
      parent: layer.parentUid !== undefined ? indexByUid.get(layer.parentUid) ?? -1 : -1,
    })),
    content: { x0: 0, y0: 0, x1: plan.comp.width, y1: plan.comp.height },
    durationSec: plan.comp.durationSeconds,
    restSec: plan.comp.durationSeconds * 0.9,
  };
  return { ...scene, content: contentBounds(scene, scene.restSec) };
}

/** Trace a drawable's outline at the origin, matching the renderer's shapes. */
function tracePath(ctx: CanvasRenderingContext2D, layer: PlannedLayer, box: { w: number; h: number }): void {
  const pts = layer.pointsTrack?.keyframes[0]?.value as
    | Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>
    | undefined;
  if (pts && pts.length > 1) {
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    const open = layer.pointsTrack?.closed === false;
    const last = open ? pts.length - 1 : pts.length;
    for (let i = 0; i < last; i++) {
      const c = pts[i]!;
      const n = pts[(i + 1) % pts.length]!;
      ctx.bezierCurveTo(c.outX ?? c.x, c.outY ?? c.y, n.inX ?? n.x, n.inY ?? n.y, n.x, n.y);
    }
    if (!open) ctx.closePath();
    return;
  }
  if (layer.staticProps.shapeType === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const radius = typeof layer.staticProps.cornerRadius === 'number' ? layer.staticProps.cornerRadius : 0;
  const r = Math.max(0, Math.min(radius, box.w / 2, box.h / 2));
  ctx.beginPath();
  ctx.roundRect(-box.w / 2, -box.h / 2, box.w, box.h, r);
}

/** A planned paint → a canvas fill style, over the drawable's own box. */
function fillStyle(
  ctx: CanvasRenderingContext2D,
  fill: PlannedFill | undefined,
  fallback: string,
  box: { w: number; h: number },
): string | CanvasGradient {
  if (!fill) return fallback;
  if (fill.type === 'solid') return fill.color;
  const grad =
    fill.type === 'linear'
      ? (() => {
          const a = ((fill.angle ?? 90) * Math.PI) / 180;
          const r = Math.max(box.w, box.h) / 2;
          return ctx.createLinearGradient(-Math.cos(a) * r, -Math.sin(a) * r, Math.cos(a) * r, Math.sin(a) * r);
        })()
      : (() => {
          const cx = ((fill.cx ?? 0.5) - 0.5) * box.w;
          const cy = ((fill.cy ?? 0.5) - 0.5) * box.h;
          return ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, ((fill.radius ?? 0.5) * Math.hypot(box.w, box.h)) / 2));
        })();
  for (const s of fill.stops ?? []) grad.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color);
  return grad;
}

/**
 * Draw `scene` at time `t` (seconds) into a `w × h` canvas box.
 *
 * Contain-fits the document's resting CONTENT bounds with a small margin. The
 * framing is fixed for the whole run, so hover playback animates inside a
 * steady frame instead of the artwork swimming as its own bounds change.
 */
export function drawLottiePreview(
  ctx: CanvasRenderingContext2D,
  scene: LottiePreviewScene,
  t: number,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h);
  const MARGIN = 0.88;
  const cw = Math.max(1e-6, scene.content.x1 - scene.content.x0);
  const chh = Math.max(1e-6, scene.content.y1 - scene.content.y0);
  const fit = Math.min((w / cw) * MARGIN, (h / chh) * MARGIN);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(fit, fit);
  ctx.translate(-(scene.content.x0 + cw / 2), -(scene.content.y0 + chh / 2));

  const worlds = worldsAt(scene, t);
  for (let i = 0; i < scene.order.length; i++) {
    const { layer } = scene.order[i]!;
    // Containers (precomps, shape groups, nulls) carry transform only.
    if (!drawsAnything(layer)) continue;
    const world = worlds[i]!;
    if (world.opacity <= 0.001) continue;
    const box = drawBox(layer);

    ctx.save();
    const m = world.m;
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.translate(-valueAt(layer, 'anchorX', t, 0), -valueAt(layer, 'anchorY', t, 0));
    ctx.globalAlpha = Math.min(1, world.opacity);
    tracePath(ctx, layer, box);
    ctx.fillStyle = fillStyle(ctx, layer.fill, typeof layer.staticProps.fill === 'string' ? layer.staticProps.fill : '#888888', box);
    ctx.fill();
    if (layer.stroke && layer.stroke.width > 0) {
      ctx.globalAlpha = Math.min(1, world.opacity * layer.stroke.opacity);
      ctx.strokeStyle = layer.stroke.color;
      ctx.lineWidth = layer.stroke.width;
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}
