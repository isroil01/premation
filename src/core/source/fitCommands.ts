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
