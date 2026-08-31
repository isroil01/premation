/**
 * Exact random access to a video's frames: the decoder session over a demuxed
 * MP4. Ask for presentation frame N, get the decoded frame for exactly N —
 * not "wherever the element landed after seeking", which is the contract the
 * HTMLVideoElement path (videoFrameCache.ts) could never make.
 *
 * ── The seek shape ───────────────────────────────────────────────────────────
 *
 * Every request decodes one GOP prefix: configure once, feed samples in decode
 * order from the GOP's keyframe through the target's feed-through index (both
 * from frameIndex.ts), then `flush()`. Flush is doing two jobs there. It
 * forces the decoder to emit everything buffered — without it a conservative
 * decoder holds the target frame hostage waiting for input that never comes —
 * and it resets the decoder to needing a key chunk next, which is exactly what
 * the next random access will feed. Random access and flush-per-request are
 * the same design, not a coincidence.
 *
 * That makes a naive step-forward quadratic in GOP length (frame k re-decodes
 * k+1 samples), which is why every frame the flush emits is CACHED, not just
 * the target: decoding frame 7 of a GOP yields frames 0–7, so stepping
 * forward hits the cache built by the previous step. The cache owns its
 * frames — callers draw them and must NOT close them; eviction and `close()`
 * do.
 *
 * ── Why the decoder is injected ──────────────────────────────────────────────
 *
 * jsdom has no WebCodecs, and this machine's automation pane cannot composite
 * — so `VideoDecoder` itself is unreachable from any test that runs here. The
 * session therefore talks to a `DecoderIO` seam (same move FrameBlobStore made
 * for IndexedDB): tests pin the ENTIRE feeding discipline — key-first, decode
 * order, right range, flush, cache, eviction, error paths — against a fake,
 * and the default IO is a thin adapter over the real WebCodecs globals with
 * nothing in it worth testing. Byte-level decode correctness needs a real
 * Chromium; everything decidable above the codec is decided here.
 */

import { buildFrameIndex, frameAtTime, type VideoFrameIndex } from './frameIndex';
import type { DemuxedVideo } from './mp4Demuxer';

/** What the session needs from a decoded frame. The real object is a
 *  `VideoFrame` (drawable via drawImage and carrying displayWidth/Height);
 *  the session itself only routes by timestamp and manages lifetime. */
export interface DecodedFrameLike {
  /** Presentation time, µs — round-trips the chunk timestamp we fed. */
  readonly timestamp: number | null;
  close(): void;
}

export interface EncodedChunkInit {
  type: 'key' | 'delta';
  /** Presentation time µs of the frame this sample displays as. */
  timestamp: number;
  durationUs: number;
  data: Uint8Array;
}

export interface VideoDecoderLike {
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
}

export interface DecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
  /**
   * WebCodecs acceleration preference. Playback/scrub keep the default
   * (hardware when available — lowest decode latency). The TRACKER asks for
   * 'prefer-software': its per-frame `copyTo` readback of a hardware 4K
   * frame costs ~60ms of GPU sync, while a software frame is already in CPU
   * memory and copies in ~2ms — the decode itself is slower but the total
   * is ~3× faster, with spec-identical pixels.
   */
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
}

/** The injectable seam between the session and WebCodecs. */
export interface DecoderIO {
  createDecoder(
    config: DecoderConfig,
    handlers: { output: (frame: DecodedFrameLike) => void; error: (e: Error) => void },
  ): VideoDecoderLike;
  createChunk(init: EncodedChunkInit): unknown;
  /**
   * Convert a decoder-owned frame into a CACHEABLE one, closing the original.
   *
   * Hardware decoders own a fixed pool of output buffers, and every unclosed
   * `VideoFrame` pins one. Hold ~10 and the decoder's `flush()` stalls FOREVER
   * — which surfaced as Track Motion "freezing at 2–4%" and would hang exact
   * scrubbing the same way. So the session never caches raw VideoFrames.
   *
   * SYNCHRONOUS, and that is the load-bearing half of the contract. This runs
   * inside the decoder's `output` callback and the original frame must be
   * closed before control leaves it — an `await` anywhere between output and
   * `close()` is exactly the pool stall above. That rules out
   * `createImageBitmap`, which is async; see the production adapter for the
   * synchronous route it takes instead.
   *
   * The jsdom tests omit this hook entirely (identity), as fake frames have no
   * pool to exhaust.
   */
  retain?: (frame: DecodedFrameLike) => DecodedFrameLike;
}

/** True when the platform can run the exact path at all. */
export function webCodecsAvailable(): boolean {
  const g = globalThis as { VideoDecoder?: unknown; EncodedVideoChunk?: unknown };
  return typeof g.VideoDecoder === 'function' && typeof g.EncodedVideoChunk === 'function';
}

/** The production adapter: deliberately nothing but plumbing. */
export const webCodecsIO: DecoderIO = {
  createDecoder(config, handlers) {
    type Ctor = new (init: {
      output: (frame: DecodedFrameLike) => void;
      error: (e: Error) => void;
    }) => VideoDecoderLike & { configure(c: object): void };
    const g = globalThis as unknown as { VideoDecoder: Ctor };
    const decoder = new g.VideoDecoder({ output: handlers.output, error: handlers.error });
    decoder.configure({
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      ...(config.description ? { description: config.description } : {}),
      ...(config.hardwareAcceleration ? { hardwareAcceleration: config.hardwareAcceleration } : {}),
    });
    return decoder;
  },
  createChunk(init) {
    type Ctor = new (i: object) => unknown;
    const g = globalThis as unknown as { EncodedVideoChunk: Ctor };
    return new g.EncodedVideoChunk({
      type: init.type,
      timestamp: init.timestamp,
      duration: init.durationUs,
      data: init.data,
    });
  },
  retain(frame) {
    const f = frame as unknown as { displayWidth?: number; displayHeight?: number; codedWidth?: number; codedHeight?: number };
    const w = f.displayWidth || f.codedWidth || 2;
    const h = f.displayHeight || f.codedHeight || 2;
    const timestamp = frame.timestamp;

    // ── The synchronous ImageBitmap route ──────────────────────
    //
    // Draw into a pooled OffscreenCanvas, then `transferToImageBitmap()` —
    // synchronous, and it hands back a CLOSEABLE, TRANSFERABLE bitmap. That
    // matters twice. Holding one 2D canvas per cached frame put the cache
    // against Chromium's accelerated-canvas budget, whose response to pressure
    // is to discard backing stores or drop to software raster SILENTLY, which
    // is what "quality degrades gradually across a long session" looks like
    // from the outside. And a transferable frame is what decoding in a worker
    // would need to hand back.
    //
    // `createImageBitmap` would be the obvious call and cannot be used here:
    // it is async, and an await between the decoder's `output` and
    // `frame.close()` pins a hardware pool slot — the stall this seam exists
    // to avoid, and the one that surfaced as Track Motion freezing at 2–4%.
    //
    // ALPHA IS A NON-ISSUE ON THIS PATH, written down because the two upload
    // routes treat premultiply differently: a 2D canvas is converted at upload,
    // while an ImageBitmap carries its own state and WebGL2's unpack flag is
    // ignored for it. The `drawImage` below is unchanged, so the bitmap
    // inherits the canvas's premultiplied backing store either way — and
    // nothing arriving here has alpha at all. The exact loader REFUSES alpha
    // WebM outright (see `defaultLoader` in exactVideoFrames.ts: "alpha WebM —
    // element path preserves transparency"), so every frame retained here is
    // opaque and premultiply is the identity.
    //
    // `transferToImageBitmap` transfers the backing store and leaves the canvas
    // blank at the same size, so the pool hands back clean surfaces with no
    // clear of its own.
    const off = offscreenFor(w, h);
    if (off) {
      const ctx = off.getContext('2d');
      if (ctx) {
        ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
        const bitmap = off.transferToImageBitmap();
        frame.close();
        // The bitmap IS the frame: a CanvasImageSource with a real `close()` on
        // its prototype — so eviction frees it explicitly instead of leaving it
        // to GC — plus the session's routing fields.
        return Object.assign(bitmap, {
          timestamp,
          displayWidth: w,
          displayHeight: h,
        }) as unknown as DecodedFrameLike;
      }
    }

    // No OffscreenCanvas (older runtime, jsdom): the original canvas route,
    // which is correct and merely holds more GPU-backed surfaces.
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // No 2D context (headless edge case): better a pool-pinned frame than
      // no frame at all — the old behaviour, with its old risk.
      return frame;
    }
    ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h);
    frame.close();
    return Object.assign(canvas, {
      timestamp,
      displayWidth: w,
      displayHeight: h,
      close(): void { /* plain memory — GC handles it */ },
    }) as unknown as DecodedFrameLike;
  },
};

/**
 * Pooled draw surfaces for {@link webCodecsIO}.retain.
 *
 * `transferToImageBitmap` empties the canvas without resizing it, so a surface
 * is reusable the instant its bitmap has been taken. Pooling matters because
 * streaming playback retains 30–60 frames a second, and allocating a full-res
 * OffscreenCanvas per frame is pure allocator churn — the same reasoning as the
 * canvas pool in `exactVideoFrames`, and the same small ceiling: a handful of
 * distinct frame sizes is all any project has on screen at once.
 */
const offscreenPool: OffscreenCanvas[] = [];
const OFFSCREEN_POOL_MAX = 4;

/** Drop the pooled surfaces. Tests only — production has one implementation
 *  of `OffscreenCanvas` and never needs to forget it. */
export function resetRetainSurfacePool(): void {
  offscreenPool.length = 0;
}

function offscreenFor(w: number, h: number): OffscreenCanvas | null {
  if (typeof OffscreenCanvas !== 'function') return null;
  for (const c of offscreenPool) {
    if (c.width === w && c.height === h) return c;
  }
  let c: OffscreenCanvas;
  try {
    c = new OffscreenCanvas(w, h);
  } catch {
    return null;
  }
  // `transferToImageBitmap` is what makes the synchronous route possible; a
  // runtime with OffscreenCanvas but without it falls back to the canvas.
  if (typeof c.transferToImageBitmap !== 'function') return null;
  if (offscreenPool.length >= OFFSCREEN_POOL_MAX) offscreenPool.shift();
  offscreenPool.push(c);
  return c;
}

/** Frames a single flush can strand in cache beyond the configured budget:
 *  the budget must never evict frames of the GOP being decoded RIGHT NOW, or
 *  a long GOP would evict its own target before frameAt returns it. */
const MIN_CACHE = 4;

/** The timestamp-routing tables both session classes need, built once per
 *  demux. A SequentialFrameReader used to rebuild the whole index — an
 *  O(n log n) sort over every sample — on EVERY construction, i.e. every
 *  loop wrap of every playing clip, although ExactVideoSource had already
 *  built the identical structure. Keyed weakly so a dropped demux frees it. */
interface DemuxRouting {
  index: VideoFrameIndex;
  /** decode index → presentation time µs (the chunk timestamp to feed). */
  timeUsOfDecodeIndex: number[];
  /** presentation time µs → presentation index (output frame routing). */
  presIndexByTimeUs: Map<number, number>;
}

const routingCache = new WeakMap<DemuxedVideo, DemuxRouting>();

function routingFor(demuxed: DemuxedVideo): DemuxRouting {
  let r = routingCache.get(demuxed);
  if (!r) {
    const index = buildFrameIndex(demuxed.samples, demuxed.timescale);
    const timeUsOfDecodeIndex = new Array<number>(demuxed.samples.length).fill(0);
    const presIndexByTimeUs = new Map<number, number>();
    index.frames.forEach((f, presIdx) => {
      timeUsOfDecodeIndex[f.decodeIndex] = f.timeUs;
      presIndexByTimeUs.set(f.timeUs, presIdx);
    });
    r = { index, timeUsOfDecodeIndex, presIndexByTimeUs };
    routingCache.set(demuxed, r);
  }
  return r;
}

export class ExactVideoSource {
  readonly index: VideoFrameIndex;
  private readonly timeUsOfDecodeIndex: number[];
  private readonly presIndexByTimeUs: Map<number, number>;
  private cache = new Map<number, DecodedFrameLike>();
  private lru: number[] = [];
  private decoder: VideoDecoderLike | null = null;
  private failure: Error | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  private currentTarget = -1;

  constructor(
    private readonly demuxed: DemuxedVideo,
    private readonly io: DecoderIO = webCodecsIO,
    // Cached frames are COPIES in production (an ImageBitmap; see
    // DecoderIO.retain), so the budget is plain memory, not decoder pool slots
    // — but at 1080p each copy is ~8MB, so the budget stays small. The
    // byte-budgeted tier above (exactVideoFrames) is the real cache; this one
    // only smooths stepping.
    private readonly maxCached = 12,
  ) {
    const routing = routingFor(demuxed);
    this.index = routing.index;
    this.timeUsOfDecodeIndex = routing.timeUsOfDecodeIndex;
    this.presIndexByTimeUs = routing.presIndexByTimeUs;
  }

  get frameCount(): number {
    return this.index.frames.length;
  }

  get durationUs(): number {
    return this.index.durationUs;
  }

  timeUsOf(presIdx: number): number {
    return this.index.frames[this.clamp(presIdx)]?.timeUs ?? 0;
  }

  frameIndexAt(timeUs: number): number {
    return frameAtTime(this.index, timeUs);
  }

  /**
   * The decoded frame for presentation index `presIdx` (clamped to the clip).
   * The returned frame is owned by this source's cache: draw it, don't close
   * it. Requests are serialized — a decoder is one machine, not a pool.
   */
  frameAt(presIdx: number): Promise<DecodedFrameLike> {
    const target = this.clamp(presIdx);
    const run = this.chain.then(() => this.decodeOp(target));
    // The stored chain absorbs the rejection so one failed seek does not
    // poison every later one; the caller still gets the real rejection.
    this.chain = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
    try {
      this.decoder?.close();
    } catch {
      // A decoder that errored is already closed; closing twice throws.
    }
    this.decoder = null;
    for (const f of this.cache.values()) f.close();
    this.cache.clear();
    this.lru = [];
  }

  private clamp(i: number): number {
    return Math.max(0, Math.min(this.frameCount - 1, Math.floor(i)));
  }

  private async decodeOp(target: number): Promise<DecodedFrameLike> {
    if (this.closed) throw new Error('ExactVideoSource is closed');
    if (this.frameCount === 0) throw new Error('no frames in source');
    const hit = this.cache.get(target);
    if (hit) {
      this.touch(target);
      return hit;
    }

    const entry = this.index.frames[target]!;
    this.failure = null;
    // onOutput's retain window is anchored on the frame being sought.
    this.currentTarget = target;
    if (!this.decoder) {
      this.decoder = this.io.createDecoder(
        {
          codec: this.demuxed.codec,
          codedWidth: this.demuxed.codedWidth,
          codedHeight: this.demuxed.codedHeight,
          ...(this.demuxed.description ? { description: this.demuxed.description } : {}),
        },
        {
          output: (frame) => this.onOutput(frame),
          error: (e) => {
            this.failure = e;
          },
        },
      );
    }

    try {
      for (let d = entry.keyDecodeIndex; d <= entry.feedThroughDecodeIndex; d++) {
        const s = this.demuxed.samples[d]!;
        this.decoder.decode(
          this.io.createChunk({
            type: s.isKey ? 'key' : 'delta',
            timestamp: this.timeUsOfDecodeIndex[d]!,
            durationUs: Math.round((s.duration * 1e6) / this.demuxed.timescale),
            data: s.data,
          }),
        );
      }
      await this.decoder.flush();
    } catch (e) {
      this.failure = this.failure ?? (e instanceof Error ? e : new Error(String(e)));
    }

    if (this.failure) {
      // An errored decoder is dead; the next request builds a fresh one.
      try {
        this.decoder?.close();
      } catch {
        // Already closed by the error itself.
      }
      this.decoder = null;
      throw this.failure;
    }

    this.evictOver(target);
    const frame = this.cache.get(target);
    if (!frame) {
      // The feed range was right and the decoder still didn't produce the
      // frame — surface it; a silent nearest-neighbour here would rebuild the
      // exact imprecision this subsystem exists to remove.
      throw new Error(`decoder produced no frame for #${target}`);
    }
    this.touch(target);
    return frame;
  }

  private onOutput(frame: DecodedFrameLike): void {
    const presIdx = frame.timestamp === null ? undefined : this.presIndexByTimeUs.get(frame.timestamp);
    if (presIdx === undefined) {
      frame.close();
      return;
    }
    // Close frames outside the retain window IMMEDIATELY — before flush
    // resolves. A long GOP prefix otherwise accumulates dozens of open
    // decoder-owned frames mid-flush, exhausts the hardware output pool, and
    // the flush never returns (the Track Motion freeze). Eviction after the
    // fact cannot fix that; the frames must never pile up in the first place.
    const budget = Math.max(MIN_CACHE, this.maxCached);
    if (this.currentTarget >= 0 && presIdx <= this.currentTarget - budget) {
      frame.close();
      return;
    }
    const kept = this.io.retain ? this.io.retain(frame) : frame;
    const prior = this.cache.get(presIdx);
    if (prior) prior.close();
    this.cache.set(presIdx, kept);
    this.touch(presIdx);
  }

  private touch(presIdx: number): void {
    const i = this.lru.indexOf(presIdx);
    if (i >= 0) this.lru.splice(i, 1);
    this.lru.push(presIdx);
  }

  private evictOver(protect: number): void {
    const budget = Math.max(MIN_CACHE, this.maxCached);
    while (this.lru.length > budget) {
      const victimAt = this.lru[0] === protect ? 1 : 0;
      const victim = this.lru[victimAt];
      if (victim === undefined) break;
      this.lru.splice(victimAt, 1);
      const f = this.cache.get(victim);
      if (f) {
        f.close();
        this.cache.delete(victim);
      }
    }
  }
}

// ── Sequential streaming reader ──────────────────────────────────────
//
// `frameAt` is RANDOM access: every request decodes its GOP prefix and
// flushes. A tracking walk calling it per frame therefore re-decodes an
// ever-longer prefix each step — quadratic in GOP length, which turned Track
// Motion on real footage (GOPs of 100–300 frames) into a crawl even before
// the pool hang. A sequential consumer needs the opposite shape: feed the
// stream ONCE, receive frames in presentation order, copy, close, next.

/** Fed-but-not-yet-output cap. Must comfortably exceed the codec's reorder
 *  depth (B-pyramids can run past 8) or feeding would stall waiting for
 *  output that needs more input. These are COMPRESSED chunks in flight, not
 *  open frames, so generous is cheap. */
const WALK_FEED_AHEAD = 24;
/** Decoded-and-queued frames waiting for the consumer. Each is an open
 *  decoder-pool frame, so this stays well under the ~10-slot hardware pools. */
const WALK_QUEUE_MAX = 4;

/**
 * Decode presentation frames `from..to` (inclusive, forward only) exactly
 * once each, in order.
 *
 * Contract: requests via {@link SequentialFrameReader.frameAt} must be
 * NON-DECREASING; the returned frame is valid only until the next call
 * (the reader closes it then). Copy what you need, immediately.
 */
export class SequentialFrameReader {
  private readonly index: VideoFrameIndex;
  private readonly presIndexByTimeUs: Map<number, number>;
  private readonly timeUsOfDecodeIndex: number[];
  private readonly from: number;
  private readonly to: number;
  private readonly feedEnd: number;
  private decoder: VideoDecoderLike | null = null;
  private d: number; // next decode index to feed
  private fed = 0;
  private outputs = 0;
  private flushCalled = false;
  private flushDone = false;
  private failure: Error | null = null;
  private queue: Array<{ presIndex: number; frame: DecodedFrameLike }> = [];
  private current: { presIndex: number; frame: DecodedFrameLike } | null = null;
  private notify: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly demuxed: DemuxedVideo,
    from: number,
    to: number,
    private readonly io: DecoderIO = webCodecsIO,
    private readonly opts: { hardwareAcceleration?: DecoderConfig['hardwareAcceleration'] } = {},
  ) {
    const routing = routingFor(demuxed);
    this.index = routing.index;
    this.timeUsOfDecodeIndex = routing.timeUsOfDecodeIndex;
    this.presIndexByTimeUs = routing.presIndexByTimeUs;
    const last = this.index.frames.length - 1;
    this.from = Math.max(0, Math.min(last, Math.floor(from)));
    this.to = Math.max(this.from, Math.min(last, Math.floor(to)));
    this.d = this.index.frames[this.from]!.keyDecodeIndex;
    this.feedEnd = this.index.frames[this.to]!.feedThroughDecodeIndex;
  }

  /**
   * The frame for `presIdx` (clamped to [from..to]). Repeating the previous
   * index returns the same frame (freeze frames / slow stretches re-read
   * source frames); indices between the previous request and this one are
   * decoded and discarded (comp walks may skip source frames).
   */
  async frameAt(presIdx: number): Promise<DecodedFrameLike> {
    if (this.closed) throw new Error('SequentialFrameReader is closed');
    const target = Math.max(this.from, Math.min(this.to, Math.floor(presIdx)));
    if (this.current && this.current.presIndex === target) return this.current.frame;
    if (this.current && target < this.current.presIndex) {
      throw new Error('SequentialFrameReader requests must be non-decreasing');
    }
    for (;;) {
      if (this.closed) throw new Error('SequentialFrameReader is closed');
      this.pump();
      const item = this.queue.shift();
      if (item) {
        if (item.presIndex < target) {
          item.frame.close(); // skipped by the comp walk — decoded, unwanted
          continue;
        }
        this.current?.frame.close();
        this.current = item;
        return item.frame;
      }
      if (this.failure) throw this.failure;
      if (this.flushDone) throw new Error(`decode stream ended before frame #${target}`);
      await new Promise<void>((res) => { this.notify = res; });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.current?.frame.close();
    this.current = null;
    for (const q of this.queue) q.frame.close();
    this.queue = [];
    try {
      this.decoder?.close();
    } catch {
      // errored decoders are already closed
    }
    this.decoder = null;
    // Release a frameAt() parked on `notify` — without this, a caller awaiting
    // the next frame when the reader is killed (every loop wrap and every
    // seek kills the active stream) waits FOREVER: pump() early-returns on
    // `closed`, so no output/flush/error can ever wake it again. The leaked
    // promise then sits in ExactVideoFrameCache.inflight, and the export
    // convergence loop awaits it without a timeout — one prior loop or scrub
    // deadlocked every later export.
    this.wake();
  }

  private wake(): void {
    const n = this.notify;
    this.notify = null;
    n?.();
  }

  private pump(): void {
    if (this.failure || this.closed) return;
    if (!this.decoder) {
      this.decoder = this.io.createDecoder(
        {
          codec: this.demuxed.codec,
          codedWidth: this.demuxed.codedWidth,
          codedHeight: this.demuxed.codedHeight,
          ...(this.demuxed.description ? { description: this.demuxed.description } : {}),
          ...(this.opts.hardwareAcceleration
            ? { hardwareAcceleration: this.opts.hardwareAcceleration }
            : {}),
        },
        {
          output: (frame) => this.onOutput(frame),
          error: (e) => {
            this.failure = e;
            this.wake();
          },
        },
      );
    }
    while (
      this.d <= this.feedEnd
      && this.fed - this.outputs < WALK_FEED_AHEAD
      && this.queue.length < WALK_QUEUE_MAX
    ) {
      const s = this.demuxed.samples[this.d]!;
      this.decoder.decode(
        this.io.createChunk({
          type: s.isKey ? 'key' : 'delta',
          timestamp: this.timeUsOfDecodeIndex[this.d]!,
          durationUs: Math.round((s.duration * 1e6) / this.demuxed.timescale),
          data: s.data,
        }),
      );
      this.d += 1;
      this.fed += 1;
    }
    if (this.d > this.feedEnd && !this.flushCalled) {
      this.flushCalled = true;
      this.decoder.flush().then(
        () => {
          this.flushDone = true;
          this.wake();
        },
        (e: unknown) => {
          this.failure = this.failure ?? (e instanceof Error ? e : new Error(String(e)));
          this.flushDone = true;
          this.wake();
        },
      );
    }
  }

  private onOutput(frame: DecodedFrameLike): void {
    this.outputs += 1;
    const presIdx = frame.timestamp === null ? undefined : this.presIndexByTimeUs.get(frame.timestamp);
    if (this.closed || presIdx === undefined || presIdx < this.from || presIdx > this.to) {
      frame.close(); // GOP lead-in before `from`, or routing miss
    } else {
      this.queue.push({ presIndex: presIdx, frame });
    }
    this.wake();
  }
}
