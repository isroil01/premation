/**
 * Transition kernels — Venetian Blinds, Gradient Wipe, Card Wipe.
 *
 * All three are ALPHA-ONLY reveals driven by a single `completion` parameter,
 * which is the shape that makes a transition usable: one keyframe from 0 to 100
 * is the whole effect, and everything else is a static look choice.
 *
 * They erase rather than composite. A transition effect's job is to take this
 * layer away and let whatever is beneath it show through, so what is underneath
 * is the compositor's business, not theirs.
 *
 * `completion` is a PERCENTAGE (0–100) at the boundary, matching AE and matching
 * `linear-wipe`, which already existed. The kernels take 0..1.
 */

/**
 * Venetian Blinds — reveal through parallel slats.
 *
 * The slats grow from a line rather than sliding, so at completion 50 exactly
 * half of every slat's width is gone. Sliding would move the transition across
 * the frame, which is Linear Wipe's job and already covered.
 *
 * `width` is the slat PITCH in px and `angle` rotates the whole set. The
 * rotation is applied to the sampling coordinate rather than to the buffer, so
 * no resampling happens and the slat edges stay hard at any angle.
 */
export function venetianBlindsData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  angleDeg: number,
  widthPx: number,
  feather: number,
): Uint8ClampedArray {
  const t = completion <= 0 ? 0 : completion >= 1 ? 1 : completion;
  if (t <= 0) return data;
  if (t >= 1) {
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    return data;
  }

  const pitch = Math.max(1, widthPx);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const soft = Math.max(0, feather);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Project onto the slat normal. Centred so rotation pivots on the middle
      // of the layer rather than its corner.
      const px = x - w / 2, py = y - h / 2;
      const proj = px * cos + py * sin;

      // Distance into the current slat, 0..pitch.
      let d = proj % pitch;
      if (d < 0) d += pitch;

      // The opening grows symmetrically from the slat's centre line.
      const half = (pitch * t) / 2;
      const fromCentre = Math.abs(d - pitch / 2);

      let coverage: number;
      if (soft <= 0) {
        coverage = fromCentre < half ? 0 : 1;
      } else {
        // Linear ramp across `soft` px at the opening's edge.
        coverage = Math.max(0, Math.min(1, (fromCentre - half) / soft));
      }

      const o = (y * w + x) * 4;
      data[o + 3] = data[o + 3]! * coverage;
    }
  }
  return data;
}

/**
 * Gradient Wipe — reveal in order of a luminance map.
 *
 * The most useful transition in the set, because the MAP decides the look: a
 * linear ramp gives a soft wipe, fractal noise gives a dissolve, a radial gives
 * an iris. One effect covers a family.
 *
 * `map` is a luminance-per-pixel array the same size as the layer, 0..1. It is
 * passed in rather than sampled here so the caller can source it from another
 * layer (matching AE) without this kernel knowing about layers at all — the same
 * separation that keeps `blurs.ts` and `stylize.ts` DOM-free.
 *
 * Pixels are revealed in luminance order: darkest first at completion 0.
 * `softness` is how wide the transition band is in luminance units, which is
 * what turns a hard threshold into a gradient wipe rather than a cut.
 */
export function gradientWipeData(
  data: Uint8ClampedArray,
  map: ReadonlyArray<number> | Float32Array,
  completion: number,
  softness: number,
  invert: boolean,
): Uint8ClampedArray {
  const t = completion <= 0 ? 0 : completion >= 1 ? 1 : completion;
  if (t <= 0) return data;

  // The band has to travel far enough that BOTH ends fully clear: at completion
  // 1 every pixel must be gone including the brightest, and at 0 none may have
  // started. Expanding the sweep by the softness on each side is what buys that
  // — a naive `threshold = t` leaves the softest pixels partly visible at 100%.
  const soft = Math.max(0.0001, softness);
  const threshold = t * (1 + soft * 2) - soft;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const raw = map[p] ?? 0;
    const lum = invert ? 1 - raw : raw;
    // Below the band → gone. Above → untouched. Inside → linear.
    const coverage = Math.max(0, Math.min(1, (lum - threshold) / soft));
    data[i + 3] = data[i + 3]! * coverage;
  }
  return data;
}

/**
 * Card Wipe — reveal as a grid of cards, each flipping away.
 *
 * The flip is faked by scaling each card's coverage rather than by rendering a
 * 3-D rotation: this is an alpha pass, and a real per-card perspective flip
 * needs geometry the effect chain does not have. Scaling reads convincingly at
 * speed, which is the only time this effect is ever seen.
 *
 * Cards leave in a staggered order set by `direction`, because all of them
 * flipping at once is a hard cut with extra steps.
 */
export function cardWipeData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  rows: number,
  columns: number,
  direction: 'left' | 'right' | 'up' | 'down' | 'radial',
): Uint8ClampedArray {
  const t = completion <= 0 ? 0 : completion >= 1 ? 1 : completion;
  if (t <= 0) return data;
  if (t >= 1) {
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    return data;
  }

  const cols = Math.max(1, Math.round(columns));
  const rws = Math.max(1, Math.round(rows));
  const cellW = w / cols;
  const cellH = h / rws;

  /** When this card starts flipping, 0..1. */
  const startOf = (cx: number, cy: number): number => {
    switch (direction) {
      case 'left': return cols <= 1 ? 0 : 1 - cx / (cols - 1);
      case 'right': return cols <= 1 ? 0 : cx / (cols - 1);
      case 'up': return rws <= 1 ? 0 : 1 - cy / (rws - 1);
      case 'down': return rws <= 1 ? 0 : cy / (rws - 1);
      case 'radial': {
        const dx = (cx + 0.5) / cols - 0.5;
        const dy = (cy + 0.5) / rws - 0.5;
        return Math.min(1, Math.hypot(dx, dy) * 2);
      }
    }
  };

  // Each card takes half the timeline to flip, so the stagger overlaps and the
  // wipe reads as a wave rather than a sequence of discrete pops.
  const cardDuration = 0.5;

  for (let y = 0; y < h; y++) {
    const cy = Math.min(rws - 1, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(cols - 1, Math.floor(x / cellW));

      const start = startOf(cx, cy) * (1 - cardDuration);
      const local = Math.max(0, Math.min(1, (t - start) / cardDuration));

      // The card shrinks toward its own centre line as it flips.
      const cardLeft = cx * cellW;
      const cardTop = cy * cellH;
      const u = (x - cardLeft) / cellW - 0.5;
      const v = (y - cardTop) / cellH - 0.5;

      const flipHorizontally = direction === 'left' || direction === 'right' || direction === 'radial';
      const half = (1 - local) / 2;
      const inside = flipHorizontally ? Math.abs(u) <= half : Math.abs(v) <= half;

      const o = (y * w + x) * 4;
      if (!inside) data[o + 3] = 0;
    }
  }
  return data;
}

/** AE's Card Wipe direction menu, stored as a number so it can be keyframed. */
export function cardWipeDirection(v: number): 'left' | 'right' | 'up' | 'down' | 'radial' {
  return (['right', 'left', 'down', 'up', 'radial'] as const)[Math.round(v)] ?? 'right';
}

/**
 * Build a luminance map for Gradient Wipe from the layer's own pixels.
 *
 * The fallback when no map layer is chosen. AE uses the layer itself in that
 * case too, which makes the effect immediately do something visible rather than
 * nothing — an effect that no-ops until you configure a second control reads as
 * broken.
 */
export function luminanceMapFrom(data: Uint8ClampedArray): Float32Array {
  const map = new Float32Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    map[p] = (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!) / 255;
  }
  return map;
}
