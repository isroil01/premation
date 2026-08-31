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
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { writeTransformProps } from '@core/scene/transformWrite';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SIZE } from '@core/rendering/buildSnapshot';
import { world2DAt, parentWorld2DAt } from '@core/scene/layerSpace';
import { useProjectStore } from '@stores/projectStore';
import { Matrix } from '@motion/scene';

export type AlignMode =
  | 'left' | 'center-h' | 'right'
  | 'top'  | 'middle-v' | 'bottom'
  | 'distribute-h' | 'distribute-v';

interface Bounds { x: number; y: number; w: number; h: number; cx: number; cy: number; }

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
  // `x`/`y` are PARENT-space values. The alignment maths above is in comp
  // space, so the answer has to come back through the parent's inverse — on an
  // unparented layer that is the identity and this is the same write as before.
  const inv = Matrix.invert(parentWorld2DAt(nodeId, playheadCompTime()));
  const local = Matrix.transformPoint(inv, { x, y });
  writeTransformProps(nodeId, [{ prop: 'x', value: local.x }, { prop: 'y', value: local.y }], 'Align');
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

  if (mode === 'distribute-h' && boxes.length > (alignTo === 'composition' ? 1 : 2)) {
    const sorted = [...boxes].sort((a, b) => a.b.x - b.b.x);
    const totalW = sorted.reduce((s, v) => s + v.b.w, 0);
    const gap = (right - left - totalW) / (sorted.length - (alignTo === 'composition' ? 0 : 1));
    let cursor = left;
    if (alignTo === 'composition') {
      cursor += gap / 2;
    }
    for (const { id, b } of sorted) {
      setPos(id, cursor + b.w / 2, b.cy);
      cursor += b.w + gap;
    }
  }

  if (mode === 'distribute-v' && boxes.length > (alignTo === 'composition' ? 1 : 2)) {
    const sorted = [...boxes].sort((a, b) => a.b.y - b.b.y);
    const totalH = sorted.reduce((s, v) => s + v.b.h, 0);
    const gap = (bottom - top - totalH) / (sorted.length - (alignTo === 'composition' ? 0 : 1));
    let cursor = top;
    if (alignTo === 'composition') {
      cursor += gap / 2;
    }
    for (const { id, b } of sorted) {
      setPos(id, b.cx, cursor + b.h / 2);
      cursor += b.h + gap;
    }
  }

  bumpScene();
}
