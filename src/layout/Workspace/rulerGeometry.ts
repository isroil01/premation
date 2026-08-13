/**
 * Where the ruler bars ARE — the single geometry both the painter and the
 * hit-test read.
 *
 * Pulled out of useWorkspace.ts because the two had silently disagreed. The
 * painter (`paintRulers`) drew a 22 CSS-px bar pinned to the top and left edges
 * of the viewport; the hit-test (`rulerStrips`) still returned a 16-DEVICE-px
 * band hugging the composition frame, matching a `Canvas2DBackend.drawOverlays`
 * that no longer exists. So pressing on the visible ruler did nothing, while an
 * invisible band along the artboard edge — which moved with pan and zoom —
 * dragged guides out.
 *
 * Neither half was broken on its own, which is why it survived: both were
 * "working", in different places. A shared constant plus a test that measures
 * one against the other is what stops that recurring.
 */

/** Ruler bar thickness, CSS px. The painter and the hit-test share it. */
export const RULER_CSS_PX = 22;

export interface StripRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const inStrip = (r: StripRect, p: { x: number; y: number }): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * The two ruler strips in overlay (CSS px) space, given the stage's CSS size.
 *
 * The corner square belongs to NEITHER strip: a press there has no unambiguous
 * axis — horizontal guide or vertical? — so both strips start after it and the
 * corner stays inert, which is also how it looks.
 */
export function rulerStrips(cssW: number, cssH: number): { top: StripRect; left: StripRect } {
  const t = RULER_CSS_PX;
  return {
    top: { x: t, y: 0, width: Math.max(0, cssW - t), height: t },
    left: { x: 0, y: t, width: t, height: Math.max(0, cssH - t) },
  };
}
