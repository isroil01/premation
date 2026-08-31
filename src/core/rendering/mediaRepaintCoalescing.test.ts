/**
 * The decode → repaint seam, end to end.
 *
 * `repaintScheduler.test.ts` proves the coalescer collapses landings. This
 * proves the two caches actually GO through it — the bug being fixed was one
 * `AnimationChanged` per decoded frame reaching the app's widest event, and a
 * correct coalescer nothing calls fixes nothing.
 */

import { ExactVideoFrameCache, type ExactSourceLike, type LoadedExactSource } from './exactVideoFrames';
import { mediaRepaints, syncFlushScheduler, rafFlushScheduler } from './repaintScheduler';
import { isMediaDecodeRepaint } from './mediaRepaint';
import { setEventBus, EventBus } from '@core/events/EventBus';
import type { DecodedFrameLike } from '@core/video/exactVideoSource';

const FPS = 30;
const FRAMES = 240;

function stubSource() {
  const source: ExactSourceLike = {
    frameIndexAt(timeUs: number): number {
      let idx = 0;
      while (idx + 1 < FRAMES && ((idx + 1) / FPS) * 1e6 <= timeUs) idx += 1;
      return idx;
    },
    frameAt(presIdx: number): Promise<DecodedFrameLike> {
      return Promise.resolve({
        timestamp: Math.round((presIdx / FPS) * 1e6),
        displayWidth: 4,
        displayHeight: 4,
        close: () => undefined,
      } as unknown as DecodedFrameLike);
    },
    close: jest.fn(),
  };
  return { source };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Hand-driven frame boundary, so "one frame" is a thing the test decides. */
function fakeFrames() {
  let queued: (() => void)[] = [];
  return {
    schedule: (flush: () => void): void => { queued.push(flush); },
    tick(): void { const run = queued; queued = []; for (const fn of run) fn(); },
  };
}

describe('landed decodes reach the bus coalesced', () => {
  let bus: EventBus;
  let events: { nodeId?: string; media?: boolean }[];

  beforeEach(() => {
    bus = new EventBus();
    setEventBus(bus);
    events = [];
    bus.on('AnimationChanged', (p) => events.push(p));
    mediaRepaints.reset();
  });

  afterEach(() => {
    mediaRepaints.reset();
    mediaRepaints.setScheduler(rafFlushScheduler);
  });

  it('emits ONE AnimationChanged for a whole burst of landed decodes', async () => {
    const frames = fakeFrames();
    mediaRepaints.setScheduler(frames.schedule);

    const stub = stubSource();
    const cache = new ExactVideoFrameCache(
      1024 * 1024 * 512,
      () => Promise.resolve({ source: stub.source, width: 4, height: 4 } as LoadedExactSource),
      () => true,
    );

    // Load, then scrub across many distinct frames — one decode per ask.
    cache.get('a.mp4', 0);
    await settle();
    for (let i = 0; i < 20; i++) cache.get('a.mp4', (i * 7) / FPS);
    await settle();
    await settle();

    // Every landing happened inside one "frame": nothing on the bus yet.
    expect(events).toEqual([]);
    frames.tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ nodeId: 'a.mp4', media: true });
  });

  it('marks the repaint as media so document listeners can skip it', async () => {
    mediaRepaints.setScheduler(syncFlushScheduler);
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(
      1024 * 1024,
      () => Promise.resolve({ source: stub.source, width: 4, height: 4 } as LoadedExactSource),
      () => true,
    );
    cache.get('a.mp4', 0);
    await settle();

    expect(events.length).toBeGreaterThan(0);
    // The classification is a FACT on the payload, not a guess about the URL:
    // `/files/<key>` and `http://backend/files/<key>` are what the desktop
    // edition actually passes, and neither matches the old id heuristic.
    expect(events.every((e) => isMediaDecodeRepaint(e))).toBe(true);
  });

  it('a PRIVATE instance (export, panes) still emits nothing at all', async () => {
    mediaRepaints.setScheduler(syncFlushScheduler);
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(
      1024 * 1024,
      () => Promise.resolve({ source: stub.source, width: 4, height: 4 } as LoadedExactSource),
      () => true,
      undefined,
      { emitEvents: false },
    );
    cache.get('a.mp4', 0);
    await settle();
    cache.get('a.mp4', 0.5);
    await settle();
    expect(events).toEqual([]);
  });

  it('local onChange listeners stay synchronous — they are not coalesced', async () => {
    const frames = fakeFrames();
    mediaRepaints.setScheduler(frames.schedule);
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(
      1024 * 1024,
      () => Promise.resolve({ source: stub.source, width: 4, height: 4 } as LoadedExactSource),
      () => true,
    );
    let local = 0;
    cache.onChange(() => { local += 1; });
    cache.get('a.mp4', 0);
    await settle();
    // The instance's own consumer hears about it without waiting for a frame.
    expect(local).toBeGreaterThan(0);
    expect(events).toEqual([]);
  });
});

describe('isMediaDecodeRepaint', () => {
  it('trusts the explicit flag over the id shape', () => {
    // The desktop edition's footage src — invisible to the old heuristic.
    expect(isMediaDecodeRepaint({ nodeId: '/files/abc123', media: true })).toBe(true);
    expect(isMediaDecodeRepaint({ nodeId: 'http://127.0.0.1:4000/files/abc' , media: true })).toBe(true);
  });

  it('keeps the legacy id heuristic for emitters that predate the flag', () => {
    expect(isMediaDecodeRepaint({ nodeId: '__texture__' })).toBe(true);
    expect(isMediaDecodeRepaint({ nodeId: 'blob:x' })).toBe(true);
    expect(isMediaDecodeRepaint({ nodeId: 'motion-blob:abc' })).toBe(true);
    expect(isMediaDecodeRepaint('motion-blob:abc')).toBe(true);
  });

  it('still errs toward "this is an edit" when nothing says otherwise', () => {
    expect(isMediaDecodeRepaint({ nodeId: 'node-7' })).toBe(false);
    expect(isMediaDecodeRepaint({})).toBe(false);
    expect(isMediaDecodeRepaint(undefined)).toBe(false);
  });
});
