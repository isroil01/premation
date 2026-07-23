import { stepScale, clamp, format, scrubValue, SCRUB_DEAD_ZONE_PX } from './scrubMath';

const none = { shiftKey: false, altKey: false };
const shift = { shiftKey: true, altKey: false };
const alt = { shiftKey: false, altKey: true };

describe('scrubMath', () => {
  describe('stepScale', () => {
    it('is 1 with no modifiers, 10× with Shift, 0.1× with Alt', () => {
      expect(stepScale(none)).toBe(1);
      expect(stepScale(shift)).toBe(10);
      expect(stepScale(alt)).toBe(0.1);
    });

    it('Shift wins when both are held', () => {
      expect(stepScale({ shiftKey: true, altKey: true })).toBe(10);
    });
  });

  describe('scrubValue (1 unit/px default)', () => {
    it('moves 1 × step per pixel', () => {
      expect(scrubValue(100, 25, 1, none)).toBe(125);
      expect(scrubValue(100, -25, 1, none)).toBe(75);
      expect(scrubValue(0, 10, 0.5, none)).toBe(5); // custom step
    });

    it('Shift = 10× coarser, Alt = 0.1× finer', () => {
      expect(scrubValue(100, 10, 1, shift)).toBe(200);
      expect(scrubValue(100, 10, 1, alt)).toBeCloseTo(101);
    });

    it('clamps to min/max', () => {
      expect(scrubValue(95, 50, 1, none, 0, 100)).toBe(100);
      expect(scrubValue(5, -50, 1, none, 0, 100)).toBe(0);
    });
  });

  describe('clamp / format', () => {
    it('clamps', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
    });

    it('formats with trimmed trailing zeros and finite fallback', () => {
      expect(format(1.5, 2)).toBe('1.5');
      expect(format(1.499, 2)).toBe('1.5');
      expect(format(2, 2)).toBe('2');
      expect(format(Number.NaN, 2)).toBe('0');
      expect(format(Infinity, 2)).toBe('0');
    });
  });

  it('keeps the click-vs-drag dead zone at 3px', () => {
    expect(SCRUB_DEAD_ZONE_PX).toBe(3);
  });
});
