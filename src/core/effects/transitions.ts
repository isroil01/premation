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

/** Which way a Radial Wipe sweeps. */
export type RadialWipeDirection = 'clockwise' | 'counterclockwise' | 'both';

/** Map the stored 0/1/2 to the direction, defaulting to AE's clockwise. */
export function radialWipeDirection(v: number): RadialWipeDirection {
  return v >= 2 ? 'both' : v >= 1 ? 'counterclockwise' : 'clockwise';
}

/**
 * Radial Wipe — reveal by sweeping a hand around a centre.
 *
 * The clock wipe. Nothing else in the family can produce it: Linear Wipe travels
 * along a direction and Venetian Blinds opens slats, but neither has an origin
 * to pivot on, so neither can sweep. It is the transition for anything that
 * should read as time passing, and the standard way to build a progress dial.
 *
 * Angle zero is TWELVE O'CLOCK growing clockwise, the same convention
 * `polarCoordinatesData` uses and for the same reason: a clock wipe that starts
 * at three o'clock is not a clock wipe. `Math.atan2(y, x)` puts zero at three
 * and grows anticlockwise on screen, so the arguments swap and Y negates.
 *
 * `both` opens from the start angle in BOTH directions at once, so each side
 * only has to travel half as far — completion still finishes at 100, which is
 * what makes the three directions interchangeable on the same keyframes.
 *
 * `feather` softens the leading edge, in degrees of arc rather than pixels: a
 * pixel feather would be wide at the centre and invisible at the rim, since the
 * same arc covers less distance near the pivot.
 */
export function radialWipeData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  startAngleDeg: number,
  direction: RadialWipeDirection,
  centerX: number,
  centerY: number,
  featherDeg: number,
): Uint8ClampedArray {
  const t = completion <= 0 ? 0 : completion >= 1 ? 1 : completion;
  if (t <= 0) return data;
  if (t >= 1) {
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    return data;
  }

  const TAU = Math.PI * 2;
  const start = ((startAngleDeg * Math.PI) / 180) % TAU;
  // Half the sweep per side when opening both ways, so the two arms meet
  // exactly at completion 1.
  const swept = (direction === 'both' ? t / 2 : t) * TAU;
  const soft = Math.max(0, (featherDeg * Math.PI) / 180);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vx = x + 0.5 - centerX;
      const vy = y + 0.5 - centerY;
      // Twelve o'clock, clockwise.
      let a = Math.atan2(vx, -vy) - start;
      // Into 0..2π so the comparisons below are a single interval test rather
      // than a wrap-aware one.
      a = ((a % TAU) + TAU) % TAU;

      // How far INTO the swept region this pixel is. Negative = not yet reached.
      let into: number;
      if (direction === 'clockwise') {
        into = swept - a;
      } else if (direction === 'counterclockwise') {
        into = swept - (TAU - a);
      } else {
        // Whichever arm reaches it first.
        into = Math.max(swept - a, swept - (TAU - a));
      }

      let coverage: number;
      if (soft <= 0) {
        coverage = into > 0 ? 0 : 1;
      } else {
        coverage = Math.max(0, Math.min(1, -into / soft));
      }

      const o = (y * w + x) * 4;
      data[o + 3] = data[o + 3]! * coverage;
    }
  }
  return data;
}

/**
 * Block Dissolve — reveal in a pseudo-random order, one block at a time.
 *
 * The digital-glitch dissolve, and the one transition here whose look is set by
 * its BLOCK SIZE rather than its geometry: at 1×1 it is a per-pixel dissolve, at
 * 40×40 it is a chunky wipe-on, and the two read as completely different
 * effects. Gradient Wipe can imitate it only if someone first authors a noise
 * map at exactly the right block scale, which is the work this removes.
 *
 * ── The order must be a hash, not a shuffle ─────────────────────────────────
 *
 * Each block's reveal threshold is a hash of its own grid coordinates, so a
 * block's position in the order never changes. Drawing from a shuffled list
 * instead would re-shuffle whenever the block size changed — and, worse, blocks
 * would pop in and out as `completion` was scrubbed BACKWARDS, because the list
 * would be regenerated per frame. Hashing makes the transition a pure function
 * of completion, which is what lets it be scrubbed, reversed and cached.
 *
 * `feather` softens each block's own edges, so at high values the blocks read as
 * soft blobs rather than squares.
 */
export function blockDissolveData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  blockWidth: number,
  blockHeight: number,
  feather: number,
  seed: number,
): Uint8ClampedArray {
  const t = completion <= 0 ? 0 : completion >= 1 ? 1 : completion;
  if (t <= 0) return data;
  if (t >= 1) {
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    return data;
  }

  const bw = Math.max(1, Math.round(blockWidth));
  const bh = Math.max(1, Math.round(blockHeight));
  const soft = Math.max(0, feather);

  // The same integer hash the noise kernels in stylize.ts use, keyed on the
  // BLOCK's coordinates so every pixel of a block gets one shared threshold.
  const blockThreshold = (bx: number, by: number): number => {
    let n = bx * 374761393 + by * 668265263 + seed * 1442695040888963328;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const threshold = blockThreshold(Math.floor(x / bw), Math.floor(y / bh));

      // Not yet this block's turn — untouched.
      if (threshold >= t) continue;

      let coverage = 0;
      if (soft > 0) {
        // Distance to the nearest edge of this block, so the softening applies
        // inside the block rather than bleeding into its neighbours.
        const inX = Math.min(x % bw, bw - 1 - (x % bw));
        const inY = Math.min(y % bh, bh - 1 - (y % bh));
        coverage = 1 - Math.max(0, Math.min(1, Math.min(inX, inY) / soft));
      }
      data[o + 3] = data[o + 3]! * coverage;
    }
  }
  return data;
}
