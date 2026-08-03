/**
 * The Generate / Text formatters, asserted directly.
 *
 * The DRAWING half (drawLensFlare, drawTextReadout) needs real pixels and is
 * verified in a browser, like the other canvas-drawing effects. The formatting
 * half is where the edge cases live — negative time, hour rollover, a counter
 * that changes width as it animates — so that is what is pinned here.
 */

import { formatNumber, formatTimecode } from './generateText';

describe('formatNumber', () => {
  it('formats an integer with no decimals', () => {
    expect(formatNumber(42, 0, false, 0)).toBe('42');
  });

  it('honours the decimal count EXACTLY, keeping trailing zeros', () => {
    // A counter that drops its trailing zero jitters in width as it animates,
    // which is the one thing a numeric readout must never do.
    expect(formatNumber(1.5, 3, false, 0)).toBe('1.500');
    expect(formatNumber(2, 2, false, 0)).toBe('2.00');
  });

  it('rounds rather than truncating at the decimal limit', () => {
    expect(formatNumber(1.567, 2, false, 0)).toBe('1.57');
  });

  it('adds thousands separators when asked', () => {
    expect(formatNumber(1234567, 0, true, 0)).toBe('1,234,567');
    expect(formatNumber(999, 0, true, 0)).toBe('999');
  });

  it('pads the INTEGER part only', () => {
    // Padding the whole string would shift the number as its decimals change
    // width, defeating the point of padding.
    expect(formatNumber(7, 0, false, 4)).toBe('0007');
    expect(formatNumber(7.25, 2, false, 4)).toBe('0007.25');
  });

  it('keeps the sign outside the padding', () => {
    expect(formatNumber(-7, 0, false, 3)).toBe('-007');
  });

  it('combines commas and padding coherently', () => {
    expect(formatNumber(1234, 0, true, 6)).toBe('001,234');
  });

  it('clamps an absurd decimal count instead of throwing', () => {
    // toFixed throws above 100; the inspector can send anything.
    expect(() => formatNumber(1, 99, false, 0)).not.toThrow();
  });
});

describe('formatTimecode', () => {
  it('formats zero', () => {
    expect(formatTimecode(0, 24, false)).toBe('00:00:00:00');
  });

  it('counts frames within a second', () => {
    expect(formatTimecode(0.5, 24, false)).toBe('00:00:00:12');
  });

  it('TRUNCATES toward zero rather than rounding', () => {
    // At 24fps, 1.999s is still frame 23 of second 1. Rounding would show the
    // next second a frame early — the off-by-one that only surfaces when
    // someone matches a cut against a reference.
    expect(formatTimecode(1.999, 24, false)).toBe('00:00:01:23');
  });

  it('rolls over seconds, minutes and hours', () => {
    expect(formatTimecode(60, 24, false)).toBe('00:01:00:00');
    expect(formatTimecode(3600, 24, false)).toBe('01:00:00:00');
    expect(formatTimecode(3661, 24, false)).toBe('01:01:01:00');
  });

  it('respects the frame rate', () => {
    expect(formatTimecode(0.5, 30, false)).toBe('00:00:00:15');
    expect(formatTimecode(0.5, 60, false)).toBe('00:00:00:30');
  });

  it('never emits a frame number at or above the rate', () => {
    // The classic timecode bug: floating-point drift producing :24 at 24fps.
    for (let i = 0; i < 400; i++) {
      const tc = formatTimecode(i * 0.041666666, 24, false);
      const frames = Number(tc.slice(-2));
      expect(frames).toBeLessThan(24);
    }
  });

  it('signals drop-frame with a semicolon', () => {
    // The convention broadcast people read at a glance.
    expect(formatTimecode(1, 30, true)).toBe('00:00:01;00');
    expect(formatTimecode(1, 30, false)).toBe('00:00:01:00');
  });

  it('handles negative time without producing a malformed string', () => {
    expect(formatTimecode(-1.5, 24, false)).toBe('-00:00:01:12');
  });

  it('survives a zero or negative frame rate', () => {
    // Reachable from the inspector; a rate of 0 is a division by zero.
    expect(() => formatTimecode(5, 0, false)).not.toThrow();
    expect(formatTimecode(5, 0, false)).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
  });
});
