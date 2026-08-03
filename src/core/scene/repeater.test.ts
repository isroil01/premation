import { repeaterCopies, defaultRepeater, type Repeater } from './repeater';

const base: Repeater = {
  copies: 3,
  offsetX: 100,
  offsetY: 0,
  offsetRotation: 0,
  offsetScale: 1,
  offsetOpacity: 1,
};

describe('repeaterCopies', () => {
  it('copy 0 is always the untouched original', () => {
    expect(repeaterCopies(base)[0]).toEqual({ index: 0, dx: 0, dy: 0, drot: 0, scaleMul: 1, opacityMul: 1 });
  });

  it('a pure X offset marches copies in a straight line', () => {
    const c = repeaterCopies(base);
    expect(c).toHaveLength(3);
    expect(c[1]!.dx).toBeCloseTo(100);
    expect(c[2]!.dx).toBeCloseTo(200);
    expect(c[1]!.dy).toBeCloseTo(0);
  });

  it('accumulates scale and opacity multiplicatively', () => {
    const c = repeaterCopies({ ...base, offsetScale: 0.5, offsetOpacity: 0.8 });
    expect(c[1]!.scaleMul).toBeCloseTo(0.5);
    expect(c[2]!.scaleMul).toBeCloseTo(0.25);
    expect(c[2]!.opacityMul).toBeCloseTo(0.64);
  });

  it('a rotation offset composes the offset in the rotated frame (traces a square)', () => {
    // offsetRotation 90° + offsetX 100 → copies step (0,100),(-100,100),(-100,0)…
    const c = repeaterCopies({ ...base, copies: 5, offsetRotation: 90 });
    expect(c[1]!.dx).toBeCloseTo(0);
    expect(c[1]!.dy).toBeCloseTo(100);
    expect(c[2]!.dx).toBeCloseTo(-100);
    expect(c[2]!.dy).toBeCloseTo(100);
    expect(c[3]!.dx).toBeCloseTo(-100);
    expect(c[3]!.dy).toBeCloseTo(0);
    // Fourth step returns to the origin → closed square.
    expect(c[4]!.dx).toBeCloseTo(0);
    expect(c[4]!.dy).toBeCloseTo(0);
    expect(c[2]!.drot).toBeCloseTo(180);
  });

  it('clamps copies to at least 1', () => {
    expect(repeaterCopies({ ...base, copies: 0 })).toHaveLength(1);
    expect(repeaterCopies({ ...base, copies: 3.9 })).toHaveLength(3);
  });

  it('default repeater is a sensible fan of 6', () => {
    expect(defaultRepeater().copies).toBe(6);
    expect(repeaterCopies(defaultRepeater())).toHaveLength(6);
  });
});

// ── Offset, Anchor Point and Composite ──────────────────────────────
//
// Each of these three defaults to a no-op, so the first thing to assert is
// that a repeater authored before they existed is bit-identical. Everything
// else is only safe to add because of that.
describe('repeater offset / anchor / composite', () => {
  const spun: Repeater = { ...base, copies: 4, offsetRotation: 30, offsetScale: 0.9, offsetOpacity: 0.8 };

  it('leaves a pre-existing repeater untouched', () => {
    expect(repeaterCopies({ ...spun, offset: 0, anchorX: 0, anchorY: 0, composite: 'above' }))
      .toEqual(repeaterCopies(spun));
  });

  describe('offset', () => {
    it('shifts the ladder by whole rungs', () => {
      // Copy 0 with offset 1 must sit exactly where copy 1 sat with offset 0.
      const plain = repeaterCopies(spun);
      const shifted = repeaterCopies({ ...spun, offset: 1 });
      expect(shifted[0]!.dx).toBeCloseTo(plain[1]!.dx);
      expect(shifted[0]!.dy).toBeCloseTo(plain[1]!.dy);
      expect(shifted[0]!.drot).toBeCloseTo(plain[1]!.drot);
      expect(shifted[0]!.scaleMul).toBeCloseTo(plain[1]!.scaleMul);
    });

    it('interpolates between rungs so an animated offset slides', () => {
      const half = repeaterCopies({ ...spun, offset: 0.5 })[0]!;
      const a = repeaterCopies(spun)[0]!;
      const b = repeaterCopies(spun)[1]!;
      expect(half.dx).toBeCloseTo((a.dx + b.dx) / 2);
      expect(half.drot).toBeCloseTo((a.drot + b.drot) / 2);
    });

    it('walks backwards for a negative offset, exactly undoing a forward step', () => {
      // −1 then +1 must return to the origin, not merely near it: the inverse
      // step has to unwind the rotation frame in the right order.
      const back = repeaterCopies({ ...spun, copies: 1, offset: -1 })[0]!;
      const fwd = repeaterCopies({ ...spun, copies: 1, offset: 0 })[0]!;
      expect(back.drot).toBeCloseTo(-spun.offsetRotation);
      expect(repeaterCopies({ ...spun, copies: 1, offset: -1 + 1 })[0]!.dx).toBeCloseTo(fwd.dx);
    });
  });

  describe('anchor point', () => {
    it('does nothing when the copies neither rotate nor scale', () => {
      // With no rotation and unit scale the pivot cannot matter — if it does,
      // the correction term is being applied where it should cancel.
      const flat: Repeater = { ...base, copies: 3, offsetRotation: 0, offsetScale: 1 };
      expect(repeaterCopies({ ...flat, anchorX: 60, anchorY: -25 })).toEqual(repeaterCopies(flat));
    });

    it('swings a rotated copy onto a different arc', () => {
      const at0 = repeaterCopies(spun)[2]!;
      const offPivot = repeaterCopies({ ...spun, anchorX: 120, anchorY: 0 })[2]!;
      expect(Math.hypot(offPivot.dx - at0.dx, offPivot.dy - at0.dy)).toBeGreaterThan(1);
      // The pivot changes WHERE a copy lands, never how far around it turned.
      expect(offPivot.drot).toBeCloseTo(at0.drot);
    });
  });

  describe('composite', () => {
    it('emits copy 0 first when above, last when below', () => {
      // buildSnapshot paints in list order and draws the original for index 0,
      // so this list order IS the stacking. Asserting the order is asserting
      // the z-order without needing a rendered frame.
      expect(repeaterCopies({ ...spun, composite: 'above' }).map((c) => c.index)).toEqual([0, 1, 2, 3]);
      expect(repeaterCopies({ ...spun, composite: 'below' }).map((c) => c.index)).toEqual([3, 2, 1, 0]);
    });

    it('reverses only the order, never the transforms', () => {
      const above = repeaterCopies({ ...spun, composite: 'above' });
      const below = repeaterCopies({ ...spun, composite: 'below' });
      expect(below.map((c) => c.dx)).toEqual([...above.map((c) => c.dx)].reverse());
    });
  });
});
