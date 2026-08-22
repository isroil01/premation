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
 * FALLBACK IS PART OF THE DESIGN, not an apology. The exact path speaks
 * WebCodecs + in-memory demux (MP4 via mp4box, WebM via webmDemuxer), so a
 * source goes to a sticky `unavailable` state when any of these hold, and the
 * renderer keeps feeding that source through the legacy element-seek path
 * (`AppTextureProvider.setVideo`):
 *   - `VideoDecoder`/`EncodedVideoChunk` don't exist (old runtime, jsdom),
 *   - the bytes don't demux (unsupported codec, truncated file),
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
import { demuxMp4, type DemuxedVideo } from '@core/video/mp4Demuxer';
import { demuxWebm, isWebmMagic } from '@core/video/webmDemuxer';
import {
  ExactVideoSource,
  SequentialFrameReader,
  webCodecsAvailable,
  type DecodedFrameLike,
} from '@core/video/exactVideoSource';
import { pulldownFrameFor } from '@core/video/pulldownDetect';

/** Frames are captured at source resolution; 512MB is ~65 1080p frames. */
const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;

/** The demuxer holds the whole file in memory (see mp4Demuxer header). A
 *  fetch bigger than this goes straight to the legacy path instead of
 *  doubling a multi-GB file into the JS heap. */
const MAX_DEMUX_BYTES = 1536 * 1024 * 1024; // 1.5 GB — still in-RAM; beyond this use a proxy

/** Decoder errors on real samples are a codec/config problem, not a transient
 *  one — after this many failed decode ops the source stops pretending. */
const MAX_DECODE_FAILURES = 3;

/** Consecutive ascending MISSES before a source flips into streaming mode.
 *  Scrub gestures are not ascending runs; playback and export are. */
const STREAM_AFTER_SEQ = 1;

/** How far past the newest request the stream decodes. ~1/3s at 30fps: deep
 *  enough that playback stays on cache hits, shallow enough that a pause
 *  wastes almost nothing. */
const STREAM_AHEAD = 25;

/** Forward index gap that still counts as playback (not a scrub seek). Kept
 *  independent of STREAM_AHEAD so a deeper decode buffer does not swallow
 *  real seeks. */
const STREAM_PLAY_WINDOW = 45;

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
  /** The demux this source decodes — present ⇒ this source can PLAY through
   *  a sequential streaming reader (see the streaming notes on `get`).
   *  Absent (test stubs), the source is random-access only. */
  demuxed?: DemuxedVideo;
  /** Last presentation index — bounds streaming; prefer over sample count. */
  lastPresIndex?: number;
}

/** The slice of SequentialFrameReader the streaming pump uses — structural,
 *  injectable so jsdom tests can stream without WebCodecs. */
export interface SequentialReaderLike {
  frameAt(presIdx: number): Promise<DecodedFrameLike>;
  close(): void;
}

/** An active playback stream on one source. */
interface StreamState {
  reader: SequentialReaderLike;
  /** Next presentation index the reader will deliver (monotonic). */
  next: number;
  /** Newest index the renderer asked for — the pump stays ahead of it. */
  target: number;
  /** Last index this stream can serve (clip end). */
  end: number;
  pumping: boolean;
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
  /** Streaming-playback support (undefined on sources without a demux). */
  demuxed?: DemuxedVideo;
  /** Last requested plain index + length of the current ascending miss run. */
  lastReq: number;
  seqRun: number;
  /** Last presentation index in the indexed frame table. */
  lastPresIndex?: number;
  stream?: StreamState;
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
    throw new Error(`file too large for in-memory demux (${buf.byteLength} bytes) — generate a proxy`);
  }
  // WebM / Matroska → dedicated demuxer (VP8/VP9). ISO-BMFF → mp4box.
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const demuxed = isWebmMagic(head) ? await demuxWebm(buf) : await demuxMp4(buf);
  const source = new ExactVideoSource(demuxed);
  return {
    source,
    width: demuxed.codedWidth,
    height: demuxed.codedHeight,
    demuxed,
    lastPresIndex: source.frameCount - 1,
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
    /** Injectable so jsdom tests can exercise streaming without WebCodecs. */
    private readonly makeReader: (demuxed: DemuxedVideo, from: number, to: number) => SequentialReaderLike =
      (demuxed, from, to) => new SequentialFrameReader(demuxed, from, to),
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
   *
   * `pulldownPhase` (Interpret Footage ▸ Remove Pulldown) remaps the resolved
   * presentation index through the inverse-telecine mapping
   * (`pulldownFrameFor`): most video frames are served as the whole film frame
   * they carry, and once per 5-frame cycle the film frame that exists only as
   * fields split across two video frames is re-WOVEN from both — full vertical
   * resolution, no comb, every served frame a true progressive film frame.
   * Woven results are cached like decoded frames, under a fractional index no
   * real presentation index can collide with.
   */
  get(src: string, timeSec: number, pulldownPhase?: number): ExactFrameResult {
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
    const prevReq = entry.lastReq;
    const target =
      pulldownPhase !== undefined
        ? pulldownFrameFor(presIdx, pulldownPhase)
        : ({ kind: 'plain', index: presIdx } as const);

    if (target.kind === 'weave') {
      const woven = entry.frames.get(target.index);
      if (woven) {
        this.touch(entry, target.index);
        entry.lastReq = presIdx;
        return { state: 'frame', canvas: woven.canvas, presIndex: target.index, exact: true };
      }
      // Both source frames must be decoded before the weave exists. Request
      // what is missing; each landed decode repaints and this re-runs.
      const top = entry.frames.get(target.top);
      const bottom = entry.frames.get(target.bottom);
      if (top && bottom) {
        const canvas = this.weaveCanvas(top.canvas, bottom.canvas);
        this.store(entry, target.index, canvas, canvas.width * canvas.height * 4);
        return { state: 'frame', canvas, presIndex: target.index, exact: true };
      }
      if (!top) this.requestDecode(src, entry, target.top);
      if (!bottom) this.requestDecode(src, entry, target.bottom);
      return this.nearest(entry, target.index);
    }

    const hit = entry.frames.get(target.index);
    if (hit) {
      this.touch(entry, target.index);
      entry.lastReq = target.index;
      const end = this.lastPresIndex(entry);
      if (this.isLoopWrap(target.index, prevReq, end)) {
        this.startStream(src, entry, target.index);
      } else {
        // Keep an active stream ahead of a playhead that is riding cache hits —
        // hits are the steady state of playback, and a stream that only advanced
        // on misses would stall the moment it caught up.
        this.advanceStream(src, entry, target.index);
      }
      return { state: 'frame', canvas: hit.canvas, presIndex: target.index, exact: true };
    }

    if (!this.noteMiss(src, entry, target.index, prevReq)) {
      this.requestDecode(src, entry, target.index);
    }
    return this.nearest(entry, target.index);
  }

  // ── Streaming playback ───────────────────────────────────────────
  //
  // Random access (`requestDecode` → `frameAt`) decodes a GOP prefix and
  // flushes PER REQUEST — right for scrubbing, hopeless for playback: at
  // 30fps the decode debt grows every frame, the picture freezes while the
  // playhead runs, and catches up when you pause. (That was the reported
  // bug, verbatim.) So when misses arrive as an ascending run — playback and
  // export, never scrub gestures — the source switches to a
  // SequentialFrameReader that decodes each frame ONCE, slightly ahead of
  // the newest request, into the same canvas cache. Steady-state playback
  // is then synchronous cache hits. A backwards or far-forward request is a
  // seek: the stream dies and random access resumes.

  /** Last presentation index for this source. */
  private lastPresIndex(entry: ReadyEntry): number {
    if (entry.lastPresIndex !== undefined) return entry.lastPresIndex;
    if (entry.demuxed) return entry.demuxed.samples.length - 1;
    return 0;
  }

  /** Backward jump from near the end to near the start — comp/footage loop. */
  private isLoopWrap(presIdx: number, lastReq: number, end: number): boolean {
    if (lastReq < 0 || presIdx >= lastReq) return false;
    const window = Math.max(STREAM_AHEAD * 3, 15);
    return presIdx <= window && lastReq >= end - window;
  }

  /** Start (or restart) a decode-ahead stream at `presIdx`. */
  private startStream(src: string, entry: ReadyEntry, presIdx: number): boolean {
    if (!entry.demuxed) return false;
    const end = this.lastPresIndex(entry);
    if (presIdx > end) return false;
    this.killStream(entry);
    entry.stream = {
      reader: this.makeReader(entry.demuxed, presIdx, end),
      next: presIdx,
      target: presIdx,
      end,
      pumping: false,
    };
    entry.lastReq = presIdx;
    entry.seqRun = STREAM_AFTER_SEQ;
    this.pump(src, entry);
    return true;
  }

  /** An active stream absorbs the request when it can. True = absorbed
   *  (do not queue a random-access decode for it). */
  private noteMiss(src: string, entry: ReadyEntry, presIdx: number, prevReq: number): boolean {
    const end = this.lastPresIndex(entry);
    entry.lastReq = presIdx;
    const s = entry.stream;
    if (s) {
      if (presIdx >= s.next && presIdx <= Math.min(s.end, s.next + STREAM_PLAY_WINDOW)) {
        s.target = Math.max(s.target, presIdx);
        this.pump(src, entry);
        return true;
      }
      if (presIdx === s.next - 1) {
        // The frame the stream JUST delivered, evicted under memory pressure.
        // Random access refills it; the stream itself is still on course.
        return false;
      }
      // Loop wrap — restart streaming at the new index instead of falling
      // back to per-frame GOP random access (which cannot keep up at 30fps).
      if (this.isLoopWrap(presIdx, prevReq, end)) {
        return this.startStream(src, entry, presIdx);
      }
      // A seek — forwards past the window or backwards scrub. Kill the stream.
      this.killStream(entry);
      entry.seqRun = 0;
      return false;
    }

    // No active stream — a loop boundary jumps straight into streaming.
    if (this.isLoopWrap(presIdx, prevReq, end)) {
      return this.startStream(src, entry, presIdx);
    }

    if (presIdx === prevReq + 1) entry.seqRun += 1;
    else if (presIdx !== prevReq) entry.seqRun = 0;

    if (entry.seqRun >= STREAM_AFTER_SEQ && entry.demuxed && presIdx < end) {
      return this.startStream(src, entry, presIdx);
    }
    return false;
  }

  /** A cache HIT during streaming still moves the target forward. */
  private advanceStream(src: string, entry: ReadyEntry, presIdx: number): void {
    const s = entry.stream;
    if (!s) return;
    if (presIdx > s.target && presIdx <= Math.min(s.end, s.next + STREAM_PLAY_WINDOW)) {
      s.target = presIdx;
      this.pump(src, entry);
    }
  }

  /** Decode forward until the stream is STREAM_AHEAD past the newest request.
   *  One pump loop per stream; re-entered from get() as the target advances. */
  private pump(src: string, entry: ReadyEntry): void {
    const s = entry.stream;
    if (!s || s.pumping) return;
    s.pumping = true;
    const run = (async () => {
      try {
        for (;;) {
          if (entry.stream !== s || this.sources.get(src) !== entry) return;
          if (s.next > Math.min(s.target + STREAM_AHEAD, s.end)) return;
          const idx = s.next;
          let frame: DecodedFrameLike;
          try {
            frame = await s.reader.frameAt(idx);
          } catch {
            // Reader died (decode error, closed source). Random access takes
            // over on the next get(), with its own failure accounting.
            if (entry.stream === s) this.killStream(entry);
            return;
          }
          if (entry.stream !== s || this.sources.get(src) !== entry) return;
          this.capture(entry, idx, frame);
          s.next = idx + 1;
          // Repaint when the frame the renderer is showing stale pixels for
          // has landed; pure lookahead frames stay silent (no repaint storms).
          if (idx <= s.target) this.notify(src);
        }
      } finally {
        s.pumping = false;
      }
    })();
    this.track(run);
  }

  private killStream(entry: ReadyEntry): void {
    const s = entry.stream;
    if (!s) return;
    delete entry.stream;
    try {
      s.reader.close();
    } catch {
      // already closed
    }
  }

  /** Nearest decoded neighbour while the target is in flight — bounded scan,
   *  the frame map is at most a few dozen entries under the byte budget. */
  private nearest(entry: ReadyEntry, presIdx: number): ExactFrameResult {
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

  /**
   * Re-weave one progressive film frame from two telecined video frames: even
   * rows (the top field) from `top`, odd rows (the bottom field) from
   * `bottom`. Both carry the SAME film frame in those fields — that is what
   * the pulldown mapping guarantees — so the result is a whole frame, not a
   * comb. Degrades to a copy of `top` when 2D contexts are unavailable
   * (jsdom, exhausted contexts): bookkeeping still runs, pixels stay honest
   * to at least one field.
   */
  private weaveCanvas(top: HTMLCanvasElement, bottom: HTMLCanvasElement): HTMLCanvasElement {
    const w = top.width;
    const h = top.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || w < 1 || h < 2) return canvas;
    try {
      ctx.drawImage(top, 0, 0);
      const bctx = bottom.getContext('2d', { willReadFrequently: true });
      if (!bctx) return canvas;
      const img = ctx.getImageData(0, 0, w, h);
      const bh = Math.min(h, bottom.height);
      const bw = Math.min(w, bottom.width);
      const bimg = bctx.getImageData(0, 0, bw, bh);
      const rowBytes = w * 4;
      const bRowBytes = bw * 4;
      for (let y = 1; y < bh; y += 2) {
        img.data.set(bimg.data.subarray(y * bRowBytes, y * bRowBytes + bRowBytes), y * rowBytes);
      }
      ctx.putImageData(img, 0, 0);
    } catch {
      // Tainted/unreadable — the top-field draw already landed, keep it.
    }
    return canvas;
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
            ...(loaded.demuxed ? { demuxed: loaded.demuxed } : {}),
            ...(loaded.lastPresIndex !== undefined ? { lastPresIndex: loaded.lastPresIndex } : {}),
            lastReq: -1,
            seqRun: 0,
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

    this.store(entry, presIdx, canvas, w * h * 4);
  }

  /** LRU insert shared by decoded and woven frames. */
  private store(entry: ReadyEntry, presIdx: number, canvas: HTMLCanvasElement, bytes: number): void {
    if (entry.frames.has(presIdx)) return;
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
    this.killStream(entry);
    entry.source.close();
    this.sources.set(src, { state: 'unavailable', reason });
  }

  /** Drop everything and close every decoder. Backend dispose. */
  clear(): void {
    for (const entry of this.sources.values()) {
      if (entry.state === 'ready') {
        this.killStream(entry);
        entry.source.close();
      }
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
