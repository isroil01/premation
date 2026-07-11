import {
  frameRate,
  FPS_24,
  FPS_30,
  framesToSeconds,
  secondsToFrames,
  framesToMs,
  msToFrames,
  convertFrames,
  framesToTimecode,
  timecodeToFrames,
} from '../time';

describe('time conversions', () => {
  it('converts frames ↔ seconds ↔ ms at 30fps', () => {
    expect(framesToSeconds(30, FPS_30)).toBe(1);
    expect(secondsToFrames(2, FPS_30)).toBe(60);
    expect(framesToMs(15, FPS_30)).toBe(500);
    expect(msToFrames(1000, FPS_30)).toBe(30);
  });

  it('handles custom frame rates', () => {
    const fps120 = frameRate(120);
    expect(framesToSeconds(120, fps120)).toBe(1);
    expect(secondsToFrames(0.5, fps120)).toBe(60);
  });

  it('converts between frame rates preserving wall-clock', () => {
    // 1 second at 24fps (24 frames) → 30 frames at 30fps.
    expect(convertFrames(24, FPS_24, FPS_30)).toBe(30);
  });
});

describe('timecode', () => {
  it('formats frames as HH:MM:SS:FF', () => {
    expect(framesToTimecode(0, FPS_30)).toBe('00:00:00:00');
    expect(framesToTimecode(30, FPS_30)).toBe('00:00:01:00');
    expect(framesToTimecode(90, FPS_30)).toBe('00:00:03:00');
    expect(framesToTimecode(30 * 60, FPS_30)).toBe('00:01:00:00');
    expect(framesToTimecode(30 * 3600 + 30 * 61 + 5, FPS_30)).toBe('01:01:01:05');
  });

  it('parses timecode back to frames (round-trip)', () => {
    for (const f of [0, 5, 30, 90, 1830, 108095]) {
      expect(timecodeToFrames(framesToTimecode(f, FPS_30), FPS_30)).toBe(f);
    }
  });

  it('parses flexible right-aligned forms', () => {
    expect(timecodeToFrames('15', FPS_30)).toBe(15); // frames only
    expect(timecodeToFrames('02:10', FPS_30)).toBe(2 * 30 + 10); // SS:FF
    expect(timecodeToFrames('01:00:00', FPS_30)).toBe(60 * 30); // MM:SS:FF
  });

  it('handles negative timecode', () => {
    expect(framesToTimecode(-30, FPS_30)).toBe('-00:00:01:00');
    expect(timecodeToFrames('-00:00:01:00', FPS_30)).toBe(-30);
  });

  it('throws on invalid segments', () => {
    expect(() => timecodeToFrames('aa:bb', FPS_30)).toThrow();
  });
});
