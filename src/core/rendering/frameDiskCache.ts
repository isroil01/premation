/**
 * The disk tier under the RAM frame cache.
 *
 * ── What this buys ──────────────────────────────────────────────────────────
 *
 * `FrameCache` holds ~60 full-res 1080p frames in its 512 MB budget — two
 * seconds of a 30 fps comp. Loop a work area longer than that and every pass
 * re-renders from scratch, which on a heavy comp is the difference between
 * playback and a slideshow. This tier holds the rest: PNG-encoded frames in a
 * byte-budgeted LRU, read back and promoted into RAM before the playhead
 * arrives.
 *
 * ── Why it is SESSION-SCOPED, and what would have to change ─────────────────
 *
 * This is the important constraint and it is not obvious. The invalidation key
 * the RAM cache is given (`useWorkspace.ts`) is built from `sceneRevision` and
 * the animation revision — MONOTONIC COUNTERS that start at 0 every launch.
 * Within one session that is a perfectly good identity: rev 7 is a specific
 * scene state. Across a restart it is meaningless — a freshly loaded project
 * sits at rev 0, and so does every OTHER project. Persisting frames under that
 * key and reading them back next launch would serve one project's pixels for
 * another's, silently, with no way for the user to tell.
 *
 * So {@link FrameDiskCache.open} PURGES whatever the previous session left, on
 * purpose, and the tier only ever serves frames written during this run. The
 * win — caching a whole work area instead of two seconds — does not depend on
 * surviving a restart.
 *
 * Making it survive one is a separate, larger change with a clear prerequisite:
 * a CONTENT-DERIVED key (a hash of the scene and animation state) instead of a
 * revision counter. That is worth doing on its own merits — it would also stop
 * an undo from clearing a cache whose pixels are identical to what it already
 * held — but it is a correctness change to the key, not a storage feature, and
 * doing it under cover of "add a disk cache" is how you ship the bug above.
 *
 * ── Why look-ahead rather than a fallback read ──────────────────────────────
 *
 * `FrameCache.get` is synchronous — the render loop blits or re-renders in the
 * same tick and cannot await a database. A disk tier consulted ON a miss would
 * therefore always arrive too late to be displayed, and would be pure overhead.
 * So reads are speculative: while frame N is on screen, {@link prefetch} pulls
 * N+1…N+k into RAM, and the loop finds them already there. That is the only
 * shape in which an async tier under a sync cache does anything at all.
 */

import { IndexedDbFrameStore, frameStoreAvailable } from './frameBlobStore';
import type { FrameBlobStore, StoredFrame } from './frameBlobStore';

/** What a decode yields. Narrower than `CanvasImageSource` on purpose: both of
 *  these carry NUMERIC width/height, which the promoting cache needs to size
 *  its canvas — an `SVGImageElement`'s are `SVGAnimatedLength`. */
export type DecodedFrame = ImageBitmap | HTMLCanvasElement;

/** Frames to pull ahead of the playhead. ~0.4 s at 30 fps — far enough to hide
 *  a decode, short enough that a seek does not queue work nobody wants. */
export const LOOK_AHEAD = 12;

/** Concurrent decodes. Reads are cheap; DECODES are not, and an unbounded fan
 *  -out competes with the renderer for the same main thread it is meant to free. */
const MAX_IN_FLIGHT = 4;

export interface FrameDiskCacheOptions {
  store: FrameBlobStore;
  /** Byte budget for the tier. Default 4 GB — frames are PNG, so a 1080p frame
   *  of typical motion-graphics content lands well under its 8 MB raw size. */
  maxBytes?: number;
  /** Injected so tests do not need a canvas. Returns null when encoding fails. */
  encode?: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
  /** Injected for the same reason. */
  decode?: (blob: Blob) => Promise<DecodedFrame | null>;
}

/** PNG, not WebP: a preview that shows different pixels than the render is a
 *  cache that lies. `toBlob` encodes off the main thread in Chromium, so the
 *  cost lands where it belongs. */
function defaultEncode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

async function defaultDecode(blob: Blob): Promise<DecodedFrame | null> {
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

export class FrameDiskCache {
  private readonly store: FrameBlobStore;
  private readonly maxBytes: number;
  private readonly encode: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
  private readonly decode: (blob: Blob) => Promise<DecodedFrame | null>;

  /** frame → bytes, for the frames this generation holds. The LRU index lives
   *  here rather than in the store so eviction costs no database round trips. */
  private index = new Map<number, number>();
  private order: number[] = [];
  private bytes = 0;

  /** Generation token. Every stored key carries it, so a key change makes the
   *  previous generation unreachable in one assignment — no scan, no await. */
  private generation = '';
  private writing = new Set<number>();
  private reading = new Set<number>();
  private opened = false;

  constructor(opts: FrameDiskCacheOptions) {
    this.store = opts.store;
    this.maxBytes = opts.maxBytes ?? 4 * 1024 * 1024 * 1024;
    this.encode = opts.encode ?? defaultEncode;
    this.decode = opts.decode ?? defaultDecode;
  }

  /** Discard anything a previous session left. See the header: those frames are
   *  keyed by a counter that has since reset, so they cannot be trusted. */
  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    await this.store.clear();
  }

  get storedFrames(): number {
    return this.index.size;
  }

  get storedBytes(): number {
    return this.bytes;
  }

  /** Point the tier at a new invalidation key. The old generation is abandoned
   *  immediately and swept in the background — correctness does not wait on IO. */
  setGeneration(generation: string): void {
    if (generation === this.generation) return;
    this.generation = generation;
    this.index.clear();
    this.order = [];
    this.bytes = 0;
    this.writing.clear();
    this.reading.clear();
    void this.store.clear();
  }

  private keyFor(frame: number): string {
    return `${this.generation}#${frame}`;
  }

  /** True when this frame is on disk for the current generation. */
  has(frame: number): boolean {
    return this.index.has(frame);
  }

  /**
   * Encode and store a frame. Fire-and-forget: the caller is the render loop.
   * A frame already stored (or mid-store) is skipped rather than re-encoded.
   */
  write(frame: number, source: HTMLCanvasElement): void {
    if (!this.generation) return;
    if (this.index.has(frame) || this.writing.has(frame)) return;
    if (source.width < 1 || source.height < 1) return;
    this.writing.add(frame);
    const generation = this.generation;
    void (async () => {
      try {
        const blob = await this.encode(source);
        // The generation can turn over mid-encode — the user edited something
        // while we were compressing. Writing then would put a stale frame under
        // a live key, which is the one thing this tier must never do.
        if (!blob || generation !== this.generation) return;
        const stored: StoredFrame = { blob, bytes: blob.size };
        await this.store.put(this.keyFor(frame), stored);
        if (generation !== this.generation) return;
        this.track(frame, stored.bytes);
      } finally {
        this.writing.delete(frame);
      }
    })();
  }

  private track(frame: number, bytes: number): void {
    if (!this.index.has(frame)) this.order.push(frame);
    else this.bytes -= this.index.get(frame)!;
    this.index.set(frame, bytes);
    this.bytes += bytes;
    this.evict();
  }

  private evict(): void {
    const drop: string[] = [];
    while (this.bytes > this.maxBytes && this.order.length > 0) {
      const frame = this.order.shift()!;
      this.bytes -= this.index.get(frame) ?? 0;
      this.index.delete(frame);
      drop.push(this.keyFor(frame));
    }
    if (drop.length) void this.store.delete(drop);
  }

  /**
   * Pull the frames just ahead of `from` into RAM via `promote`.
   *
   * `has` is consulted first so a frame that was never stored costs nothing,
   * and `reading` dedupes the storm that would otherwise arrive — `prefetch`
   * runs on every rendered frame, so the same look-ahead window is requested
   * dozens of times a second.
   */
  prefetch(
    from: number,
    isCachedInRam: (frame: number) => boolean,
    promote: (frame: number, image: DecodedFrame) => void,
    count = LOOK_AHEAD,
  ): void {
    if (!this.generation) return;
    for (let i = 1; i <= count; i++) {
      if (this.reading.size >= MAX_IN_FLIGHT) return;
      const frame = from + i;
      if (!this.index.has(frame) || isCachedInRam(frame) || this.reading.has(frame)) continue;
      this.read(frame, promote);
    }
  }

  private read(frame: number, promote: (frame: number, image: DecodedFrame) => void): void {
    this.reading.add(frame);
    const generation = this.generation;
    void (async () => {
      try {
        const stored = await this.store.get(this.keyFor(frame));
        if (!stored || generation !== this.generation) return;
        const image = await this.decode(stored.blob);
        if (!image || generation !== this.generation) return;
        // Touch LRU: a frame the playhead keeps reaching is the last we want
        // evicted, and only the read path knows that.
        const i = this.order.indexOf(frame);
        if (i !== -1) {
          this.order.splice(i, 1);
          this.order.push(frame);
        }
        promote(frame, image);
      } finally {
        this.reading.delete(frame);
      }
    })();
  }

  /** Merged spans of frames held on disk, in SECONDS — the darker half of the
   *  timeline's cache bar. Mirrors `FrameCache.ranges`. */
  ranges(fps: number): Array<{ start: number; end: number }> {
    if (fps <= 0 || this.index.size === 0) return [];
    const sorted = [...this.index.keys()].sort((a, b) => a - b);
    const out: Array<{ start: number; end: number }> = [];
    let s = sorted[0]!;
    let prev = s;
    for (let i = 1; i < sorted.length; i++) {
      const f = sorted[i]!;
      if (f === prev + 1) {
        prev = f;
        continue;
      }
      out.push({ start: s / fps, end: (prev + 1) / fps });
      s = f;
      prev = f;
    }
    out.push({ start: s / fps, end: (prev + 1) / fps });
    return out;
  }

  /** Drop everything, on disk and in the index. Backs a Purge control and is
   *  what a user reaches for when the quota is full. */
  async purge(): Promise<void> {
    this.index.clear();
    this.order = [];
    this.bytes = 0;
    this.writing.clear();
    this.reading.clear();
    await this.store.clear();
  }
}

/**
 * The viewport's disk tier, or null where no store exists (jsdom, and any
 * runtime without IndexedDB).
 *
 * ORDER MATTERS AT THE CALL SITE: `open()` purges the previous session, so the
 * tier must be opened BEFORE it is attached to the RAM cache. Attaching first
 * lets the render loop write frames that the purge then deletes — a cache that
 * silently drops everything written in its first few hundred milliseconds.
 */
export function createViewportDiskCache(): FrameDiskCache | null {
  if (!frameStoreAvailable()) return null;
  return new FrameDiskCache({ store: new IndexedDbFrameStore() });
}
