/**
 * Scrub continuity — the two ways the old absolute-delta scrub broke the
 * "feels like After Effects" contract, pinned so they cannot come back:
 *
 *   1. Changing the modifier MID-DRAG re-scaled the whole accumulated travel,
 *      so the value teleported instead of merely changing gear.
 *   2. The very first `movementX` after pointer lock is acquired is a huge
 *      synthetic jump; believed literally it threw the value off by thousands.
 *
 * The infinite-drag half of the fix (pointer lock itself) is a browser
 * capability and lives in ValueField; what is testable here is the math that
 * has to stay well-behaved whichever source the deltas come from.
 */

import {
  beginScrub,
  advanceScrub,
  sanitizeMovement,
  MAX_SCRUB_MOVEMENT_PX,
} from './scrubMath';

const none = { shiftKey: false, altKey: false };
const shift = { shiftKey: true, altKey: false };
const alt = { shiftKey: false, altKey: true };

describe('advanceScrub', () => {
  it('accumulates deltas at 1 × step per pixel', () => {
    let s = beginScrub(100, none);
    s = advanceScrub(s, 10, 1, none);
    s = advanceScrub(s, 10, 1, none);
    s = advanceScrub(s, 5, 1, none);
    expect(s.value).toBe(125);
  });

  it('is direction-symmetric', () => {
    let s = beginScrub(0, none);
    s = advanceScrub(s, 30, 1, none);
    s = advanceScrub(s, -30, 1, none);
    expect(s.value).toBe(0);
  });

  it('honours a custom step', () => {
    let s = beginScrub(0, none);
    s = advanceScrub(s, 10, 0.5, none);
    expect(s.value).toBe(5);
  });

  describe('modifier changes mid-drag', () => {
    it('changes GEAR, not position — no jump at the moment Shift goes down', () => {
      let s = beginScrub(100, none);
      s = advanceScrub(s, 40, 1, none);
      expect(s.value).toBe(140);

      // The frame Shift goes down must not move the value at all.
      s = advanceScrub(s, 0, 1, shift);
      expect(s.value).toBe(140);

      // From here on, 10× per pixel — measured from 140, not from 100.
      s = advanceScrub(s, 5, 1, shift);
      expect(s.value).toBe(190);
    });

    it('is symmetric for Alt (fine gear)', () => {
      let s = beginScrub(0, none);
      s = advanceScrub(s, 20, 1, none);
      s = advanceScrub(s, 10, 1, alt);
      expect(s.value).toBeCloseTo(21);
    });

    it('survives repeated gear changes without drift', () => {
      let s = beginScrub(0, none);
      s = advanceScrub(s, 10, 1, none);   // +10  → 10
      s = advanceScrub(s, 10, 1, shift);  // +100 → 110
      s = advanceScrub(s, 10, 1, none);   // +10  → 120
      s = advanceScrub(s, 10, 1, alt);    // +1   → 121
      expect(s.value).toBeCloseTo(121);
    });

    it('rebases from the CLAMPED value, so a gear change at a bound is stable', () => {
      let s = beginScrub(95, none, );
      s = advanceScrub(s, 50, 1, none, 0, 100);
      expect(s.value).toBe(100);
      s = advanceScrub(s, 0, 1, shift, 0, 100);
      expect(s.value).toBe(100);
    });
  });

  describe('clamping', () => {
    it('clamps to min/max', () => {
      let s = beginScrub(95, none);
      s = advanceScrub(s, 50, 1, none, 0, 100);
      expect(s.value).toBe(100);
      s = beginScrub(5, none);
      s = advanceScrub(s, -50, 1, none, 0, 100);
      expect(s.value).toBe(0);
    });

    it('keeps travelling past a bound and comes back off it on reversal', () => {
      let s = beginScrub(90, none);
      s = advanceScrub(s, 30, 1, none, 0, 100);   // wants 120, pinned at 100
      s = advanceScrub(s, -15, 1, none, 0, 100);  // wants 105, still pinned
      expect(s.value).toBe(100);
      s = advanceScrub(s, -15, 1, none, 0, 100);  // wants 90 — released
      expect(s.value).toBe(90);
    });
  });
});

describe('sanitizeMovement', () => {
  it('passes ordinary deltas through untouched', () => {
    expect(sanitizeMovement(12)).toBe(12);
    expect(sanitizeMovement(-12)).toBe(-12);
    expect(sanitizeMovement(0)).toBe(0);
  });

  it('clamps the pointer-lock acquisition spike', () => {
    expect(sanitizeMovement(9999)).toBe(MAX_SCRUB_MOVEMENT_PX);
    expect(sanitizeMovement(-9999)).toBe(-MAX_SCRUB_MOVEMENT_PX);
  });

  it('treats a non-finite delta as no movement', () => {
    expect(sanitizeMovement(Number.NaN)).toBe(0);
    expect(sanitizeMovement(Infinity)).toBe(0);
  });

  it('is applied by advanceScrub, so one bad event cannot wreck a value', () => {
    let s = beginScrub(0, none);
    s = advanceScrub(s, 100000, 1, none);
    expect(s.value).toBe(MAX_SCRUB_MOVEMENT_PX);
  });
});
