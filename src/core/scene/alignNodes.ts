/**
 * alignNodes — spatial alignment and distribution helpers.
 *
 * Positions are written through `writeTransformProps` — the same path the canvas
 * drag uses — onto each node's Transform `x`/`y` (centre-based, comp space).
 * That routing is load-bearing twice over: writing `node.transform.position`
 * would be a silent no-op (it is a derived, getter-only view), and a raw
 * base-prop write is silently discarded on a layer whose Position is ANIMATED,
 * because the renderer reads animated values first. Aligning an animated layer
 * used to appear to do nothing at all.
 *
 * Sizes come from the node's own width/height props when present (drag-created
 * shapes, media) with the renderer's per-kind SIZE as fallback, scaled by
 * scaleX/scaleY — matching what buildSnapshot actually draws.
 *
 * ## Alignment happens in COMPOSITION space, and that is the whole difficulty
 *
 * "Align left" means align the artwork you can see. A layer's `x`/`y` are not
 * that: they are values in its PARENT's space, sampled from keyframes at the
 * playhead. Reading them as if they were comp coordinates produced two failures
 * that were each reproducible in one gesture:
 *
 *   • an ANIMATED layer aligned to its rest pose — the box was measured from the
 *     base props while the artwork was somewhere else entirely; and
 *   • a PARENTED layer aligned in its parent's space — measured at world x = 100
 *     under a null at 500, its local x of −400 became the selection's left edge
 *     and every other layer was flung out there with it.
 *
 * So the boxes are measured through `world2DAt` (the transform chain the
 * renderer composes) and the answer is converted BACK through the parent's
 * inverse before it is written, because `x`/`y` are still parent-space values.
 *
 * ## Distribute
 *
 * AE's eight distribute buttons, as pure maths in `distributeBoxes`:
 *
 *   • by EDGE or CENTRE (left / h-centre / right, top / v-centre / bottom):
 *     that reference line is spaced evenly from the first layer's to the
 *     last's, sorted along the axis;
 *   • SPACING (horizontal / vertical): equal GAPS between the bounding boxes,
 *     which is the one that looks even when the layers differ in size.
 *
 * Relative to the selection the two extreme layers stay put and at least three
 * are needed (AE). Relative to the composition the extremes are the frame's
 * edges instead, so two layers are enough.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { writeTransformProps } from '@core/scene/transformWrite';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SIZE } from '@core/rendering/buildSnapshot';
import { world2DAt, parentWorld2DAt } from '@core/scene/layerSpace';
import { useProjectStore } from '@stores/projectStore';
import { Matrix } from '@motion/scene';

export type DistributeMode =
  | 'distribute-left' | 'distribute-h' | 'distribute-right'
  | 'distribute-top'  | 'distribute-v' | 'distribute-bottom'
  | 'distribute-space-h' | 'distribute-space-v';

export type AlignMode =
  | 'left' | 'center-h' | 'right'
  | 'top'  | 'middle-v' | 'bottom'
  | DistributeMode;

export interface Bounds { x: number; y: number; w: number; h: number; cx: number; cy: number; }

/** Fewest layers each distribute mode needs (AE: three against the selection). */
export function distributeMinimum(alignTo: 'selection' | 'composition'): number {
  return alignTo === 'composition' ? 2 : 3;
}

/** The playhead in raw comp time — alignment lines up what is on screen NOW. */
function playheadCompTime(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

/**
 * The node's box in COMPOSITION space at the playhead.
 *
 * The centre comes from the composed world matrix, so keyframes, expressions
 * and the parent chain are all already in it. The size is the layer's own
 * width/height times its WORLD scale (decomposed from the same matrix) — a
 * layer inside a scaled null is drawn at the null's scale, so aligning it by
 * its unscaled size would leave a visible gap.
 */
function getBounds(nodeId: string): Bounds | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  let width: number | undefined;
  let height: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.width === 'number') width = p.width;
    if (typeof p.height === 'number') height = p.height;
  }

  const kind = readNodeKind(node);
  const fallback = (SIZE as Record<string, { w: number; h: number } | undefined>)[kind];
  const m = world2DAt(nodeId, playheadCompTime());
  const d = Matrix.decompose(m);
  const sx = Math.abs(d.scale.x);
  const sy = Math.abs(d.scale.y);
  const w = (width ?? fallback?.w ?? 100) * sx;
  const h = (height ?? fallback?.h ?? 100) * sy;
  const centre = Matrix.transformPoint(m, { x: 0, y: 0 });
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h, cx: centre.x, cy: centre.y };
}

/**
 * Write a node's centre position.
 *
 * Goes through `writeTransformProps` so an aligned layer whose Position is
 * animated gets a KEYFRAME at the current time rather than a base-prop write
 * the renderer ignores. These were two raw `writeProp` calls, which meant
 * aligning any animated layer appeared to do nothing at all.
 */
function setPos(nodeId: string, x: number, y: number): void {
  const local = toParentSpace(nodeId, x, y);
  writeTransformProps(nodeId, [{ prop: 'x', value: local.x }, { prop: 'y', value: local.y }], 'Align');
}

/**
 * A comp-space centre → the node's PARENT-space `x`/`y`. The alignment maths
 * is in comp space, so the answer has to come back through the parent's
 * inverse — on an unparented layer that is the identity.
 */
function toParentSpace(nodeId: string, x: number, y: number): { x: number; y: number } {
  const inv = Matrix.invert(parentWorld2DAt(nodeId, playheadCompTime()));
  return Matrix.transformPoint(inv, { x, y });
}

type Ref = 'start' | 'centre' | 'end' | 'space';

const DISTRIBUTE: Readonly<Record<DistributeMode, { axis: 'x' | 'y'; ref: Ref }>> = {
  'distribute-left': { axis: 'x', ref: 'start' },
  'distribute-h': { axis: 'x', ref: 'centre' },
  'distribute-right': { axis: 'x', ref: 'end' },
  'distribute-top': { axis: 'y', ref: 'start' },
  'distribute-v': { axis: 'y', ref: 'centre' },
  'distribute-bottom': { axis: 'y', ref: 'end' },
  'distribute-space-h': { axis: 'x', ref: 'space' },
  'distribute-space-v': { axis: 'y', ref: 'space' },
};

export function isDistributeMode(mode: AlignMode): mode is DistributeMode {
  return mode in DISTRIBUTE;
}

/**
 * The new CENTRES for a distribution — pure, so the eight modes are testable
 * without a scene. Returns one entry per input box (input order), moved on the
 * distribute axis only; `null` when there are too few boxes.
 *
 * `frame` is the composition size when distributing relative to it: the
 * extremes then sit flush with the frame's edges.
 */
export function distributeBoxes(
  boxes: ReadonlyArray<Bounds>,
  mode: DistributeMode,
  frame?: { width: number; height: number },
): Array<{ cx: number; cy: number }> | null {
  const min = frame ? 2 : 3;
  if (boxes.length < min) return null;
  const { axis, ref } = DISTRIBUTE[mode];
  const lo = (b: Bounds): number => (axis === 'x' ? b.x : b.y);
  const size = (b: Bounds): number => (axis === 'x' ? b.w : b.h);
  const extent = frame ? (axis === 'x' ? frame.width : frame.height) : 0;

  const refOf = (b: Bounds): number =>
    ref === 'start' ? lo(b) : ref === 'end' ? lo(b) + size(b) : lo(b) + size(b) / 2;

  const order = boxes.map((b, i) => ({ b, i })).sort((p, q) =>
    ref === 'space' ? lo(p.b) - lo(q.b) : refOf(p.b) - refOf(q.b),
  );
  const out = boxes.map((b) => ({ cx: b.cx, cy: b.cy }));
  const place = (i: number, newLo: number): void => {
    const b = boxes[i]!;
    const c = newLo + size(b) / 2;
    if (axis === 'x') out[i] = { cx: c, cy: b.cy };
    else out[i] = { cx: b.cx, cy: c };
  };

  const first = order[0]!.b;
  const last = order[order.length - 1]!.b;
  const n = order.length;

  if (ref === 'space') {
    const start = frame ? 0 : lo(first);
    const end = frame ? extent : lo(last) + size(last);
    const total = order.reduce((s, o) => s + size(o.b), 0);
    const gap = (end - start - total) / (n - 1);
    let cursor = start;
    for (const o of order) {
      place(o.i, cursor);
      cursor += size(o.b) + gap;
    }
    return out;
  }

  // The reference line's first and last positions. Against the frame, the
  // first layer sits flush with the frame's start and the last with its end.
  const refPos = (b: Bounds, newLo: number): number =>
    ref === 'start' ? newLo : ref === 'end' ? newLo + size(b) : newLo + size(b) / 2;
  const r0 = frame ? refPos(first, 0) : refOf(first);
  const r1 = frame ? refPos(last, extent - size(last)) : refOf(last);
  order.forEach((o, k) => {
    const r = r0 + ((r1 - r0) * k) / (n - 1);
    const newLo = ref === 'start' ? r : ref === 'end' ? r - size(o.b) : r - size(o.b) / 2;
    place(o.i, newLo);
  });
  return out;
}

/** One node's new centre from {@link planAlign}: comp space, and the parent-space `x`/`y` to write. */
export interface AlignMove {
  id: string;
  /** Comp-space centre. */
  cx: number;
  cy: number;
  /** The same point in the node's parent space — the Position value to write. */
  x: number;
  y: number;
}

/**
 * The moves an align / distribute makes, WITHOUT writing them — the pure half
 * of {@link alignNodes}, for callers that send the writes themselves (the
 * inspector sends them to the engine API as one command, B3). Only nodes that
 * actually move are listed.
 */
export function planAlign(
  ids: ReadonlyArray<string>,
  mode: AlignMode,
  alignTo: 'selection' | 'composition' = 'selection',
  compWidth: number = 1920,
  compHeight: number = 1080,
): AlignMove[] {
  if (ids.length < 1) return [];
  const boxes = ids
    .map((id) => ({ id, b: getBounds(id) }))
    .filter((v): v is { id: string; b: Bounds } => v.b !== null);
  if (boxes.length === 0) return [];
  const out: AlignMove[] = [];
  const move = (id: string, cx: number, cy: number): void => {
    const p = toParentSpace(id, cx, cy);
    out.push({ id, cx, cy, x: p.x, y: p.y });
  };

  if (isDistributeMode(mode)) {
    const frame = alignTo === 'composition' ? { width: compWidth, height: compHeight } : undefined;
    const centres = distributeBoxes(boxes.map((v) => v.b), mode, frame);
    if (!centres) return [];
    centres.forEach((c, i) => {
      const { id, b } = boxes[i]!;
      if (Math.abs(c.cx - b.cx) > 1e-6 || Math.abs(c.cy - b.cy) > 1e-6) move(id, c.cx, c.cy);
    });
    return out;
  }

  const left   = alignTo === 'composition' ? 0 : Math.min(...boxes.map((v) => v.b.x));
  const top    = alignTo === 'composition' ? 0 : Math.min(...boxes.map((v) => v.b.y));
  const right  = alignTo === 'composition' ? compWidth : Math.max(...boxes.map((v) => v.b.x + v.b.w));
  const bottom = alignTo === 'composition' ? compHeight : Math.max(...boxes.map((v) => v.b.y + v.b.h));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;

  for (const { id, b } of boxes) {
    switch (mode) {
      case 'left':     move(id, left + b.w / 2,            b.cy); break;
      case 'center-h': move(id, cx,                        b.cy); break;
      case 'right':    move(id, right - b.w / 2,           b.cy); break;
      case 'top':      move(id, b.cx, top + b.h / 2);             break;
      case 'middle-v': move(id, b.cx, cy);                        break;
      case 'bottom':   move(id, b.cx, bottom - b.h / 2);          break;
      default: break;
    }
  }
  return out;
}

export function alignNodes(
  ids: string[],
  mode: AlignMode,
  alignTo: 'selection' | 'composition' = 'selection',
  compWidth: number = 1920,
  compHeight: number = 1080
): void {
  if (ids.length < 1) return;
  const boxes = ids
    .map((id) => ({ id, b: getBounds(id) }))
    .filter((v): v is { id: string; b: Bounds } => v.b !== null);
  if (boxes.length === 0) return;

  if (isDistributeMode(mode)) {
    const frame = alignTo === 'composition' ? { width: compWidth, height: compHeight } : undefined;
    const centres = distributeBoxes(boxes.map((v) => v.b), mode, frame);
    if (!centres) return;
    centres.forEach((c, i) => {
      const { id, b } = boxes[i]!;
      if (Math.abs(c.cx - b.cx) > 1e-6 || Math.abs(c.cy - b.cy) > 1e-6) setPos(id, c.cx, c.cy);
    });
    bumpScene();
    return;
  }

  const left   = alignTo === 'composition' ? 0 : Math.min(...boxes.map((v) => v.b.x));
  const top    = alignTo === 'composition' ? 0 : Math.min(...boxes.map((v) => v.b.y));
  const right  = alignTo === 'composition' ? compWidth : Math.max(...boxes.map((v) => v.b.x + v.b.w));
  const bottom = alignTo === 'composition' ? compHeight : Math.max(...boxes.map((v) => v.b.y + v.b.h));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;

  for (const { id, b } of boxes) {
    switch (mode) {
      case 'left':     setPos(id, left + b.w / 2,            b.cy); break;
      case 'center-h': setPos(id, cx,                        b.cy); break;
      case 'right':    setPos(id, right - b.w / 2,           b.cy); break;
      case 'top':      setPos(id, b.cx, top + b.h / 2);             break;
      case 'middle-v': setPos(id, b.cx, cy);                        break;
      case 'bottom':   setPos(id, b.cx, bottom - b.h / 2);          break;
      default: break;
    }
  }

  bumpScene();
}
