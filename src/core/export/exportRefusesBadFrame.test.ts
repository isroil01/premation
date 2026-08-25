/**
 * M8b — export refuses a frame the renderer could not honour.
 *
 * This is the half of the M8a split that carries the weight. The preview shows
 * the same notice and keeps the frame, because a human is looking at it. Here
 * the frame is about to be encoded into a file someone ships.
 *
 * The bug being closed (F1): a track matte whose source could not be built used
 * to fall through and draw the layer UNMATTED, with no signal. A layer that
 * should be cut to a shape rendered whole, the export completed, and the file
 * looked finished.
 */

import { renderOffline } from './offlineRenderer';

type Diag = { code: string; detail: string; layerId?: string };

/** Minimal backend stand-in: renderOffline only needs these members. */
function fakeBackend(diagsPerFrame: Diag[][]) {
  let frame = 0;
  return {
    attach() {},
    resize() {},
    setExactMediaTiming() {},
    dispose() {},
    renderFrame() { frame += 1; },
    takeMediaWaits: () => [],
    lastFrameDiagnostics: () => diagsPerFrame[frame - 1] ?? [],
    get framesRendered() { return frame; },
  };
}

jest.mock('@core/rendering/createRenderBackend', () => ({
  createRenderBackend: () => (globalThis as { __fakeBackend?: unknown }).__fakeBackend,
}));

const params = {
  width: 32,
  height: 32,
  fps: 10,
  durationSec: 0.4, // 4 frames
};

describe('export refuses frames the renderer could not honour', () => {
  afterEach(() => {
    delete (globalThis as { __fakeBackend?: unknown }).__fakeBackend;
  });

  it('completes normally when nothing is reported', async () => {
    const be = fakeBackend([[], [], [], []]);
    (globalThis as { __fakeBackend?: unknown }).__fakeBackend = be;
    const frames: number[] = [];
    await expect(
      renderOffline(params as never, async (_c: unknown, i: number) => { frames.push(i); }),
    ).resolves.toBeGreaterThan(0);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('THROWS on the first bad frame, naming the layer and the reason', async () => {
    const be = fakeBackend([
      [],
      [{ code: 'matte-source-unavailable', detail: 'Track matte on "L3" could not be built', layerId: 'L3' }],
      [],
      [],
    ]);
    (globalThis as { __fakeBackend?: unknown }).__fakeBackend = be;
    await expect(
      renderOffline(params as never, async () => {}),
    ).rejects.toThrow(/could not be honoured/i);
  });

  it('does NOT hand the bad frame to the sink — a half-written file is worse than none', async () => {
    const be = fakeBackend([
      [],
      [{ code: 'matte-source-unavailable', detail: 'bad', layerId: 'L1' }],
      [],
      [],
    ]);
    (globalThis as { __fakeBackend?: unknown }).__fakeBackend = be;
    const delivered: number[] = [];
    await expect(
      renderOffline(params as never, async (_c: unknown, i: number) => { delivered.push(i); }),
    ).rejects.toThrow();
    // Frame 0 was clean and delivered; frame 1 was refused before onFrame ran.
    expect(delivered).toEqual([0]);
  });

  it('quotes the layer id, so the failure points at something the user can fix', async () => {
    const be = fakeBackend([[{ code: 'matte-source-unavailable', detail: 'nope', layerId: 'Title' }]]);
    (globalThis as { __fakeBackend?: unknown }).__fakeBackend = be;
    await expect(
      renderOffline(params as never, async () => {}),
    ).rejects.toThrow(/Title/);
  });

  it('refuses when footage is offline (media-unavailable)', async () => {
    const be = fakeBackend([[{
      code: 'media-unavailable',
      detail: 'Media offline on "hero" — relink the footage or remove the layer',
      layerId: 'hero',
    }]]);
    (globalThis as { __fakeBackend?: unknown }).__fakeBackend = be;
    await expect(
      renderOffline(params as never, async () => {}),
    ).rejects.toThrow(/Media offline|could not be honoured/i);
  });

  it('tolerates a backend with no diagnostics support at all', async () => {
    // lastFrameDiagnostics is optional on the interface; a backend without it
    // must not make export throw on every frame.
    const be = fakeBackend([[]]);
    delete (be as { lastFrameDiagnostics?: unknown }).lastFrameDiagnostics;
    (globalThis as { __fakeBackend?: unknown }).__fakeBackend = be;
    await expect(
      renderOffline(params as never, async () => {}),
    ).resolves.toBeGreaterThan(0);
  });
});
