/**
 * Colour kernels that need the WHOLE pixel, or its neighbours — Selective
 * Colour and Shadow/Highlight.
 *
 * Both fail the `colorLut.ts` entry test, and for different reasons worth
 * keeping straight:
 *
 *   Selective Colour   reads all three channels to decide WHICH range a pixel
 *                      belongs to before it changes anything. A per-channel
 *                      table cannot ask "is this pixel more red than yellow".
 *   Shadow/Highlight   reads the pixel's NEIGHBOURS. Its whole point is that
 *                      the correction is driven by local average brightness,
 *                      not by the pixel's own value — which is what stops it
 *                      flattening texture the way a plain tone curve does.
 *
 * The second is the stronger disqualification: it is spatial, so it could never
 * be a transfer function of any kind, per-channel or otherwise.
 */

import { blurRgba } from './blurs';
import { luma } from './colorEffects';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Selective Colour ──────────────────────────────────────────────

/**
 * The nine colour ranges, by index — the same order as the AE/Photoshop
 * dropdown so the numbers mean what a user coming from either expects.
 *
 * A number, not a string, because that is this codebase's enum convention for
 * effect params and it is what makes the control keyframeable (see Card Wipe's
 * `flipOrder`). Animating it is genuinely useful: it steps the correction from
 * one range to another.
 */
export type SelectiveRange =
  | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'
  | 'whites' | 'neutrals' | 'blacks';

export function selectiveRange(v: number): SelectiveRange {
  return ([
    'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas',
    'whites', 'neutrals', 'blacks',
  ] as const)[Math.round(v)] ?? 'reds';
}

/**
 * How much a pixel belongs to one colour range, 0..1.
 *
 * The six chromatic ranges are decided by which channel is the extreme:
 *
 *   • a PRIMARY (red/green/blue) is where that channel is the MAXIMUM, and the
 *     membership is how far it leads the middle channel — a pure red is fully
 *     red, an orange is partly red and partly yellow, a grey is neither.
 *   • a SECONDARY (cyan/magenta/yellow) is where its opposite is the MINIMUM
 *     (cyan is "not much red"), and membership is how far the middle channel
 *     leads the minimum.
 *
 * Both are normalised by the maximum so membership depends on HUE and not on
 * how bright or dark the pixel happens to be — otherwise the same red would
 * grade differently in shadow than in light, which is the one thing a hue-
 * selective tool must not do.
 *
 * The three achromatic ranges partition the tonal axis instead: blacks below
 * mid, whites above it, neutrals peaking in the middle. They deliberately
 * overlap the chromatic ones — in Photoshop too — so a dark red can be reached
 * either as a red or as a black.
 */
export function rangeWeight(range: SelectiveRange, r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const mid = r + g + b - mx - mn;
  if (mx <= 0) {
    // Pure black: no hue to speak of, so only the tonal ranges can claim it.
    return range === 'blacks' ? 1 : 0;
  }
  const primary = (channel: number): number => (channel === mx ? (mx - mid) / mx : 0);
  const secondary = (opposite: number): number => (opposite === mn ? (mid - mn) / mx : 0);
  switch (range) {
    case 'reds': return primary(r);
    case 'greens': return primary(g);
    case 'blues': return primary(b);
    case 'cyans': return secondary(r);
    case 'magentas': return secondary(g);
    case 'yellows': return secondary(b);
    // Tonal ranges, on the 0..1 luma axis.
    case 'whites': return clamp01((mn - 0.5) * 2);
    case 'blacks': return clamp01((0.5 - mx) * 2);
    case 'neutrals': return clamp01(1 - (Math.abs(mx - 0.5) + Math.abs(mn - 0.5)) * 2);
  }
}

/**
 * Selective Colour — shift the CMYK make-up of one colour range.
 *
 * Converts each pixel to real CMYK, applies the four deltas scaled by the
 * pixel's membership in the chosen range, and converts back. Doing it in CMYK
 * rather than nudging RGB directly is the point of the effect: "take the yellow
 * out of the greens" is a printing operation, and it is the one that gives
 * foliage its colour without touching its brightness.
 *
 * `relative` scales each delta by how much of that ink is already there, so a
 * pixel with no cyan gains none — the safe mode, and the AE default. Absolute
 * adds the delta flat, which is what you want when you actually mean to
 * introduce an ink that was not there.
 *
 * Deltas arrive as −100..100 percentages.
 */
export function selectiveColorData(
  data: Uint8ClampedArray,
  range: SelectiveRange,
  cyan: number,
  magenta: number,
  yellow: number,
  black: number,
  relative: boolean,
): Uint8ClampedArray {
  const dc = cyan / 100, dm = magenta / 100, dy = yellow / 100, dk = black / 100;
  if (dc === 0 && dm === 0 && dy === 0 && dk === 0) return data;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // invisible pixels keep their bytes
    const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255;
    const w = rangeWeight(range, r, g, b);
    if (w <= 0) continue;

    // RGB → CMYK.
    const k = 1 - Math.max(r, g, b);
    const inv = 1 - k;
    if (inv <= 1e-6) {
      // Pure black has no chromatic inks; only the K delta can move it.
      const nk = clamp01(k + (relative ? dk * k : dk) * w);
      const v = Math.round((1 - nk) * 255);
      data[i] = v; data[i + 1] = v; data[i + 2] = v;
      continue;
    }
    const c = (1 - r - k) / inv;
    const m = (1 - g - k) / inv;
    const y = (1 - b - k) / inv;

    const apply = (v: number, d: number): number => clamp01(v + (relative ? d * v : d) * w);
    const nc = apply(c, dc), nm = apply(m, dm), ny = apply(y, dy);
    const nk = clamp01(k + (relative ? dk * k : dk) * w);
    const ninv = 1 - nk;

    data[i] = Math.round((1 - nc) * ninv * 255);
    data[i + 1] = Math.round((1 - nm) * ninv * 255);
    data[i + 2] = Math.round((1 - ny) * ninv * 255);
  }
  return data;
}

// ── Shadow / Highlight ────────────────────────────────────────────

/**
 * Shadow/Highlight — lift shadows and pull back highlights, LOCALLY.
 *
 * The distinguishing behaviour, and the reason it is not a tone curve: how much
 * a pixel is lifted depends on how bright its NEIGHBOURHOOD is, not how bright
 * it is. A dark speck inside a bright region is left alone; the same value
 * inside a dark region is lifted. That is what recovers a backlit subject
 * without flattening the texture inside the shadow — a curve lifting everything
 * below a threshold washes the texture out along with the shadow.
 *
 * `radius` is the size of that neighbourhood, and it is the control that
 * matters most: too small and the effect haloes every edge (the classic
 * over-cooked HDR look), too large and it degenerates into a plain tone curve.
 *
 * `tonalWidth` sets how far up from black (or down from white) the correction
 * reaches, as a percentage. Amounts are 0..100.
 */
export function shadowHighlightData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  shadowAmount: number,
  highlightAmount: number,
  radius: number,
  tonalWidth: number,
): Uint8ClampedArray {
  const sa = shadowAmount / 100;
  const ha = highlightAmount / 100;
  if (sa === 0 && ha === 0) return data;

  // The local-brightness map: a blurred COPY, so the blur reads the original
  // pixels rather than ones this pass has already corrected. Correcting in
  // place against a mask derived from the corrected image feeds the effect back
  // into itself and runs away over a large radius.
  const mask = blurRgba(new Uint8ClampedArray(data), w, h, Math.max(0, radius));

  // Guard the reciprocal: tonalWidth is reachable at 0 from the inspector, and
  // a zero width would divide every weight to Infinity → NaN → a black frame.
  const width = Math.max(0.01, tonalWidth / 100);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const local = luma(mask[i]!, mask[i + 1]!, mask[i + 2]!) / 255;

    // Gaussian falloff from each end of the tonal axis, same shape as Lumetri's
    // tone ranges so the two effects agree about what "a shadow" means.
    const ds = local / width;
    const dh = (1 - local) / width;
    const gain = 1 + sa * Math.exp(-ds * ds) - ha * Math.exp(-dh * dh);

    data[i] = data[i]! * gain;
    data[i + 1] = data[i + 1]! * gain;
    data[i + 2] = data[i + 2]! * gain;
  }
  return data;
}
