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
}

/** The injectable seam between the session and WebCodecs. */
export interface DecoderIO {
  createDecoder(
    config: DecoderConfig,
    handlers: { output: (frame: DecodedFrameLike) => void; error: (e: Error) => void },
  ): VideoDecoderLike;
  createChunk(init: EncodedChunkInit): unknown;
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
};

/** Frames a single flush can strand in cache beyond the configured budget:
 *  the budget must never evict frames of the GOP being decoded RIGHT NOW, or
 *  a long GOP would evict its own target before frameAt returns it. */
const MIN_CACHE = 4;

export class ExactVideoSource {
  readonly index: VideoFrameIndex;
  private readonly timeUsOfDecodeIndex: number[];
  private readonly presIndexByTimeUs = new Map<number, number>();
  private cache = new Map<number, DecodedFrameLike>();
  private lru: number[] = [];
  private decoder: VideoDecoderLike | null = null;
  private failure: Error | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly demuxed: DemuxedVideo,
    private readonly io: DecoderIO = webCodecsIO,
    private readonly maxCached = 48,
  ) {
    this.index = buildFrameIndex(demuxed.samples, demuxed.timescale);
    this.timeUsOfDecodeIndex = new Array<number>(demuxed.samples.length).fill(0);
    this.index.frames.forEach((f, presIdx) => {
      this.timeUsOfDecodeIndex[f.decodeIndex] = f.timeUs;
      this.presIndexByTimeUs.set(f.timeUs, presIdx);
    });
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
    const prior = this.cache.get(presIdx);
    if (prior) prior.close();
    this.cache.set(presIdx, frame);
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
