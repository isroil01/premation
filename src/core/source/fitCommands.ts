/**
 * Fit — one-shot commands that write transform values, After Effects style.
 *
 * **Fit is not a property.** That distinction is the whole reason the old Media
 * panel's "Fit Mode" dropdown never did anything: a stored `fitMode` would have
 * to be re-resolved by the renderer on every frame against a comp size that can
 * change, fighting whatever the user did with the selection handles afterwards,
 * with no defined winner between the two. AE models fit as a menu command that
 * computes a size ONCE and writes it into scale/size, leaving the layer an
 * ordinary layer afterwards. So does this.
 *
 * Every command reasons about the layer's INTRINSIC size via `sourceOf`, so a
 * placed composition, a still and a video clip all fit by the same rule — the
 * composition boundary's intrinsic-size contract used for layout instead of
 * rendering.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { writeTransformProps, readTransformProp } from '@core/scene/transformWrite';
import { compSourceOf } from '@core/composition/compSizes';
import { sourceOf, type SourceInfo } from '@core/source/sourceInfo';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';

/**
 * How a source is reconciled with the frame it is placed in.
 *
 * `contain` — whole source visible, letterboxed. The import default: a 4K clip
 *   dropped into a 1080 comp must be visible, not cropped to its centre quarter.
 * `cover` — fills the frame, overflow cropped. For full-bleed backgrounds.
 * `width` / `height` — match one axis, keep aspect (AE's Fit to Comp Width /
 *   Height).
 * `native` — the source's own pixel size, PAR-corrected.
 * `stretch` — fill exactly, aspect broken. Deliberately available but never a
 *   default.
 */
export type FitMode = 'contain' | 'cover' | 'width' | 'height' | 'native' | 'stretch';

export interface Size { width: number; height: number }

/**
 * The fitted box for a source in a frame. Pure, so the rule is testable without
 * a scene graph — this is the arithmetic that decides whether a 4K clip lands
 * inside a 1080 frame or four times outside it.
 */
export function computeFit(source: Size, frame: Size, mode: FitMode): Size {
  const sw = source.width;
  const sh = source.height;
  if (!(sw > 0) || !(sh > 0)) return { width: frame.width, height: frame.height };

  switch (mode) {
    case 'native':
      return { width: sw, height: sh };
    case 'stretch':
      return { width: frame.width, height: frame.height };
    case 'width': {
      const s = frame.width / sw;
      return { width: frame.width, height: Math.round(sh * s) };
    }
    case 'height': {
      const s = frame.height / sh;
      return { width: Math.round(sw * s), height: frame.height };
    }
    case 'cover': {
      const s = Math.max(frame.width / sw, frame.height / sh);
      return { width: Math.round(sw * s), height: Math.round(sh * s) };
    }
    case 'contain':
    default: {
      const s = Math.min(frame.width / sw, frame.height / sh);
      return { width: Math.round(sw * s), height: Math.round(sh * s) };
    }
  }
}

/** The Transform component, which carries x/y/width/height/scale/anchor. */
function transformComponent(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === 'Transform') as
    | { id: string; props: Record<string, unknown> }
    | undefined;
}

/**
 * The layer's intrinsic size, or null when it has none.
 *
 * Falls back to the renderer's per-kind default box for a media layer whose
 * asset metadata has not resolved yet — fitting to a plausible box beats
 * refusing to fit at all, and re-running the command once the probe lands gives
 * the exact answer.
 */
export function intrinsicSizeOf(node: SceneNode): Size | null {
  const source: SourceInfo | null = sourceOf(node, compSourceOf);
  if (source && source.width > 0 && source.height > 0) {
    return { width: source.width, height: source.height };
  }
  const fallback = (SIZE as Record<string, { w: number; h: number } | undefined>)[readNodeKind(node)];
  return fallback ? { width: fallback.w, height: fallback.h } : null;
}

/**
 * Resize a layer to `mode` against `frame`.
 *
 * Writes `width`/`height` and normalizes `scaleX`/`scaleY` to 1. The scale
 * reset is deliberate and worth stating: the drawn size is size × scale, so
 * writing a fitted size while leaving a stale 3× scale in place would produce a
 * layer three times bigger than the fit just asked for. After the command the
 * layer is an ordinary layer at an ordinary size, which is exactly what makes
 * the handles behave normally afterwards.
 */
export function fitNodeTo(nodeId: string, frame: Size, mode: FitMode): Size | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const t = transformComponent(node);
  const intrinsic = intrinsicSizeOf(node);
  if (!t || !intrinsic) return null;

  const fitted = computeFit(intrinsic, frame, mode);
  // Through writeTransformProps: on a layer with animated Scale, raw base
  // writes to scaleX/scaleY were discarded by the renderer (animated values
  // win), so Fit to Comp silently did nothing.
  writeTransformProps(
    nodeId,
    [
      { prop: 'width', value: fitted.width },
      { prop: 'height', value: fitted.height },
      { prop: 'scaleX', value: 1 },
      { prop: 'scaleY', value: 1 },
    ],
    'Fit Layer',
  );
  return fitted;
}

/**
 * Centre the anchor point in the layer's content (AE's "Centre Anchor Point in
 * Layer Content").
 *
 * Anchors are stored as an offset from the layer centre, so "centred" is
 * literally 0,0 — but the layer must not JUMP, and position places the anchor.
 * Moving the anchor back to centre therefore has to move position by the same
 * offset, which is the pan-behind compensation the anchor tool already applies
 * when dragging. Without it, centring the anchor teleports the layer by however
 * far the anchor had been dragged.
 */
export function centreAnchorInContent(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const t = transformComponent(node);
  if (!t) return;

  // At the playhead, animated values winning: this writes `x - ax` as a
  // KEYFRAME on an animated layer, so reading the base props made the layer
  // teleport to its rest pose minus the anchor. Same defect as Pan Behind's,
  // and it reached here through the same missing read-side reader.
  const ax = readTransformProp(nodeId, 'anchorX', 0);
  const ay = readTransformProp(nodeId, 'anchorY', 0);
  if (ax === 0 && ay === 0) return;

  const x = readTransformProp(nodeId, 'x', 0);
  const y = readTransformProp(nodeId, 'y', 0);
  // Rotation/scale are deliberately ignored here: the anchor offset is stored
  // in the layer's own unrotated space, and so is position.
  writeTransformProps(
    nodeId,
    [
      { prop: 'anchorX', value: 0 },
      { prop: 'anchorY', value: 0 },
      { prop: 'x', value: x - ax },
      { prop: 'y', value: y - ay },
    ],
    'Centre Anchor Point',
  );
}

/**
 * Centre a layer in the frame.
 *
 * ★ NOTHING CALLS THIS. The comment here used to say "used by auto-fit on
 * import", which was never true and sent a reader looking for a caller that
 * does not exist.
 *
 * Import auto-fit is `insertMedia` in `scene/sceneInsert.ts`, and it does the
 * two halves separately and WITHOUT this: `computeFit(source, frame, 'contain')`
 * decides the size, and `placeInComp` decides the position — under the pointer
 * when the drop had one, at the comp centre otherwise. The image-sequence path
 * beside it writes `comp.width / 2` onto the Transform component directly.
 *
 * All three of those run BEFORE the node is added to the graph, which is the
 * structural reason this function cannot be the one they use: it resolves a
 * node by id out of `defaultSceneGraph` and routes through `writeTransformProps`
 * (an undoable command). An insert has neither a node to look up nor an edit to
 * undo — the position is part of creating the layer, not a change to it.
 *
 * Kept as a candidate for the menu command it reads like ("Layer ▸ Centre in
 * Comp", which AE has and this does not). If that is not wanted, delete it —
 * see the dead-export list.
 */
export function centreInFrame(nodeId: string, frame: Size): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const t = transformComponent(node);
  if (!t) return;
  writeTransformProps(
    nodeId,
    [
      { prop: 'x', value: Math.round(frame.width / 2) },
      { prop: 'y', value: Math.round(frame.height / 2) },
    ],
    'Centre In Frame',
  );
}
