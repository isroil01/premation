/**
 * Frame tap gating and cropping.
 *
 * jsdom has no 2D context, so the scratch surface is stubbed. That is not a
 * weaker test than the real thing for what matters here: the whole point of
 * this module is WHEN it does work and WHAT rectangle it copies, and both are
 * decided before a single pixel moves.
 */

import {
  DEFAULT_FRAME_TAP_HZ,
  frameTapActive,
  latestTappedFrame,
  publishFrame,
  resetFrameTap,
  setFrameTapInterval,
  setFrameTapRegion,
  subscribeFrames,
  type TappedFrame,
} from './frameTap';

interface DrawCall {
  sx: number; sy: number; sw: number; sh: number;
  dx: number; dy: number; dw: number; dh: number;
}

const draws: DrawCall[] = [];
let contexts = 0;
let realCreateElement: typeof document.createElement;

function fakeContext(canvas: { width: number; height: number }): unknown {
  return {
    clearRect: () => undefined,
    drawImage: (
      _src: unknown,
      sx: number, sy: number, sw: number, sh: number,
      dx: number, dy: number, dw: number, dh: number,
    ) => {
      draws.push({ sx, sy, sw, sh, dx, dy, dw, dh });
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    canvas,
  };
}

/** A canvas that reports a size and hands back the stub context. */
function stubCanvas(): HTMLCanvasElement {
  const canvas = { width: 0, height: 0, getContext: () => { contexts++; return fakeContext(canvas); } };
  return canvas as unknown as HTMLCanvasElement;
}

/** Stand-in for the viewport's WebGL content canvas. */
function sourceCanvas(width: number, height: number): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  resetFrameTap();
  draws.length = 0;
  contexts = 0;
  realCreateElement = document.createElement.bind(document);
  jest.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    tag === 'canvas' ? stubCanvas() : realCreateElement(tag)) as typeof document.createElement);
});

afterEach(() => {
  jest.restoreAllMocks();
  resetFrameTap();
});

describe('frame tap gating', () => {
  it('does nothing at all with no subscribers', () => {
    expect(frameTapActive()).toBe(false);
    publishFrame(sourceCanvas(1920, 1080), 0);
    expect(contexts).toBe(0);
    expect(draws).toHaveLength(0);
    expect(latestTappedFrame()).toBeNull();
  });

  it('publishes to subscribers and holds the latest frame', () => {
    const seen: TappedFrame[] = [];
    const off = subscribeFrames((f) => seen.push(f));
    expect(frameTapActive()).toBe(true);

    publishFrame(sourceCanvas(640, 360), 1.25);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.time).toBe(1.25);
    expect(latestTappedFrame()).toBe(seen[0]);

    off();
    // The held frame goes with the last subscriber rather than pinning pixels.
    expect(frameTapActive()).toBe(false);
    expect(latestTappedFrame()).toBeNull();
  });

  it('rate-limits to the configured Hz', () => {
    const seen: TappedFrame[] = [];
    subscribeFrames((f) => seen.push(f));
    let clock = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);

    // A 60Hz render loop against the 10Hz default: one in six gets through.
    for (let i = 0; i < 12; i++) {
      publishFrame(sourceCanvas(320, 180), i / 60);
      clock += 1000 / 60;
    }
    expect(DEFAULT_FRAME_TAP_HZ).toBe(10);
    expect(seen).toHaveLength(2);

    // Lift the ceiling well above the loop rate and every tick gets through.
    setFrameTapInterval(1000);
    seen.length = 0;
    for (let i = 0; i < 12; i++) {
      publishFrame(sourceCanvas(320, 180), i / 60);
      clock += 1000 / 60;
    }
    expect(seen).toHaveLength(12);
  });

  it('ignores a missing or empty canvas', () => {
    const seen: TappedFrame[] = [];
    subscribeFrames((f) => seen.push(f));
    publishFrame(null, 0);
    publishFrame(undefined, 0);
    publishFrame(sourceCanvas(0, 0), 0);
    expect(seen).toHaveLength(0);
  });

  it('survives a consumer that throws', () => {
    const seen: TappedFrame[] = [];
    subscribeFrames(() => { throw new Error('boom'); });
    subscribeFrames((f) => seen.push(f));
    expect(() => publishFrame(sourceCanvas(320, 180), 0)).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe('frame tap region', () => {
  it('copies the whole canvas with no region installed', () => {
    subscribeFrames(() => undefined);
    publishFrame(sourceCanvas(640, 360), 0);
    expect(draws[0]).toEqual({ sx: 0, sy: 0, sw: 640, sh: 360, dx: 0, dy: 0, dw: 320, dh: 180 });
  });

  it('crops to the installed region and downsamples to 320 wide', () => {
    subscribeFrames(() => undefined);
    setFrameTapRegion(() => ({ x: 100, y: 50, width: 1280, height: 720 }));
    publishFrame(sourceCanvas(1600, 900), 0);
    expect(draws[0]).toEqual({ sx: 100, sy: 50, sw: 1280, sh: 720, dx: 0, dy: 0, dw: 320, dh: 180 });
  });

  it('clamps a region that runs off the canvas', () => {
    subscribeFrames(() => undefined);
    // Pan the comp so its rect starts left of and above the viewport: the
    // visible part is what a scope can honestly report on.
    setFrameTapRegion(() => ({ x: -200, y: -100, width: 1280, height: 720 }));
    publishFrame(sourceCanvas(400, 300), 0);
    expect(draws[0]?.sx).toBe(0);
    expect(draws[0]?.sy).toBe(0);
    expect(draws[0]?.sw).toBe(400);
    expect(draws[0]?.sh).toBe(300);
  });

  it('does not upscale a region smaller than the copy ceiling', () => {
    subscribeFrames(() => undefined);
    setFrameTapRegion(() => ({ x: 0, y: 0, width: 160, height: 90 }));
    publishFrame(sourceCanvas(640, 360), 0);
    expect(draws[0]?.dw).toBe(160);
    expect(draws[0]?.dh).toBe(90);
  });

  it('survives a region callback that throws', () => {
    const seen: TappedFrame[] = [];
    subscribeFrames((f) => seen.push(f));
    setFrameTapRegion(() => { throw new Error('camera gone'); });
    expect(() => publishFrame(sourceCanvas(640, 360), 0)).not.toThrow();
    expect(seen).toHaveLength(0);
  });
});
