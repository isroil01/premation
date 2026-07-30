/**
 * Corner Pin — per-layer property (roadmap item 4).
 *
 * Four points that the layer's source rectangle is mapped onto, giving the
 * perspective foreshortening needed to paste a graphic onto an angled screen in
 * a device photo. Points are stored in NORMALISED [0,1] layer space (the unit
 * square, TL,TR,BR,BL) so a pin is resolution-independent and travels correctly
 * through responsive/comp-size changes; the default is the undistorted unit
 * square, which reads as "no pin".
 *
 * It is a SEPARATE render stage: the homography lives only on the render mvp
 * (see snapshotToFrameScene / passUtils), never in `layer.matrix`, whose affine
 * consumers (hit-test, bounds, masks, gizmo, snapping) read `.xy` without a
 * perspective divide and would be silently wrong under a projective matrix.
 *
 * Stored on the node's `fx` component like the other layer render data, so
 * History / autosave / export capture it for free. Value shape: a flat
 * [x0,y0, x1,y1, x2,y2, x3,y3] array (TL,TR,BR,BL) — compact and JSON-safe.
 *
 * SEMANTICS DECISION — effect-then-pin. The pin is the layer's final placement
 * transform: the layer (with its effect stack) rasterises into its texture, and
 * that texture is then warped onto the quad. So an effect in the layer's own
 * stack — a glow, a colour grade — foreshortens WITH the screen, which is
 * physically right for content that lives ON the screen. A bloom that should sit
 * in screen space over a pinned screen is expressed by nesting the pin in a
 * precomp and applying the bloom to the precomp, which composes cleanly. This
 * differs from AE, where Corner Pin is an effect and post-pin effects act in
 * screen space; the divergence is deliberate and stated here.
 */

import { isConvexQuad, UNIT_QUAD, type Quad } from '@motion/renderer';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

/** A corner pin as four normalised [0,1] points, TL,TR,BR,BL. */
export type CornerPin = readonly [number, number, number, number, number, number, number, number];

/** The undistorted default — the unit square, i.e. no pin. */
export const IDENTITY_CORNER_PIN: CornerPin = [0, 0, 1, 0, 1, 1, 0, 1];

/** Convert the flat storage form to a `Quad` for the homography math. */
export function cornerPinToQuad(pin: CornerPin): Quad {
  return [
    { x: pin[0], y: pin[1] },
    { x: pin[2], y: pin[3] },
    { x: pin[4], y: pin[5] },
    { x: pin[6], y: pin[7] },
  ];
}

/** True when the pin is (within epsilon) the undistorted unit square. */
export function isIdentityCornerPin(pin: CornerPin, eps = 1e-6): boolean {
  for (let i = 0; i < 8; i++) if (Math.abs(pin[i]! - IDENTITY_CORNER_PIN[i]!) > eps) return false;
  return true;
}

/**
 * A pin is USABLE when it is a strictly-convex, non-degenerate quad. A corner
 * dragged past the opposite edge sends the homography's w through zero (inverted
 * geometry, infinite stretch); such a configuration is rejected here so the
 * renderer never receives one and a layer never renders as broken garbage.
 */
export function isUsableCornerPin(pin: CornerPin): boolean {
  return isConvexQuad(cornerPinToQuad(pin));
}

function normalize(v: unknown): CornerPin | undefined {
  if (!Array.isArray(v) || v.length !== 8) return undefined;
  const nums = v.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : NaN));
  if (nums.some((n) => Number.isNaN(n))) return undefined;
  return nums as unknown as CornerPin;
}

/**
 * Read a node's corner pin from its `fx` component. Returns `undefined` when
 * there is no pin, the pin is the identity, or the pin is degenerate — every one
 * of those cases means "render on the affine path", so a single undefined return
 * lets callers skip the projective stage with one check.
 */
export function readNodeCornerPin(node: SceneNode): CornerPin | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  if (!fx || fx.props.cornerPin === undefined) return undefined;
  const pin = normalize(fx.props.cornerPin);
  if (!pin || isIdentityCornerPin(pin) || !isUsableCornerPin(pin)) return undefined;
  return pin;
}

/** The raw stored pin (identity default), for the inspector/gizmo to edit —
 *  unlike `readNodeCornerPin` this does not collapse identity/degenerate to
 *  undefined, so the UI can show and repair a pin mid-edit. */
export function getNodeCornerPin(nodeId: string): CornerPin {
  const node = defaultSceneGraph.getNode(nodeId);
  const fx = node?.components.find((c) => c.type === 'fx');
  const pin = fx && fx.props.cornerPin !== undefined ? normalize(fx.props.cornerPin) : undefined;
  return pin ?? [...IDENTITY_CORNER_PIN];
}

/**
 * Write a node's corner pin (clears back to no-pin when it is the identity).
 *
 * A degenerate (non-convex) pin is REJECTED — the write is a no-op — so the
 * store never holds a pin the renderer would have to defend against. The gizmo
 * is expected to clamp during a drag; this is the backstop for numeric entry and
 * programmatic writes.
 */
export function updateNodeCornerPin(nodeId: string, pin: CornerPin): boolean {
  const norm = normalize(pin);
  if (!norm) return false;
  if (!isIdentityCornerPin(norm) && !isUsableCornerPin(norm)) return false;
  const clear = isIdentityCornerPin(norm);
  defaultSceneGraph.setCornerPin(nodeId, clear ? undefined : [...norm]);
  getEventBus().emit('AnimationChanged', { nodeId });
  return true;
}

export { UNIT_QUAD };
