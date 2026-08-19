/**
 * Decoded video frames, cached per source and source-time.
 *
 * WHY THIS EXISTS: frame blending needs **two** decoded frames at once, and an
 * `HTMLVideoElement` holds exactly one. Both backends kept a single element per
 * source and seeked it at the playhead, so "the frame before" was gone the
 * instant you asked for "the frame after". That is why `frameBlend` sat in the
 * model and the UI for years as a documented no-op — the flag was never the
 * missing part; a second frame was.
 *
 * So: one hidden element per source does nothing but *fill a cache*. It works a
 * queue of requested times, captures each decoded frame to its own canvas on
 * `seeked`, and stores it under the source-time it actually landed on. The
 * renderer then asks for frames **synchronously** — a hit blends, a miss
 * schedules a fill and notifies when it lands. That is the same
 * converge-then-repaint model the existing single-frame video path already
 * relies on (`onseeked` → `AnimationChanged` → re-render), so it introduces no
 * new asynchrony contract; it just remembers what it decoded.
 *
 * Deliberately NOT WebCodecs — CORRECTED 2026-08-19: the subsystem this
 * paragraph said would be needed now EXISTS (`@core/video`: mp4box demux →
 * frame index → `ExactVideoSource`), with the footage preview's frame-by-frame
 * mode as its first consumer. This cache stays on the HTMLVideoElement path
 * ON PURPOSE for now: it feeds the render loop, and swapping the renderer's
 * decode path is gated on the exact path surviving a real-machine visual pass
 * first — approximate-but-proven beats exact-but-unverified in the pixel
 * pipeline. When that pass lands, this cache is the second consumer.
 *
 * FRAME RATE — RESOLVED 2026-07-30; this block used to read "KNOWN LIMIT — we
 * do not know the source's frame rate" and it is kept, corrected, because that
 * text outlived its truth by twelve days and was quoted as current behaviour by
 * a later reader. `bracketFrames` takes `fps` as a PARAMETER; it never assumed
 * the composition's rate, callers did.
 *
 * The caller now supplies the real one: `buildSnapshot` reads
 * `footageSourceOf(node)?.fps ?? fps`, where the source rate comes from
 * `mediaProbe.ts` (desktop + ffprobe) or Interpret Footage ▸ Conform, and the
 * composition rate remains the fallback for the `elementOnly`/`none` probe
 * tiers — the behaviour every pre-existing project already had. In those tiers
 * the original consequences still apply: equal rates are exact Frame Mix, a
 * slower source collapses both brackets onto one decoded frame, a faster source
 * reads slightly softer than AE's.
 *
 * What is still true: nothing in the BROWSER reports a `<video>`'s rate —
 * `requestVideoFrameCallback` never fires for a detached, paused element
 * (measured, paused AND playing). That is why the probe lives in the main
 * process rather than here.
 *
 * Budgeted like `frameCache`: frames are big and a long slow-motion shot would
 * otherwise pin every frame it ever touched.
 */

import { getEventBus } from '@core/events/EventBus';

/** Times within this many seconds are the same frame. Tighter than the 0.05s
 *  deadband the live path uses — that deadband is ~1.5 frames at 30fps and
 *  would reject the sub-frame seeks blending exists to make. */
const TIME_EPSILON = 1e-4;

/** Frames are captured at source resolution; 512MB is ~65 1080p frames. */
const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;

interface CachedFrame {
  canvas: HTMLCanvasElement;
  bytes: number;
  /** The source time this frame actually covers (what the element reported). */
  time: number;
}

interface SourceEntry {
  video: HTMLVideoElement;
  /** key = quantized source time → decoded frame. */
  frames: Map<number, CachedFrame>;
  /** LRU order: keys, oldest first. */
  order: number[];
  bytes: number;
  /** Times queued for decode, in request order. */
  queue: number[];
  /** The time currently being decoded, or null. */
  inflight: number | null;
  ready: boolean;
}

export type VideoFactory = (src: string) => HTMLVideoElement;

function defaultVideoFactory(src: string): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.autoplay = false;
  v.loop = false;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = src;
  return v;
}

/** Quantize a source time to a stable cache key (sub-millisecond). */
function keyOf(time: number): number {
  return Math.round(time / TIME_EPSILON);
}

export class VideoFrameCache {
  private sources = new Map<string, SourceEntry>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly maxBytes = DEFAULT_BUDGET_BYTES,
    private readonly videoFactory: VideoFactory = defaultVideoFactory,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * A decoded frame at `time`, or null if it isn't decoded yet.
   *
   * Never blocks: a miss queues the decode and returns null, and `onChange`
   * fires when it arrives. Callers draw whatever they can and get repainted.
   */
  get(src: string, time: number): HTMLCanvasElement | null {
    const entry = this.ensure(src);
    const hit = entry.frames.get(keyOf(time));
    if (hit) {
      this.touch(entry, keyOf(time));
      return hit.canvas;
    }
    this.request(entry, time);
    return null;
  }

  private ensure(src: string): SourceEntry {
    let entry = this.sources.get(src);
    if (entry) return entry;

    const video = this.videoFactory(src);
    entry = {
      video,
      frames: new Map(),
      order: [],
      bytes: 0,
      queue: [],
      inflight: null,
      ready: false,
    };
    this.sources.set(src, entry);

    const onReady = (): void => {
      if (entry!.ready) return;
      entry!.ready = true;
      this.pump(entry!);
    };
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('seeked', () => this.onSeeked(src, entry!));
    // A factory may hand back an element that is ALREADY loaded — the app has
    // usually been playing this source already. `loadeddata` fired before we
    // subscribed and will never fire again, so waiting for it would leave the
    // cache permanently un-ready and frame blending silently dead.
    if (video.readyState >= 2 /* HAVE_CURRENT_DATA */) onReady();
    return entry;
  }

  private request(entry: SourceEntry, time: number): void {
    const k = keyOf(time);
    if (entry.inflight === k || entry.queue.includes(k)) return;
    entry.queue.push(k);
    this.pump(entry);
  }

  private pump(entry: SourceEntry): void {
    if (!entry.ready || entry.inflight !== null) return;
    const next = entry.queue.shift();
    if (next === undefined) return;
    entry.inflight = next;
    const target = next * TIME_EPSILON;
    // Seek even for a sub-frame delta — that is the whole point.
    entry.video.currentTime = Math.max(0, target);
  }

  private onSeeked(src: string, entry: SourceEntry): void {
    const k = entry.inflight;
    entry.inflight = null;
    if (k !== null) this.capture(entry, k);
    this.pump(entry);
    this.notify();
    // Keep the existing repaint contract: the live path already re-renders on
    // AnimationChanged, so a newly decoded frame reaches the screen the same way.
    getEventBus().emit('AnimationChanged', { nodeId: src });
  }

  private capture(entry: SourceEntry, key: number): void {
    const v = entry.video;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // jsdom has no 2D context; the cache still tracks bookkeeping so its LRU is
    // testable, it just holds an empty canvas.
    if (ctx) ctx.drawImage(v, 0, 0, w, h);

    const bytes = w * h * 4;
    entry.frames.set(key, { canvas, bytes, time: v.currentTime });
    entry.order.push(key);
    entry.bytes += bytes;
    this.evict(entry);
  }

  private touch(entry: SourceEntry, key: number): void {
    const i = entry.order.indexOf(key);
    if (i >= 0) {
      entry.order.splice(i, 1);
      entry.order.push(key);
    }
  }

  private evict(entry: SourceEntry): void {
    while (entry.bytes > this.maxBytes && entry.order.length > 1) {
      const oldest = entry.order.shift();
      if (oldest === undefined) break;
      const f = entry.frames.get(oldest);
      if (f) {
        entry.bytes -= f.bytes;
        entry.frames.delete(oldest);
      }
    }
  }

  /** Drop everything for sources not in `keep` (mirrors AppTextureProvider.retain). */
  retain(keep: ReadonlySet<string>): void {
    for (const [src, entry] of this.sources) {
      if (keep.has(src)) continue;
      entry.video.src = '';
      this.sources.delete(src);
    }
  }

  clear(): void {
    for (const entry of this.sources.values()) entry.video.src = '';
    this.sources.clear();
  }

  /** Frames currently held, for tests and diagnostics. */
  stats(src: string): { frames: number; bytes: number } | null {
    const e = this.sources.get(src);
    return e ? { frames: e.frames.size, bytes: e.bytes } : null;
  }
}

/** The viewport's cache. Export renders construct their own so a long export
 *  cannot evict the frames the viewport is showing. */
export const viewportVideoFrames = new VideoFrameCache();

/**
 * The two frames bracketing `time`, and how far between them it sits.
 *
 * Pure, so the arithmetic that decides *what* to blend is testable without a
 * decoder. `fps` is the grid to bracket on — see the KNOWN LIMIT above: we
 * cannot read the source's real rate, so callers pass the composition's and
 * accept the documented degradation.
 */
export function bracketFrames(
  time: number,
  fps: number,
): { a: number; b: number; weight: number } {
  if (!(fps > 0) || !Number.isFinite(time)) return { a: time, b: time, weight: 0 };
  const exact = time * fps;
  const lo = Math.floor(exact);
  const weight = exact - lo;
  return { a: lo / fps, b: (lo + 1) / fps, weight };
}
