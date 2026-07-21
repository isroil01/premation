import { framesToTimecode, displayFramesToDomainSeconds } from './timecode';

describe('framesToTimecode', () => {
  it('formats seconds as mm:ss:ff at the frame rate', () => {
    expect(framesToTimecode(0, 30)).toBe('00:00:00');
    expect(framesToTimecode(1, 30)).toBe('00:01:00');
    // 1.5s at 30fps = frame 45 = 1s + 15 frames.
    expect(framesToTimecode(1.5, 30)).toBe('00:01:15');
  });

  it('pads the frames field to the fps width (stable at 120fps)', () => {
    expect(framesToTimecode(0, 120)).toBe('00:00:000');
    expect(framesToTimecode(0.5, 120)).toBe('00:00:060');
  });

  it('rolls into an hours field only once it reaches an hour', () => {
    expect(framesToTimecode(59 * 60 + 59, 30)).toBe('59:59:00');
    expect(framesToTimecode(3600, 30)).toBe('01:00:00:00');
  });

  it('offsets the DISPLAY by startFrame without touching the time', () => {
    // A comp that "starts at 1:00:00:00": frame 0 is labelled one hour in.
    const startFrame = 3600 * 30;
    expect(framesToTimecode(0, 30, startFrame)).toBe('01:00:00:00');
    // 2 real seconds in still reads two seconds past the start.
    expect(framesToTimecode(2, 30, startFrame)).toBe('01:00:02:00');
  });

  it('offsets by a sub-second start too', () => {
    // start at frame 45 (1.5s @30) — frame 0 reads 00:01:15.
    expect(framesToTimecode(0, 30, 45)).toBe('00:01:15');
  });

  it('never shows a negative time', () => {
    expect(framesToTimecode(-5, 30)).toBe('00:00:00');
  });

  it('falls back to 30fps on a bad rate rather than dividing by zero', () => {
    expect(framesToTimecode(1, 0)).toBe('00:01:00');
  });
});

describe('displayFramesToDomainSeconds', () => {
  it('is the inverse of the display offset', () => {
    const fps = 30;
    const startFrame = 3600 * 30; // one hour
    // The user reads "01:00:02:00" and types it back: it must land on 2s.
    const displaySeconds = 3600 + 2;
    expect(displayFramesToDomainSeconds(displaySeconds, fps, startFrame)).toBeCloseTo(2);
  });

  it('clamps below the start to 0 — you cannot seek before the comp begins', () => {
    // Typing a timecode earlier than the start lands on frame 0, not negative.
    expect(displayFramesToDomainSeconds(10, 30, 3600 * 30)).toBe(0);
  });

  it('is identity when there is no offset', () => {
    expect(displayFramesToDomainSeconds(5, 30, 0)).toBeCloseTo(5);
  });

  it('round-trips an arbitrary time through format+parse', () => {
    const fps = 24;
    const startFrame = 100;
    const domain = 3.75;
    // Frame the display would show, converted back, returns the same frame.
    const displaySeconds = domain + startFrame / fps;
    expect(displayFramesToDomainSeconds(displaySeconds, fps, startFrame)).toBeCloseTo(domain);
  });
});
