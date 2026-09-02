/**
 * Roll geometry — the properties that make a roll a roll rather than two trims.
 *
 * The invariant worth protecting is the one a user would notice instantly and
 * that no type can express: after a roll the pair still ENDS where it started
 * and there is still no seam. Everything else here is a bound that, if it were
 * missing, would let the edit invent media that does not exist — the failure
 * that made hand-rolled two-sided trims untrustworthy in the first place.
 */

import { Clip } from './Clip';
import { rollClips, rollLimits } from './Clip';

/** A bounded pair butted at frame 100, each with handles on both sides. */
function pair(): { left: Clip; right: Clip } {
  // left shows source [10, 110) of a 200-frame file → 90 frames of tail handle.
  const left = new Clip({ start: 0, duration: 100, sourceIn: 10, sourceDuration: 200 });
  // right shows source [40, 140) of a 200-frame file → 40 frames of head handle.
  const right = new Clip({ start: 100, duration: 100, sourceIn: 40, sourceDuration: 200 });
  return { left, right };
}

describe('rollLimits', () => {
  it('is bounded by the left tail handle and the right clip length', () => {
    const { left, right } = pair();
    // Right can give up 99 frames (minDuration 1) but the left only has 90
    // frames of unused source after its out point.
    expect(rollLimits(left, right).max).toBe(90);
  });

  it('is bounded by the right head handle and the left clip length', () => {
    const { left, right } = pair();
    // Left could shrink by 99, but the right only has 40 frames of source
    // before its in point to expand into.
    expect(rollLimits(left, right).min).toBe(-40);
  });

  it('treats an unbounded source as an infinite handle', () => {
    // Shapes, text and solids have no media to run out of. Reading
    // `sourceDuration - sourceOut` on them yields NaN, which silently clamps
    // every roll to zero — the bug this case exists to pin.
    const left = new Clip({ start: 0, duration: 100, sourceIn: 0, sourceDuration: null });
    const right = new Clip({ start: 100, duration: 100, sourceIn: 0, sourceDuration: null });
    // Only the clips' own lengths (minus minDuration) remain as bounds.
    expect(rollLimits(left, right)).toEqual({ min: -99, max: 99 });
  });

  it('respects minDuration on both sides', () => {
    const left = new Clip({ start: 0, duration: 100, sourceIn: 0, sourceDuration: null });
    const right = new Clip({ start: 100, duration: 100, sourceIn: 0, sourceDuration: null });
    expect(rollLimits(left, right, 10)).toEqual({ min: -90, max: 90 });
  });

  it('never lets the cut cross frame 0', () => {
    // A cut at frame 5 can only roll 5 frames left however much handle the
    // right clip has — negative timeline positions are not a thing.
    const left = new Clip({ start: 0, duration: 5, sourceIn: 0, sourceDuration: null });
    const right = new Clip({ start: 5, duration: 100, sourceIn: 50, sourceDuration: 200 });
    expect(rollLimits(left, right).min).toBe(-4); // minDuration keeps one frame
    const tight = rollLimits(new Clip({ start: 0, duration: 5, sourceIn: 0, sourceDuration: null }), new Clip({ start: 5, duration: 100, sourceIn: 50, sourceDuration: 200 }), 5);
    expect(tight.min).toBe(0);
  });
});

describe('rollClips', () => {
  it('moves the cut and keeps the pair gapless and the same total length', () => {
    const { left, right } = pair();
    const before = { start: left.start, end: right.end };
    expect(rollClips(left, right, 20)).toBe(20);
    expect(left.end).toBe(120);
    expect(right.start).toBe(120);
    // The two properties that distinguish a roll from any other edit.
    expect(right.start).toBe(left.end);
    expect({ start: left.start, end: right.end }).toEqual(before);
  });

  it('keeps both halves in sync with their source', () => {
    const { left, right } = pair();
    rollClips(left, right, 20);
    // Left kept its head, so it now shows 20 more frames of tail.
    expect(left.sourceIn).toBe(10);
    expect(left.sourceOut).toBe(130);
    // Right gave up 20 frames of head, so its in-point advanced by 20.
    expect(right.sourceIn).toBe(60);
    expect(right.sourceOut).toBe(140); // its out never moved
  });

  it('rolls backwards symmetrically', () => {
    const { left, right } = pair();
    expect(rollClips(left, right, -30)).toBe(-30);
    expect(left.end).toBe(70);
    expect(right.start).toBe(70);
    expect(left.sourceOut).toBe(80);
    expect(right.sourceIn).toBe(10);
  });

  it('clamps to the limits and reports the delta it actually applied', () => {
    const { left, right } = pair();
    // Asked for 500; the left clip has 90 frames of tail handle.
    expect(rollClips(left, right, 500)).toBe(90);
    expect(left.end).toBe(190);
    expect(right.start).toBe(190);
    expect(left.sourceOut).toBe(200); // exactly the end of the source
  });

  it('is a no-op, and says so, when the cut is already against a limit', () => {
    const { left, right } = pair();
    rollClips(left, right, 90);
    const snapshot = { left: left.toJSON(), right: right.toJSON() };
    expect(rollClips(left, right, 10)).toBe(0);
    expect(left.toJSON()).toEqual(snapshot.left);
    expect(right.toJSON()).toEqual(snapshot.right);
  });

  it('truncates a fractional delta rather than desynchronising the pair', () => {
    const { left, right } = pair();
    expect(rollClips(left, right, 12.7)).toBe(12);
    expect(left.end).toBe(112);
    expect(right.start).toBe(112);
  });
});
