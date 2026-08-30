/**
 * Where the eye goes in a frame — the input to auto-reframe.
 *
 * ── Why classical, and why THIS classical ──────────────────────────────
 * The question auto-reframe has to answer is narrow: given this frame, which
 * horizontal slice of it would a person have chosen. A saliency model is
 * overkill for that and a face detector is under-kill (half the shots that need
 * reframing have no face in them). What actually predicts the answer, on real
 * edited footage, is two cheap signals:
 *
 *  • **Motion** — what changed since the previous frame. The subject is the
 *    thing that moves; the background is the thing that does not. This is the
 *    strongest cue by a distance, and it is free once two frames are in hand.
 *  • **Detail** — local gradient energy. It carries the shot when nothing is
 *    moving: a locked-off talking head, a title card, a product on a table.
 *
 * A centre PRIOR is then added — not multiplied. That distinction is the whole
 * trick, and it took a failing test to find: scaling the map by a centred bell
 * does nothing to a lone blob's centroid, because scaling a single cluster by
 * anything roughly constant across it leaves its centre exactly where it was. A
 * corner highlight in an otherwise empty frame therefore won outright, and the
 * crop lurched into the corner. Adding a weak centred field instead gives the
 * middle actual mass to compete with, so a weak or isolated signal is pulled
 * back toward centre while a real subject still wins on its own energy.
 *
 * The prior is scaled by the frame's OWN mean energy, so it cannot dominate a
 * busy shot or vanish on a quiet one.
 *
 * Everything here is pure — pixels in, a point out — so the behaviour can be
 * tested against synthetic frames rather than against a GPU. The scene work is
 * `autoReframe.ts`; the smoothing and the cut handling are `reframePath.ts`.
 */

/** Rec.601 luma, matching `lumaFromRGBA` in the tracker. */
export function lumaFromRgba(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * (rgba[p] as number) + 0.587 * (rgba[p + 1] as number) + 0.114 * (rgba[p + 2] as number);
  }
  return out;
}

export interface SaliencyOptions {
  /** Weight on inter-frame difference. The dominant cue when anything moves. */
  motionWeight?: number;
  /** Weight on local gradient energy. Carries a locked-off shot. */
  detailWeight?: number;
  /**
   * How much mass the centre gets, as a multiple of the frame's mean energy.
   *
   * At 0 a lone corner highlight wins outright; at 1 the middle competes with a
   * weak subject and beats an isolated speck. Deliberately non-zero by default:
   * a reframe that stays put is right far more often than one that chases
   * whatever is brightest.
   */
  centrePrior?: number;
}

const DEFAULTS: Required<SaliencyOptions> = {
  motionWeight: 1,
  detailWeight: 0.35,
  // 1.5 rather than 1: measured against the corner-highlight case, a prior of
  // 1 still left a lone speck holding the crop at 13% of frame width. The
  // centre has to out-mass an isolated highlight, not merely argue with it.
  centrePrior: 1.5,
};

/**
 * Per-pixel interest for one frame.
 *
 * `previous` may be null (the first frame of a shot), in which case only the
 * detail term contributes — which is correct: there is no motion to measure
 * yet, and inventing one from a black frame would put a cut's first frame
 * somewhere arbitrary.
 */
export function saliencyMap(
  luma: Float32Array,
  previous: Float32Array | null,
  width: number,
  height: number,
  options: SaliencyOptions = {},
): Float32Array {
  const opts = { ...DEFAULTS, ...options };
  const out = new Float32Array(width * height);
  const usePrevious = previous !== null && previous.length === luma.length;

  // The interior only: the gradient needs a neighbour on each side, and a
  // one-pixel border of zeros is invisible at analysis resolution.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = Math.abs((luma[i + 1] as number) - (luma[i - 1] as number));
      const dy = Math.abs((luma[i + width] as number) - (luma[i - width] as number));
      const detail = (dx + dy) * 0.5;
      const motion = usePrevious ? Math.abs((luma[i] as number) - (previous[i] as number)) : 0;
      out[i] = motion * opts.motionWeight + detail * opts.detailWeight;
    }
  }

  if (opts.centrePrior > 0) addCentrePrior(out, width, height, opts.centrePrior);
  return out;
}

/**
 * ADD a broad centred field, scaled by the map's own mean energy.
 *
 * A cosine bell rather than a Gaussian: it reaches exactly zero at the frame
 * edge, so the prior contributes nothing at the extremes and cannot itself pull
 * a genuinely edge-framed subject inward past the crop.
 *
 * Added, not multiplied — see the file header for why that is the whole point.
 * A no-op on a map with no energy at all: there is nothing to be centred
 * relative to, and `attentionCentre` already answers "dead centre, no
 * confidence" for that case.
 */
export function addCentrePrior(map: Float32Array, width: number, height: number, strength: number): void {
  let total = 0;
  for (let i = 0; i < map.length; i++) total += map[i] as number;
  if (total <= 0) return;
  const mean = total / map.length;

  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const rx = Math.max(1, cx);
  const ry = Math.max(1, cy);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const r = Math.min(1, Math.hypot(nx, ny));
      const bell = 0.5 + 0.5 * Math.cos(Math.PI * r); // 1 at centre, 0 at edge
      const i = y * width + x;
      map[i] = (map[i] as number) + mean * strength * bell;
    }
  }
}

export interface AttentionPoint {
  /** Normalised 0..1 across the frame. */
  x: number;
  y: number;
  /**
   * How concentrated the interest was, 0..1.
   *
   * Low means "this frame has no subject" — an empty sky, a fade, a flat
   * graphic — and the path builder holds still rather than acting on a centroid
   * that is really just the average of nothing.
   */
  confidence: number;
}

/**
 * The weighted centroid of a saliency map, and how much to believe it.
 *
 * Confidence is the share of total energy inside a window around the centroid,
 * rescaled against what a uniform map would score. A real subject concentrates
 * far more mass than uniform noise; a flat frame scores at or below it.
 */
export function attentionCentre(map: Float32Array, width: number, height: number): AttentionPoint {
  let total = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = map[y * width + x] as number;
      if (w <= 0) continue;
      total += w;
      sx += x * w;
      sy += y * w;
    }
  }
  // Nothing at all — a black frame, a solid colour. Dead centre, no confidence.
  if (total <= 0) return { x: 0.5, y: 0.5, confidence: 0 };

  const cx = sx / total;
  const cy = sy / total;

  // A third of the frame, the same fraction a 9:16 crop takes out of 16:9 —
  // so "concentrated" means "would fit in the crop this is choosing".
  const halfW = Math.max(1, width / 6);
  const halfH = Math.max(1, height / 6);
  let inside = 0;
  const x0 = Math.max(0, Math.floor(cx - halfW));
  const x1 = Math.min(width - 1, Math.ceil(cx + halfW));
  const y0 = Math.max(0, Math.floor(cy - halfH));
  const y1 = Math.min(height - 1, Math.ceil(cy + halfH));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) inside += Math.max(0, map[y * width + x] as number);
  }

  const share = inside / total;
  // What a perfectly uniform map would put in that window. Anything at or
  // below it carries no information about where to look.
  const uniform = ((x1 - x0 + 1) * (y1 - y0 + 1)) / (width * height);
  const confidence = uniform >= 1 ? 0 : Math.max(0, Math.min(1, (share - uniform) / (1 - uniform)));

  return { x: cx / Math.max(1, width - 1), y: cy / Math.max(1, height - 1), confidence };
}

/** One frame's attention point, from raw pixels. */
export function analyseFrame(
  rgba: Uint8ClampedArray,
  previousLuma: Float32Array | null,
  width: number,
  height: number,
  options?: SaliencyOptions,
): { point: AttentionPoint; luma: Float32Array } {
  const luma = lumaFromRgba(rgba, width, height);
  const map = saliencyMap(luma, previousLuma, width, height, options);
  return { point: attentionCentre(map, width, height), luma };
}
