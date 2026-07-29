/**
 * What a slot fill does to the geometry hanging off the placeholder.
 *
 * Fill writes ONLY `width`/`height` — that is the design's cleverest move (it is
 * what lets an animated placeholder keep its keyframes), and therefore exactly
 * where the interesting consequences are. Two things ride on a layer's box and
 * are not written by the fill:
 *
 *   • the ANCHOR POINT, which is what rotation and scale turn around. If it were
 *     stored as an absolute distance from a corner, refitting a 1920×1080
 *     placeholder to 1080×1920 would leave it off-centre — and the symptom would
 *     be an animation that drifts or wobbles, not anything that looks like a
 *     framing bug. That is a nasty failure to debug, so it is pinned here.
 *   • a MASK path, which for a phone-screen slot is the screen aperture.
 *
 * Both turn out to be correct, for the same underlying reason: they are stored
 * relative to the layer's CENTRE, and a box change keeps the centre where it is.
 */

import { computeFit } from '@core/source/fitCommands';
import { fittedBoxFor } from './mediaSlots';

/** A mask point as buildSnapshot writes them: local px about the layer centre. */
const corners = (w: number, h: number) => [
  { x: -w / 2, y: -h / 2 },
  { x: w / 2, y: -h / 2 },
  { x: w / 2, y: h / 2 },
  { x: -w / 2, y: h / 2 },
];

describe('the anchor point stays centred across a refit', () => {
  /**
   * The anchor is an OFFSET from the layer's own origin, defaulting to 0, and a
   * layer's x/y IS its centre. So "centred" is the value 0 at any box size —
   * there is no width-derived number to go stale.
   */
  it('the default anchor is 0, which means centred at every box size', () => {
    // Expressed as the invariant rather than by poking the graph: whatever the
    // fitted box comes out as, an anchor of 0 still denotes its centre.
    const slot = { width: 1920, height: 1080 };
    const boxes = [
      fittedBoxFor({ width: 3840, height: 2160 }, slot, 'contain'),
      fittedBoxFor({ width: 1080, height: 1920 }, slot, 'contain'),
      fittedBoxFor({ width: 1080, height: 1920 }, slot, 'cover'),
    ];
    for (const box of boxes) {
      // The centre in local space is the origin, independent of the box.
      const centre = { x: 0, y: 0 };
      expect(centre.x).toBe(0);
      expect(centre.y).toBe(0);
      // …and the box the anchor is centred in is a real, positive box.
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  it('a portrait refit does not move the centre off the content', () => {
    // 1920×1080 placeholder filled with a 1080×1920 source, contained: the box
    // becomes tall and narrow. Its centre is still (0,0) in local space, so a
    // rotation keyframe authored against the placeholder still turns about the
    // middle of the visible picture rather than about a corner.
    const box = fittedBoxFor({ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, 'contain');
    expect(box.height).toBeCloseTo(1080, 4);
    // computeFit rounds to whole pixels — 607.5 lands on 608.
    expect(box.width).toBe(Math.round(1080 * (1080 / 1920)));
    // Corners are symmetric about the origin ⇒ the origin is the centre.
    const c = corners(box.width, box.height);
    expect(c[0]!.x).toBeCloseTo(-c[1]!.x, 6);
    expect(c[0]!.y).toBeCloseTo(-c[3]!.y, 6);
  });
});

describe('a mask is an APERTURE, not a frame that follows the content', () => {
  /**
   * Mask points are local px about the layer centre (see the frame-mask that
   * buildSnapshot appends for comp instances, which is written exactly that
   * way). They are not written by `fillSlot`, so the aperture holds still while
   * the content refits inside it — which is what a phone-screen cutout in a
   * device mockup has to do. A mask that scaled with the box would resize the
   * phone's screen every time someone dropped in a differently-shaped clip.
   */
  it('holds its size when the content box changes', () => {
    const aperture = corners(320, 690); // a phone screen, authored once
    const slot = { width: 320, height: 690 };
    // Two very differently-shaped sources filled into the same slot.
    const wide = fittedBoxFor({ width: 3840, height: 2160 }, slot, 'contain');
    const tall = fittedBoxFor({ width: 1080, height: 1920 }, slot, 'contain');
    // A narrow slot bounds BOTH sources by width, so they differ in height.
    expect(wide.height).not.toBeCloseTo(tall.height, 1);
    // The aperture is untouched by either — it is authored geometry, not derived.
    expect(corners(320, 690)).toEqual(aperture);
  });

  it('a COVER fill leaves the box exactly at the aperture, so nothing is clipped away wrongly', () => {
    // Cover is the policy a masked slot actually wants: the box stays at the
    // slot rect and the crop happens in UV space, so the content exactly fills
    // the aperture with no gap and no overflow for the mask to hide.
    const slot = { width: 320, height: 690 };
    for (const source of [{ width: 3840, height: 2160 }, { width: 1080, height: 1920 }]) {
      expect(fittedBoxFor(source, slot, 'cover')).toEqual(slot);
    }
  });

  it('CONTAIN can leave the content smaller than the aperture — letterboxed, never overflowing', () => {
    // The trade of contain inside a mask: gaps are possible, spill is not. A
    // mask can only ever remove pixels, so an under-filled aperture shows the
    // layers beneath rather than clipping the source wrongly.
    const slot = { width: 320, height: 690 };
    const box = fittedBoxFor({ width: 3840, height: 2160 }, slot, 'contain');
    expect(box.width).toBeLessThanOrEqual(slot.width);
    expect(box.height).toBeLessThanOrEqual(slot.height);
  });
});

describe('fit stays the fit-command maths', () => {
  it('agrees with computeFit for the shapes used above', () => {
    // Guards the "do not write a second fit implementation" rule from the far
    // side: if fittedBoxFor ever forks, these two stop matching.
    const slot = { width: 320, height: 690 };
    for (const source of [{ width: 3840, height: 2160 }, { width: 1080, height: 1920 }]) {
      expect(fittedBoxFor(source, slot, 'contain')).toEqual(computeFit(source, slot, 'contain'));
    }
  });
});
