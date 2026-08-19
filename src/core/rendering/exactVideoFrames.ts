/**
 * Exact decoded video frames for the RENDER PATH, backed by `@core/video`
 * (mp4box demux → frame index → `ExactVideoSource` on WebCodecs).
 *
 * This is the swap `videoFrameCache.ts` spent its header promising: the
 * renderer keeps the exact same synchronous contract it already relies on —
 * `get()` never blocks; a miss queues a decode and `AnimationChanged` repaints
 * when it lands — but a hit is now THE frame (a presentation index resolved
 * through the real sample table), not "wherever a hidden <video> element
 * happened to land after a seek".
 *
 * FALLBACK IS PART OF THE DESIGN, not an apology. The exact path only speaks
 * WebCodecs + in-memory MP4 demux, so a source goes to a sticky `unavailable`
 * state when any of these hold, and the renderer keeps feeding that source
 * through the legacy element-seek path (`AppTextureProvider.setVideo`):
 *   - `VideoDecoder`/`EncodedVideoChunk` don't exist (old runtime, jsdom),
 *   - the bytes don't demux (WebM, MOV-with-non-ISO tracks, truncated file),
 *   - the file is too large for the demuxer's whole-file-in-memory contract,
 *   - the decoder errors repeatedly on real samples (codec unsupported).
 * `unavailable` is per-source and permanent for the session — flapping between
 * exact and approximate frames on the same source would LOOK like a bug.
 *
 * While a decode is in flight the nearest already-decoded frame is returned
 * (marked `exact: false`) rather than nothing: the render loop repaints on
 * every landed decode, and last-GOP pixels for a tick beat a placeholder box.
 * Export never ships an inexact frame — every inflight decode is exposed
 * through `waits()`, which the export convergence loop awaits before
 * accepting a frame (same mechanism as the legacy `takeMediaWaits`).
 *
 * Memory: canvases are LRU-evicted per source under a byte budget, same
 * policy as videoFrameCache. The `ExactVideoSource` underneath additionally
 * holds its own small `VideoFrame` cache (GOP-sized) which it owns and
 * evicts itself — we draw its frames into canvases and NEVER close them.
 */

import { getEventBus } from '@core/events/EventBus';
import { demuxMp4 } from '@core/video/mp4Demuxer';
import {
  ExactVideoSource,
  webCodecsAvailable,
  type DecodedFrameLike,
} from '@core/video/exactVideoSource';

/** Frames are captured at source resolution; 512MB is ~65 1080p frames. */
const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;

/** The demuxer holds the whole file in memory (see mp4Demuxer header). A
 *  fetch bigger than this goes straight to the legacy path instead of
 *  doubling a multi-GB file into the JS heap. */
const MAX_DEMUX_BYTES = 512 * 1024 * 1024;

/** Decoder errors on real samples are a codec/config problem, not a transient
 *  one — after this many failed decode ops the source stops pretending. */
const MAX_DECODE_FAILURES = 3;

/** The slice of ExactVideoSource the cache uses — structural, so tests can
 *  stub a source without a decoder. */
export interface ExactSourceLike {
  frameIndexAt(timeUs: number): number;
  frameAt(presIdx: number): Promise<DecodedFrameLike>;
  close(): void;
}

export interface LoadedExactSource {
  source: ExactSourceLike;
  /** Coded size — the canvas fallback size when a frame doesn't report its
   *  display size. */
  width: number;
  height: number;
}

export type ExactSourceLoader = (src: string) => Promise<LoadedExactSource>;

export type ExactFrameResult =
  /** A decoded frame. `exact` is false when it is the nearest cached
   *  neighbour of a decode still in flight — a repaint will follow. */
  | { state: 'frame'; canvas: HTMLCanvasElement; presIndex: number; exact: boolean }
  /** Demux in progress, or ready with nothing decoded yet. A repaint will
   *  follow; feed the legacy path meanwhile. */
  | { state: 'pending' }
  /** This source will never decode exactly in this session. Legacy path. */
  | { state: 'unavailable' };

interface CachedCanvas {
  canvas: HTMLCanvasElement;
  bytes: number;
}

interface ReadyEntry {
  state: 'ready';
  source: ExactSourceLike;
  width: number;
  height: number;
  /** presentation index → decoded canvas */
  frames: Map<number, CachedCanvas>;
  /** LRU order: presentation indices, oldest first. */
  order: number[];
  bytes: number;
  /** Presentation indices with a decode in flight. */
  pending: Set<number>;
  failures: number;
}

type Entry =
  | { state: 'loading' }
  | ReadyEntry
  | { state: 'unavailable'; reason: string };

async function defaultLoader(src: string): Promise<LoadedExactSource> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_DEMUX_BYTES) {
    throw new Error(`file too large for in-memory demux (${buf.byteLength} bytes)`);
  }
  const demuxed = await demuxMp4(buf);
  return {
    source: new ExactVideoSource(demuxed),
    width: demuxed.codedWidth,
    height: demuxed.codedHeight,
  };
}

export class ExactVideoFrameCache {
  private readonly sources = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  /** Inflight loads + decodes. Each promise removes ITSELF on settle, so the
   *  list only ever holds live work — nothing drains it, nothing leaks. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly maxBytesPerSource = DEFAULT_BUDGET_BYTES,
    private readonly loader: ExactSourceLoader = defaultLoader,
    private readonly capable: () => boolean = webCodecsAvailable,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(src: string): void {
    for (const fn of this.listeners) fn();
    // Same repaint contract as the legacy cache: the render loop already
    // re-renders on AnimationChanged, so a landed decode reaches the screen
    // without a new asynchrony mechanism.
    getEventBus().emit('AnimationChanged', { nodeId: src });
  }

  /**
   * The exact frame covering `timeSec`, without blocking.
   *
   * `frame` may be inexact (nearest neighbour) while the real decode is in
   * flight; `pending` while the source is still demuxing; `unavailable` when
   * this source can never decode exactly — callers then use the legacy path.
   */
  get(src: string, timeSec: number): ExactFrameResult {
    const entry = this.ensure(src);
    if (entry.state === 'unavailable') return { state: 'unavailable' };
    if (entry.state === 'loading') return { state: 'pending' };

    // +1µs: frame boundaries in the index are FRACTIONAL microseconds
    // (cts/timescale × 1e6 — e.g. 33333.33µs for frame 1 at 30fps), while the
    // rounded query is an integer. Without the bias, t = 1/30 rounds to
    // 33333µs, lands "at-or-before" 33333.33, and resolves the PREVIOUS
    // frame — off by one on every exact frame boundary, which is exactly
    // where the timeline puts the playhead. One microsecond is three orders
    // of magnitude under any real frame duration, so mid-frame times are
    // unaffected.
    const presIdx = entry.source.frameIndexAt(Math.max(0, Math.round(timeSec * 1e6) + 1));
    const hit = entry.frames.get(presIdx);
    if (hit) {
      this.touch(entry, presIdx);
      return { state: 'frame', canvas: hit.canvas, presIndex: presIdx, exact: true };
    }

    this.requestDecode(src, entry, presIdx);

    // Nearest decoded neighbour while the target is in flight — bounded scan,
    // the frame map is at most a few dozen entries under the byte budget.
    let bestIdx = -1;
    let bestDist = Infinity;
    for (const idx of entry.frames.keys()) {
      const d = Math.abs(idx - presIdx);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0) {
      const near = entry.frames.get(bestIdx)!;
      return { state: 'frame', canvas: near.canvas, presIndex: bestIdx, exact: false };
    }
    return { state: 'pending' };
  }

  /** True once `src` has settled to the sticky legacy-only state. */
  unavailable(src: string): boolean {
    return this.sources.get(src)?.state === 'unavailable';
  }

  /**
   * Every load/decode currently in flight. The export convergence loop awaits
   * these (merged into `takeMediaWaits`) and re-renders, so an exported frame
   * is never the `exact: false` neighbour.
   */
  waits(): Promise<void>[] {
    return [...this.inflight];
  }

  private track(p: Promise<void>): void {
    // Failures are handled where they mean something (markUnavailable /
    // failure counting) — as a WAIT the settled promise must never reject,
    // or one bad decode would abort a whole export.
    const wait = p.catch(() => undefined).then(() => {
      this.inflight.delete(wait);
    });
    this.inflight.add(wait);
  }

  private ensure(src: string): Entry {
    let entry = this.sources.get(src);
    if (entry) return entry;

    if (!this.capable()) {
      entry = { state: 'unavailable', reason: 'WebCodecs unavailable' };
      this.sources.set(src, entry);
      return entry;
    }

    entry = { state: 'loading' };
    this.sources.set(src, entry);
    this.track(
      this.loader(src).then(
        (loaded) => {
          // The entry may have been cleared while loading; a late source must
          // not resurrect it (and must not leak its decoder).
          if (this.sources.get(src)?.state !== 'loading') {
            loaded.source.close();
            return;
          }
          this.sources.set(src, {
            state: 'ready',
            source: loaded.source,
            width: loaded.width,
            height: loaded.height,
            frames: new Map(),
            order: [],
            bytes: 0,
            pending: new Set(),
            failures: 0,
          });
          this.notify(src);
        },
        (err) => {
          if (this.sources.get(src)?.state !== 'loading') return;
          this.sources.set(src, {
            state: 'unavailable',
            reason: err instanceof Error ? err.message : String(err),
          });
          this.notify(src);
        },
      ),
    );
    return entry;
  }

  private requestDecode(src: string, entry: ReadyEntry, presIdx: number): void {
    if (entry.pending.has(presIdx)) return;
    entry.pending.add(presIdx);
    this.track(
      entry.source.frameAt(presIdx).then(
        (frame) => {
          entry.pending.delete(presIdx);
          if (this.sources.get(src) !== entry) return; // cleared/replaced meanwhile
          this.capture(entry, presIdx, frame);
          entry.failures = 0;
          this.notify(src);
        },
        () => {
          entry.pending.delete(presIdx);
          if (this.sources.get(src) !== entry) return;
          entry.failures += 1;
          if (entry.failures >= MAX_DECODE_FAILURES) {
            this.markUnavailable(src, entry, 'decoder failed repeatedly');
          }
          // Repaint either way: the renderer re-asks and either retries or
          // settles onto the legacy path.
          this.notify(src);
        },
      ),
    );
  }

  private capture(entry: ReadyEntry, presIdx: number, frame: DecodedFrameLike): void {
    if (entry.frames.has(presIdx)) return;
    // A real VideoFrame reports its display size (PAR-corrected); the coded
    // size from the demux is the fallback so a stub or odd frame still lands.
    const f = frame as unknown as { displayWidth?: number; displayHeight?: number };
    const w = f.displayWidth || entry.width;
    const h = f.displayHeight || entry.height;
    if (!w || !h) return;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // jsdom has no 2D context; bookkeeping still runs so the LRU is testable.
    // Cache owns the frame — draw, never close (see ExactVideoSource header).
    if (ctx) ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);

    const bytes = w * h * 4;
    entry.frames.set(presIdx, { canvas, bytes });
    entry.order.push(presIdx);
    entry.bytes += bytes;
    while (entry.bytes > this.maxBytesPerSource && entry.order.length > 1) {
      const oldest = entry.order.shift();
      if (oldest === undefined) break;
      const old = entry.frames.get(oldest);
      if (old) {
        entry.bytes -= old.bytes;
        entry.frames.delete(oldest);
      }
    }
  }

  private touch(entry: ReadyEntry, presIdx: number): void {
    const i = entry.order.indexOf(presIdx);
    if (i >= 0) {
      entry.order.splice(i, 1);
      entry.order.push(presIdx);
    }
  }

  private markUnavailable(src: string, entry: ReadyEntry, reason: string): void {
    entry.source.close();
    this.sources.set(src, { state: 'unavailable', reason });
  }

  /** Drop everything and close every decoder. Backend dispose. */
  clear(): void {
    for (const entry of this.sources.values()) {
      if (entry.state === 'ready') entry.source.close();
    }
    this.sources.clear();
  }

  /** For tests and diagnostics. */
  stats(src: string): { state: string; frames: number; bytes: number } | null {
    const e = this.sources.get(src);
    if (!e) return null;
    if (e.state !== 'ready') return { state: e.state, frames: 0, bytes: 0 };
    return { state: e.state, frames: e.frames.size, bytes: e.bytes };
  }
}

/** The renderer's cache — shared by viewport and export, which use the same
 *  backend instance (see MotionRendererBackend). */
export const exactVideoFrames = new ExactVideoFrameCache();
