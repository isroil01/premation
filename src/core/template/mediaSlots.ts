/**
 * Media slots — dropping any source into a placeholder and getting it framed.
 *
 * This is the join between two things that already existed separately: template
 * exposed fields (which could swap a picture) and fit-as-commands (which could
 * frame a layer against a rect). Neither knew about the other, so filling a
 * template slot swapped the `src` and left the new clip forced into the
 * placeholder's authored box — a 9:16 phone recording squashed into a 16:9
 * placeholder, with the person filling the template expected to fix it by hand.
 *
 * ## The slot rect is the PLACEHOLDER, not the comp
 *
 * A slot is frequently not full-frame: a phone screen inside a device mockup, a
 * card in a grid, a masked region. Fitting against the composition would put
 * the source in the right shape and the wrong place. So the slot's frame is the
 * placeholder layer's own box, captured when the slot is authored.
 *
 * Captured, not read live, for one specific reason: **re-filling must not
 * compound**. If the rect were read from the layer's current width/height, the
 * first fill would shrink the box to the fitted size and the second fill would
 * fit against THAT — each fill nesting the source further inside the last. The
 * authored rect is the fixed point every fill resolves against.
 *
 * ## Why this never touches position, scale or rotation
 *
 * A template's placeholder is frequently animated — a card that slides in, a
 * screen that rotates. Writing fit into those properties would either overwrite
 * the author's keyframes or be overwritten by them at every frame but the
 * first. So fit is expressed ONLY as:
 *
 *   - `width`/`height` — the layer's box, which is not normally keyframed
 *     (scale is the animated property), and
 *   - a UV crop for `cover`, which is a render-time property of the source and
 *     touches no transform at all.
 *
 * Both compose UNDER the author's animation: the layer keeps animating exactly
 * as authored, and the fitted content rides along inside it. A slot in an
 * animated template still animates the way the author built it.
 *
 * Position needs no adjustment because a layer's `x`/`y` is its CENTRE, so a
 * box resized about its own centre stays centred in the slot rect — which is
 * what both contain and cover want.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { useAssetStore } from '@stores/assetStore';
import { sourceOf } from '@core/source/sourceInfo';
import { compSourceOf } from '@core/composition/compSizes';
import { computeFit, type Size } from '@core/source/fitCommands';
import type { SlotFit } from './templateTypes';
import type { SceneNode } from '@core/types';

/** Fit policy stored on the placeholder's Transform component. */
export const SLOT_FIT_PROP = 'slotFit';
/** The AUTHORED slot rect, captured once so re-fills never compound. */
export const SLOT_W_PROP = 'slotW';
export const SLOT_H_PROP = 'slotH';

export const DEFAULT_SLOT_FIT: SlotFit = 'contain';

function transformOf(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === 'Transform') as
    | { id: string; props: Record<string, unknown> }
    | undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined);

/**
 * Mark a layer as a media slot, capturing its CURRENT box as the slot rect.
 *
 * Idempotent on the rect: re-declaring a slot does not re-capture, so an author
 * who changes the policy after a fill does not silently adopt the fitted box as
 * the new frame.
 */
export function declareSlot(nodeId: string, fit: SlotFit = DEFAULT_SLOT_FIT): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformOf(node) : undefined;
  if (!node || !t) return false;

  defaultSceneGraph.writeProp(nodeId, t.id, SLOT_FIT_PROP, fit);
  if (num(t.props[SLOT_W_PROP]) === undefined) {
    const w = num(t.props.width);
    const h = num(t.props.height);
    if (w !== undefined && h !== undefined) {
      defaultSceneGraph.writeProp(nodeId, t.id, SLOT_W_PROP, w);
      defaultSceneGraph.writeProp(nodeId, t.id, SLOT_H_PROP, h);
    }
  }
  bumpScene();
  return true;
}

/** The authored slot rect, or null when this layer is not a slot. Falls back to
 *  the layer's current box for a slot declared before the rect was captured. */
export function slotRectOf(node: SceneNode): Size | null {
  const t = transformOf(node);
  if (!t) return null;
  const w = num(t.props[SLOT_W_PROP]) ?? num(t.props.width);
  const h = num(t.props[SLOT_H_PROP]) ?? num(t.props.height);
  if (w === undefined || h === undefined) return null;
  return { width: w, height: h };
}

/** The slot's fit policy, or null when this layer is not a slot. */
export function slotFitOf(node: SceneNode): SlotFit | null {
  const t = transformOf(node);
  const v = t?.props[SLOT_FIT_PROP];
  return v === 'contain' || v === 'cover' || v === 'native' ? v : null;
}

/**
 * The UV sub-rect a `cover` slot samples from its source.
 *
 * Cover has to fill the slot and crop the overflow. Doing that by scaling the
 * quad up would push the source outside the slot and over the rest of the
 * composition — worse than the unfitted default it replaces. Instead the quad
 * stays exactly the slot rect and the CROP happens in texture space, so
 * overflow is impossible by construction rather than by a clipping step that
 * could be forgotten.
 *
 * Returns null when no crop is needed (aspects already match, or the policy is
 * not cover), so the renderer keeps its default full-texture path.
 */
export function coverUvRect(
  source: Size,
  slot: Size,
): { x: number; y: number; width: number; height: number } | null {
  if (!(source.width > 0) || !(source.height > 0) || !(slot.width > 0) || !(slot.height > 0)) return null;
  const sourceAspect = source.width / source.height;
  const slotAspect = slot.width / slot.height;
  if (Math.abs(sourceAspect - slotAspect) < 1e-6) return null;

  if (sourceAspect > slotAspect) {
    // Source is wider than the slot: keep full height, crop the sides.
    const frac = slotAspect / sourceAspect;
    return { x: (1 - frac) / 2, y: 0, width: frac, height: 1 };
  }
  // Source is taller: keep full width, crop top and bottom.
  const frac = sourceAspect / slotAspect;
  return { x: 0, y: (1 - frac) / 2, width: 1, height: frac };
}

/** The box a filled slot's layer should occupy, given its source and policy. */
export function fittedBoxFor(source: Size, slot: Size, fit: SlotFit): Size {
  // Cover keeps the layer AT the slot rect — the crop is in UV space, not in
  // geometry, so the box must not grow.
  if (fit === 'cover') return { width: slot.width, height: slot.height };
  return computeFit(source, slot, fit === 'native' ? 'native' : 'contain');
}

export interface FillResult {
  /** The box written to the layer. */
  box: Size;
  fit: SlotFit;
  /** True when the source resolved and a real fit was applied. */
  fitted: boolean;
}

/**
 * Fill a slot with a source and reframe it.
 *
 * Accepts ANY source the editor understands — video, still, image sequence or a
 * composition — because it asks `sourceOf` for the intrinsic size rather than
 * branching on layer kind. A slot that only accepted one kind would be the same
 * fork removed from `mediaSourceFrames`.
 *
 * Returns null when the node is gone. When the source cannot be resolved yet
 * (metadata still loading, or an unrecognised URL) the `src` is still written
 * and `fitted` is false — the picture updates and the framing can be redone by
 * re-filling, which is better than refusing the fill.
 */
export function fillSlot(nodeId: string, src: string): FillResult | null {
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node ? transformOf(node) : undefined;
  if (!node || !t) return null;

  // Source first: `src` alone leaves `assetId` stale, and every reader of the
  // source boundary resolves by `assetId` (see templateFields.repointAsset).
  defaultSceneGraph.writeProp(nodeId, t.id, 'src', src);
  const match = useAssetStore.getState().assets.find((a) => a.src === src);
  defaultSceneGraph.writeProp(nodeId, t.id, 'assetId', match?.id);
  defaultSceneGraph.writeProp(nodeId, t.id, '__assetId', match?.id);

  const fit = slotFitOf(node) ?? DEFAULT_SLOT_FIT;
  const slot = slotRectOf(node);
  // Re-read: the asset write above changed what `sourceOf` resolves.
  const filled = defaultSceneGraph.getNode(nodeId);
  const source = filled ? sourceOf(filled, compSourceOf) : null;

  if (!slot || !source || !(source.width > 0) || !(source.height > 0)) {
    bumpScene();
    return { box: slot ?? { width: 0, height: 0 }, fit, fitted: false };
  }

  const box = fittedBoxFor({ width: source.width, height: source.height }, slot, fit);
  defaultSceneGraph.writeProp(nodeId, t.id, 'width', box.width);
  defaultSceneGraph.writeProp(nodeId, t.id, 'height', box.height);
  // x / y / scale / rotation are deliberately untouched — see the file header.
  bumpScene();
  return { box, fit, fitted: true };
}
