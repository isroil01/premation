/**
 * Optics Compensation — the model, and the property the whole effect exists for.
 *
 * ## Why the round trip is the headline test
 *
 * This effect is used in MATCHED PAIRS: remove a lens's distortion so a plate
 * can be tracked and comped into with a pinhole camera, then re-apply the same
 * distortion so the CG sits in the plate. If those two operations do not cancel,
 * every shot that uses the workflow drifts — subtly, cumulatively, and in a way
 * that looks like a tracking error rather than an effect bug.
 *
 * That is the reason the model is `r / (1 + k·r²)` — a division — rather than
 * the polynomial `r·(1 + k·r²)` that most descriptions of barrel distortion
 * reach for first. The polynomial has no closed-form inverse, so "undo" would
 * be an iterative solve, and a round trip that lands *near* where it started is
 * exactly the failure above.
 *
 * ## Why these tests work on the mapping, not on pixels
 *
 * `opticsCompensationData` resamples an image, so testing it through pixels
 * means constructing a picture whose warp is legible — and a bilinear resample
 * of a synthetic pattern blurs precisely the evidence. The mapping is the
 * thing with the properties, so it is tested directly: the same arithmetic the
 * kernel runs, extracted into `sample` below, applied to points.
 *
 * A render scene (`effect-optics-compensation`) covers the pixels.
 */

import { opticsCompensationData } from './distort';

const W = 64;
const H = 48;

/**
 * Where a destination pixel reads from, recovered by running the kernel over an
 * image that encodes its own coordinates.
 *
 * Red carries x and green carries y, both scaled into 0..255. Decoding the
 * output therefore says, for each destination pixel, which source pixel the
 * kernel sampled — the mapping itself, read back through the real code path
 * rather than reimplemented beside it. A second implementation here would be
 * two things that must agree, and only one of them would be the shipped one.
 */
function mappingOf(
  fov: number,
  reverse: boolean,
  cx = 0,
  cy = 0,
): (dx: number, dy: number) => { x: number; y: number; valid: boolean } {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = Math.round((x / (W - 1)) * 255);
      data[i + 1] = Math.round((y / (H - 1)) * 255);
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  const out = opticsCompensationData(data, W, H, fov, reverse, cx, cy);
  return (dx, dy) => {
    const i = (dy * W + dx) * 4;
    return {
      x: (out[i]! / 255) * (W - 1),
      y: (out[i + 1]! / 255) * (H - 1),
      /*
        `valid` is not bookkeeping — it is the difference between a reading and
        a nonsense number.

        Applying distortion makes an edge pixel read from BEYOND the frame,
        which is correct: the content that would be there was never
        photographed. The bilinear tap then mixes in transparent black, and the
        decoded coordinate is a blend with zero rather than a coordinate. The
        first version of this file probed at the frame edge, read x = 11.6 out
        of a mapping that had actually sampled off-frame, and concluded the warp
        pointed the wrong way. Alpha is what distinguishes the two.
      */
      valid: out[i + 3] === 255,
    };
  };
}

/** Half-diagonal, which is what the model normalises radius by. */
const NORM = Math.hypot(W / 2, H / 2);
/** The coefficient the kernel derives from a field of view. */
const kFor = (fov: number): number => Math.tan((fov * Math.PI) / 360) * 0.5;

describe('the identity case is exactly the identity', () => {
  it('returns the SAME buffer at a field of view of zero', () => {
    // Not merely an equal one. A resample at k = 0 is still a resample, and
    // would cost a bilinear tap of softening for a control the user left off —
    // invisible in a diff of one layer and cumulative across a stack.
    const data = new Uint8ClampedArray(W * H * 4).fill(128);
    expect(opticsCompensationData(data, W, H, 0, false, 0, 0)).toBe(data);
  });

  it('treats a negative field of view as off rather than inverting it', () => {
    const data = new Uint8ClampedArray(W * H * 4).fill(128);
    expect(opticsCompensationData(data, W, H, -30, false, 0, 0)).toBe(data);
  });
});

describe('the two directions are inverses', () => {
  it('a remove/apply round trip returns each radius to where it started', () => {
    /*
      THE test — composing the two directions must be the identity, or every
      matched-pair workflow drifts.

      Stated on RADIUS rather than on a 2D point, because the model is radial:
      the remove map takes radius r to r/(1+k·r²), and the apply map must take
      that back to r. Chaining the two through pixels instead would resample
      twice and measure interpolation error rather than the model.
    */
    const remove = mappingOf(60, true);
    const apply = mappingOf(60, false);
    const cx = W / 2;
    const cy = H / 2;

    let worst = 0;
    let checked = 0;
    // Along the centre row, out to 80% of the half-width — far enough for the
    // quadratic term to dominate, near enough that the OUTWARD map still lands
    // inside the frame and can be read.
    for (let px = cx + 3; px < cx + (W / 2) * 0.8; px += 2) {
      const r1 = remove(px, cy);
      if (!r1.valid) continue;
      const rem = Math.abs(r1.x - cx);
      // Where the apply map, evaluated at that shrunken radius, reads from.
      const back = apply(Math.round(cx + rem), cy);
      if (!back.valid) continue;
      checked++;
      worst = Math.max(worst, Math.abs(Math.abs(back.x - cx) - (px - cx)));
    }
    // The premise: a loop that skipped everything would report a worst of 0.
    expect(checked).toBeGreaterThan(5);
    // Sub-pixel. The 8-bit coordinate encoding costs ~0.25 px on its own, and
    // rounding to a whole destination pixel costs up to another half.
    expect(worst).toBeLessThan(1.2);
  });

  it('the obvious "inverse" would NOT have closed the loop', () => {
    /*
      Why the outward branch is a solved quadratic and not `r·(1 + k·r²)`.

      That expression is the POLYNOMIAL distortion model — a different curve
      that reads like the opposite of the division one and is not its inverse.
      This pins the size of the error it would have left, so the next person to
      "simplify" the branch sees what it costs.

      The residual is small at the centre and grows with radius, which is the
      worst possible shape: it looks correct wherever anyone checks first.
    */
    const k = kFor(60);
    let worstNaive = 0;
    for (const r of [0.1, 0.35, 0.6, 0.9]) {
      const shrunk = r / (1 + k * r * r);
      worstNaive = Math.max(worstNaive, Math.abs(shrunk * (1 + k * shrunk * shrunk) - r));
    }
    // Percent-level drift on a normalised radius — tens of pixels on a 4K plate.
    expect(worstNaive).toBeGreaterThan(0.01);

    // The real inverse, which is what the kernel uses, closes to machine
    // precision at the same radii.
    let worstTrue = 0;
    for (const r of [0.1, 0.35, 0.6, 0.9]) {
      const s = r / (1 + k * r * r);
      const disc = 1 - 4 * s * s * k;
      const back = s * ((1 - Math.sqrt(disc)) / (2 * s * s * k));
      worstTrue = Math.max(worstTrue, Math.abs(back - r));
    }
    expect(worstTrue).toBeLessThan(1e-9);
    expect(NORM).toBeGreaterThan(0);
  });
});

describe('the warp is radial, and points the right way', () => {
  it('leaves the optical centre fixed', () => {
    const m = mappingOf(90, false);
    const p = m(W / 2, H / 2);
    expect(p.x).toBeCloseTo(W / 2, 0);
    expect(p.y).toBeCloseTo(H / 2, 0);
  });

  it('displaces the corners further than the centre', () => {
    // A radial model must grow with radius. A uniform scale would pass any
    // "did it move?" check and is not lens distortion.
    const m = mappingOf(90, false);
    const near = m(Math.round(W / 2) + 4, Math.round(H / 2));
    const far = m(W - 2, Math.round(H / 2));
    const dNear = Math.abs(near.x - (Math.round(W / 2) + 4));
    const dFar = Math.abs(far.x - (W - 2));
    expect(dFar).toBeGreaterThan(dNear * 3);
  });

  it('samples CLOSER IN when removing and FURTHER OUT when applying', () => {
    // The direction check. `remap` walks destinations and asks where to read,
    // so the two branches are the inverse of the visual transform — getting it
    // backwards gives a warp of the right magnitude in the wrong direction,
    // which looks entirely plausible in a still.
    const remove = mappingOf(90, true);
    const apply = mappingOf(90, false);
    const px = W - 6;
    const py = Math.round(H / 2);
    const rRemove = Math.abs(remove(px, py).x - W / 2);
    const rApply = Math.abs(apply(px, py).x - W / 2);
    expect(rRemove).toBeLessThan(Math.abs(px - W / 2));
    expect(rApply).toBeGreaterThan(Math.abs(px - W / 2));
  });

  it('moves the fixed point when the optical centre is offset', () => {
    // A real optical centre is rarely the middle of the sensor, and a control
    // that did nothing would be another dead one.
    const m = mappingOf(90, false, 10, -6);
    const atOffset = m(Math.round(W / 2 + 10), Math.round(H / 2 - 6));
    expect(atOffset.x).toBeCloseTo(W / 2 + 10, 0);
    expect(atOffset.y).toBeCloseTo(H / 2 - 6, 0);
  });

  it('is stronger at a wider field of view', () => {
    const mild = mappingOf(30, false);
    const wide = mappingOf(120, false);
    const px = W - 6;
    const py = Math.round(H / 2);
    expect(Math.abs(wide(px, py).x - px)).toBeGreaterThan(Math.abs(mild(px, py).x - px));
  });
});
