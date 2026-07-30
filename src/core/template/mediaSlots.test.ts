/**
 * Media slots: drop any source into a placeholder and get it framed.
 *
 * The behaviours pinned here are the ones that make a template fillable by
 * someone who is not the author — every one of them was previously the filler's
 * job to fix by hand.
 */

import { computeFit } from '@core/source/fitCommands';
import { coverUvRect, fittedBoxFor } from './mediaSlots';

const UHD_16_9 = { width: 3840, height: 2160 };
const VERTICAL = { width: 1080, height: 1920 };
const SQUARE = { width: 1000, height: 1000 };

/** A full-frame slot, and a small one offset inside a mockup. */
const FULL_FRAME = { width: 1920, height: 1080 };
const PHONE_SCREEN = { width: 320, height: 690 };

function contains(box: { width: number; height: number }, slot: { width: number; height: number }): boolean {
  return box.width <= slot.width + 1e-6 && box.height <= slot.height + 1e-6;
}

describe('a full-frame slot', () => {
  it('contains a 4K 16:9 source inside the slot', () => {
    const box = fittedBoxFor(UHD_16_9, FULL_FRAME, 'contain');
    expect(box).toEqual({ width: 1920, height: 1080 });
    expect(contains(box, FULL_FRAME)).toBe(true);
  });

  it('contains a 1080x1920 vertical source inside the slot, letterboxed', () => {
    const box = fittedBoxFor(VERTICAL, FULL_FRAME, 'contain');
    expect(box).toEqual({ width: 608, height: 1080 });
    expect(contains(box, FULL_FRAME)).toBe(true);
    // Letterboxed, not filled — the whole source is visible.
    expect(box.width).toBeLessThan(FULL_FRAME.width);
  });

  it('covers with either source WITHOUT the box exceeding the slot', () => {
    // The critical property: cover crops in UV space, so the drawn geometry is
    // exactly the slot. A cover that grew the box would bleed over the rest of
    // the composition — worse than the unfitted default it replaces.
    for (const source of [UHD_16_9, VERTICAL]) {
      const box = fittedBoxFor(source, FULL_FRAME, 'cover');
      expect(box).toEqual(FULL_FRAME);
      expect(contains(box, FULL_FRAME)).toBe(true);
    }
  });

  it('crops the sides of a wide source and the ends of a tall one', () => {
    const wide = coverUvRect(UHD_16_9, FULL_FRAME);
    // 16:9 into 16:9 needs no crop at all.
    expect(wide).toBeNull();

    const tall = coverUvRect(VERTICAL, FULL_FRAME);
    // 9:16 into 16:9: keep full width, crop top and bottom, stay centred.
    expect(tall).not.toBeNull();
    expect(tall!.width).toBeCloseTo(1, 6);
    expect(tall!.height).toBeCloseTo((1080 / 1920) / (1920 / 1080), 6);
    expect(tall!.y).toBeCloseTo((1 - tall!.height) / 2, 6);

    // A square source in a WIDE slot is also "taller than the slot": it keeps
    // full width and loses the top and bottom.
    const square = coverUvRect(SQUARE, FULL_FRAME)!;
    expect(square.width).toBeCloseTo(1, 6);
    expect(square.height).toBeCloseTo(1080 / 1920, 6);
    expect(square.y).toBeCloseTo((1 - square.height) / 2, 6);
  });

  it('keeps a cover crop inside the texture', () => {
    for (const source of [UHD_16_9, VERTICAL, SQUARE]) {
      const uv = coverUvRect(source, FULL_FRAME);
      if (!uv) continue;
      expect(uv.x).toBeGreaterThanOrEqual(0);
      expect(uv.y).toBeGreaterThanOrEqual(0);
      expect(uv.x + uv.width).toBeLessThanOrEqual(1 + 1e-6);
      expect(uv.y + uv.height).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

describe('a small, non-full-frame slot', () => {
  it('fits against the SLOT rect, not the composition', () => {
    // A phone screen inside a device mockup. Fitting to the comp would give the
    // right shape in entirely the wrong place and size.
    const box = fittedBoxFor(UHD_16_9, PHONE_SCREEN, 'contain');
    expect(contains(box, PHONE_SCREEN)).toBe(true);
    expect(box.width).toBe(320);
    expect(box.height).toBe(180);
    // Emphatically not the comp size.
    expect(box).not.toEqual(FULL_FRAME);
  });

  it('covers a phone screen with a 16:9 clip by cropping its sides', () => {
    const box = fittedBoxFor(UHD_16_9, PHONE_SCREEN, 'cover');
    expect(box).toEqual(PHONE_SCREEN);
    const uv = coverUvRect(UHD_16_9, PHONE_SCREEN)!;
    // Wide source into a tall slot: full height, sides cropped hard.
    expect(uv.height).toBeCloseTo(1, 6);
    expect(uv.width).toBeLessThan(0.3);
  });

  it('is unaffected by where the slot sits — fit is size-only', () => {
    // Position lives on the layer's x/y, which fillSlot never touches; the
    // fitted box for a given rect is the same wherever that rect is.
    const a = fittedBoxFor(VERTICAL, PHONE_SCREEN, 'contain');
    const b = fittedBoxFor(VERTICAL, { ...PHONE_SCREEN }, 'contain');
    expect(a).toEqual(b);
  });
});

describe('source kinds are not forked', () => {
  it('frames a composition source exactly like footage of the same size', () => {
    // sourceOf answers for comps, stills and footage alike, so the fit maths
    // never learns what kind of thing it is looking at.
    const asComp = fittedBoxFor({ width: 1080, height: 1920 }, FULL_FRAME, 'contain');
    const asVideo = fittedBoxFor(VERTICAL, FULL_FRAME, 'contain');
    expect(asComp).toEqual(asVideo);
  });

  it('frames a still exactly like footage', () => {
    const still = fittedBoxFor(SQUARE, PHONE_SCREEN, 'cover');
    expect(still).toEqual(PHONE_SCREEN);
  });
});

describe('re-filling does not compound', () => {
  it('reframes from the AUTHORED rect, not the previous fit', () => {
    // First fill shrinks the box to 1920x1080 -> 608x1080 for a vertical clip.
    const first = fittedBoxFor(VERTICAL, FULL_FRAME, 'contain');
    expect(first).toEqual({ width: 608, height: 1080 });

    // Second fill with a WIDE clip must resolve against the original slot rect.
    // Resolving against `first` would give 608x342 — the source nested inside
    // the previous fit, shrinking on every fill.
    const correct = fittedBoxFor(UHD_16_9, FULL_FRAME, 'contain');
    const compounded = fittedBoxFor(UHD_16_9, first, 'contain');
    expect(correct).toEqual({ width: 1920, height: 1080 });
    expect(compounded).not.toEqual(correct);
  });

  it('is idempotent for the same source', () => {
    const once = fittedBoxFor(VERTICAL, FULL_FRAME, 'contain');
    const twice = fittedBoxFor(VERTICAL, FULL_FRAME, 'contain');
    expect(twice).toEqual(once);
  });
});

describe('native', () => {
  it('leaves the source at its own size, even outside the slot', () => {
    // Deliberate: native means "do not scale". An author choosing it wants the
    // slot as a position marker.
    expect(fittedBoxFor(UHD_16_9, PHONE_SCREEN, 'native')).toEqual(UHD_16_9);
  });
});

describe('fit maths is the fit-command maths', () => {
  it('contain matches computeFit exactly — one implementation', () => {
    for (const source of [UHD_16_9, VERTICAL, SQUARE]) {
      for (const slot of [FULL_FRAME, PHONE_SCREEN]) {
        expect(fittedBoxFor(source, slot, 'contain')).toEqual(computeFit(source, slot, 'contain'));
        expect(fittedBoxFor(source, slot, 'native')).toEqual(computeFit(source, slot, 'native'));
      }
    }
  });
});

describe('degenerate input', () => {
  it('does not crop when the source size is unknown', () => {
    expect(coverUvRect({ width: 0, height: 0 }, FULL_FRAME)).toBeNull();
  });

  it('does not crop against a zero-sized slot', () => {
    expect(coverUvRect(UHD_16_9, { width: 0, height: 0 })).toBeNull();
  });
});
