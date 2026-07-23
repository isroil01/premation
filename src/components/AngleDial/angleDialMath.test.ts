import { pointerAngleDeg, wrapDeltaDeg, snapAngle, revolutionsOf, formatAngle } from './angleDialMath';

describe('angleDialMath', () => {
  describe('pointerAngleDeg (0° up, clockwise positive)', () => {
    it('maps the compass points', () => {
      expect(pointerAngleDeg(0, 0, 0, -10)).toBeCloseTo(0); // up
      expect(pointerAngleDeg(0, 0, 10, 0)).toBeCloseTo(90); // right
      expect(pointerAngleDeg(0, 0, 0, 10)).toBeCloseTo(180); // down
      expect(pointerAngleDeg(0, 0, -10, 0)).toBeCloseTo(-90); // left
    });

    it('handles diagonals and non-origin centres', () => {
      expect(pointerAngleDeg(0, 0, 10, -10)).toBeCloseTo(45);
      expect(pointerAngleDeg(100, 100, 100, 50)).toBeCloseTo(0);
      expect(pointerAngleDeg(100, 100, 150, 100)).toBeCloseTo(90);
    });

    it('returns 0 at the exact centre (no NaN)', () => {
      expect(pointerAngleDeg(5, 5, 5, 5)).toBe(0);
    });
  });

  describe('wrapDeltaDeg (seam-crossing deltas)', () => {
    it('passes small deltas through', () => {
      expect(wrapDeltaDeg(10)).toBe(10);
      expect(wrapDeltaDeg(-10)).toBe(-10);
      expect(wrapDeltaDeg(0)).toBe(0);
    });

    it('wraps across the ±180 seam to the short way round', () => {
      // e.g. raw goes 179 → -179: the pointer moved +2, not -358.
      expect(wrapDeltaDeg(-358)).toBeCloseTo(2);
      expect(wrapDeltaDeg(358)).toBeCloseTo(-2);
      expect(wrapDeltaDeg(190)).toBeCloseTo(-170);
      expect(wrapDeltaDeg(-190)).toBeCloseTo(170);
    });

    it('maps ±180 to +180 (never -180)', () => {
      expect(wrapDeltaDeg(180)).toBe(180);
      expect(wrapDeltaDeg(-180)).toBe(180);
    });

    it('accumulating wrapped deltas winds through a full revolution', () => {
      // Simulate a steady clockwise drag: raw pointer angle sweeps 4×360 in
      // 10° raw steps; the accumulated value must land on +720 (2 turns).
      let acc = 0;
      let lastRaw = 0;
      for (let i = 1; i <= 72; i++) {
        const raw = wrapDeltaDeg(i * 10); // raw angle as reported (wrapped)
        acc += wrapDeltaDeg(raw - lastRaw);
        lastRaw = raw;
      }
      expect(acc).toBeCloseTo(720);
    });
  });

  describe('snapAngle (Shift = 15°)', () => {
    it('snaps to the nearest 15°', () => {
      expect(snapAngle(7)).toBe(0);
      expect(snapAngle(8)).toBe(15);
      expect(snapAngle(52)).toBe(45);
      expect(snapAngle(53)).toBe(60);
      expect(snapAngle(-22)).toBe(-15);
      expect(snapAngle(-23)).toBe(-30);
    });

    it('snaps beyond a revolution and honours a custom step', () => {
      expect(snapAngle(451)).toBe(450);
      expect(snapAngle(93, 45)).toBe(90);
      expect(snapAngle(10, 0)).toBe(10); // degenerate step → unchanged
    });
  });

  describe('revolutionsOf', () => {
    it('is zero-turn within the first revolution', () => {
      expect(revolutionsOf(0)).toEqual({ turns: 0, rem: 0 });
      expect(revolutionsOf(359)).toEqual({ turns: 0, rem: 359 });
      expect(revolutionsOf(-359)).toEqual({ turns: 0, rem: -359 });
    });

    it('counts whole turns toward zero', () => {
      expect(revolutionsOf(450)).toEqual({ turns: 1, rem: 90 });
      expect(revolutionsOf(720)).toEqual({ turns: 2, rem: 0 });
      expect(revolutionsOf(-450)).toEqual({ turns: -1, rem: -90 });
      expect(revolutionsOf(-1085)).toEqual({ turns: -3, rem: -5 });
    });
  });

  describe('formatAngle (AE-style revolutions display)', () => {
    it('plain degrees within the first turn', () => {
      expect(formatAngle(0)).toBe('0°');
      expect(formatAngle(45)).toBe('45°');
      expect(formatAngle(-90)).toBe('-90°');
      expect(formatAngle(359.96)).toBe('360°'); // rounded to 1dp
    });

    it('Nx+rem beyond a full turn', () => {
      expect(formatAngle(405)).toBe('1x+45°');
      expect(formatAngle(720)).toBe('2x+0°');
      expect(formatAngle(-405)).toBe('-1x-45°');
      expect(formatAngle(1085.25)).toBe('3x+5.3°');
    });
  });
});
