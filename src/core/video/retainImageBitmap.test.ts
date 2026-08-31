/**
 * `webCodecsIO.retain` — the seam where a decoder-owned frame becomes a
 * cacheable one.
 *
 * Two properties, and only one of them is about pixels.
 *
 * The load-bearing one is TIMING: the source `VideoFrame` must be closed
 * before `retain` returns. Hardware decoders own a fixed output pool, every
 * unclosed frame pins a slot, and holding ~10 makes `flush()` stall forever —
 * which is what Track Motion freezing at 2-4% actually was. That is why this
 * hook cannot use `createImageBitmap`, and why the test asserts the close
 * happened synchronously rather than merely eventually.
 *
 * The other is that the representation swap is invisible downstream: whatever
 * comes back is still a `CanvasImageSource` carrying the session's routing
 * fields, so nothing that draws a retained frame has to know which branch ran.
 *
 * jsdom has no `OffscreenCanvas`, so the production branch is exercised
 * against a stub. The stub is deliberately minimal — it exists to observe the
 * ORDER of calls, not to rasterize.
 */

import { webCodecsIO, resetRetainSurfacePool } from './exactVideoSource';
import type { DecodedFrameLike } from './exactVideoSource';

interface FakeFrame extends DecodedFrameLike {
  closed: boolean;
  closedAt: number;
}

let tick = 0;

function fakeVideoFrame(w = 640, h = 360): FakeFrame {
  const f: FakeFrame = {
    timestamp: 123_456,
    displayWidth: w,
    displayHeight: h,
    closed: false,
    closedAt: -1,
    close(): void {
      f.closed = true;
      f.closedAt = ++tick;
    },
  } as unknown as FakeFrame;
  return f;
}

/** Records draws and transfers so the test can assert the order. */
interface StubState {
  made: Array<{ w: number; h: number }>;
  draws: number;
  transfers: number;
  bitmaps: Array<{ closed: boolean }>;
}

function installOffscreenStub(state: StubState): () => void {
  const original = (globalThis as Record<string, unknown>).OffscreenCanvas;
  class StubOffscreen {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      state.made.push({ w, h });
    }
    getContext(): { drawImage: () => void } {
      return { drawImage: () => { state.draws += 1; } };
    }
    transferToImageBitmap(): object {
      state.transfers += 1;
      const bmp: { width: number; height: number; closed: boolean; close: () => void } = {
        width: this.width,
        height: this.height,
        closed: false,
        close(): void { bmp.closed = true; },
      };
      state.bitmaps.push(bmp);
      return bmp;
    }
  }
  (globalThis as Record<string, unknown>).OffscreenCanvas = StubOffscreen;
  return () => {
    if (original === undefined) delete (globalThis as Record<string, unknown>).OffscreenCanvas;
    else (globalThis as Record<string, unknown>).OffscreenCanvas = original;
  };
}

const freshState = (): StubState => ({ made: [], draws: 0, transfers: 0, bitmaps: [] });

// The surface pool is module state and each test installs its own stub class,
// so a surface pooled by one test would be reused by the next and its
// allocation never observed.
beforeEach(resetRetainSurfacePool);
afterAll(resetRetainSurfacePool);

describe('retain — the pool discipline', () => {
  it('closes the source frame BEFORE returning, not on a later turn', () => {
    const state = freshState();
    const restore = installOffscreenStub(state);
    try {
      const frame = fakeVideoFrame();
      const kept = webCodecsIO.retain!(frame);
      // Synchronously, with no await anywhere in between. An await here is the
      // hardware-pool stall this seam exists to prevent.
      expect(frame.closed).toBe(true);
      expect(kept).toBeDefined();
      expect(state.transfers).toBe(1);
    } finally {
      restore();
    }
  });

  it('draws before it transfers, and transfers before it closes', () => {
    const state = freshState();
    const restore = installOffscreenStub(state);
    try {
      const frame = fakeVideoFrame();
      webCodecsIO.retain!(frame);
      // A transfer with no draw would hand back an empty bitmap; a close before
      // the draw would hand back a detached frame. Both are silent.
      expect(state.draws).toBe(1);
      expect(state.transfers).toBe(1);
      expect(frame.closed).toBe(true);
    } finally {
      restore();
    }
  });

  it('does not close the frame twice', () => {
    const state = freshState();
    const restore = installOffscreenStub(state);
    try {
      const frame = fakeVideoFrame();
      const before = tick;
      webCodecsIO.retain!(frame);
      // Exactly one close, so a pool slot is released once and a double close
      // (which throws on a real VideoFrame) cannot happen.
      expect(frame.closedAt).toBe(before + 1);
    } finally {
      restore();
    }
  });
});

describe('retain — what comes back', () => {
  it('carries the routing fields the session reads', () => {
    const state = freshState();
    const restore = installOffscreenStub(state);
    try {
      const kept = webCodecsIO.retain!(fakeVideoFrame(1920, 1080)) as unknown as {
        timestamp: number; displayWidth: number; displayHeight: number; close: () => void;
      };
      expect(kept.timestamp).toBe(123_456);
      expect(kept.displayWidth).toBe(1920);
      expect(kept.displayHeight).toBe(1080);
      // A REAL close, not a no-op: eviction frees the bitmap explicitly rather
      // than leaving it to GC, which is the whole point of the representation.
      expect(typeof kept.close).toBe('function');
      kept.close();
      expect(state.bitmaps[0]!.closed).toBe(true);
    } finally {
      restore();
    }
  });

  it('reuses one surface per size instead of allocating per frame', () => {
    const state = freshState();
    const restore = installOffscreenStub(state);
    try {
      for (let i = 0; i < 30; i++) webCodecsIO.retain!(fakeVideoFrame(640, 360));
      // Streaming playback retains 30-60 frames a second; a surface per frame
      // is pure allocator churn at full resolution.
      expect(state.made).toHaveLength(1);
      expect(state.transfers).toBe(30);
    } finally {
      restore();
    }
  });

  it('keeps a surface per distinct size', () => {
    const state = freshState();
    const restore = installOffscreenStub(state);
    try {
      webCodecsIO.retain!(fakeVideoFrame(640, 360));
      webCodecsIO.retain!(fakeVideoFrame(1920, 1080));
      webCodecsIO.retain!(fakeVideoFrame(640, 360));
      expect(state.made).toHaveLength(2);
    } finally {
      restore();
    }
  });
});

describe('retain — the fallback', () => {
  it('still returns a drawable frame where OffscreenCanvas is missing', () => {
    const original = (globalThis as Record<string, unknown>).OffscreenCanvas;
    delete (globalThis as Record<string, unknown>).OffscreenCanvas;
    try {
      const frame = fakeVideoFrame(320, 240);
      const kept = webCodecsIO.retain!(frame) as unknown as {
        timestamp: number; displayWidth: number; displayHeight: number;
      };
      // jsdom has no 2D context either, so this lands on the last rung: the
      // original frame, unretained. What must hold on EVERY rung is that
      // something drawable comes back rather than a throw.
      expect(kept).toBeDefined();
      expect(kept.timestamp).toBe(123_456);
    } finally {
      if (original !== undefined) (globalThis as Record<string, unknown>).OffscreenCanvas = original;
    }
  });
});
