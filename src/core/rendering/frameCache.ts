/**
 * Frame cache (RAM preview) — a byte-budgeted LRU of fully rendered frames.
 *
 * The viewport render loop offers every frame it renders; during playback (or
 * scrubbing) a cached frame is blitted instead of re-rendered, so a second
 * loop over the work area plays back at full speed no matter how heavy the
 * comp is. The cache is keyed by an INVALIDATION KEY that encodes everything
 * affecting pixels (scene revision, animation revision, view transform,
 * quality, comp, guides chrome …) — any change clears it wholesale, which is
 * the honest contract the old fake "cache bar" never had.
 *
 * Canvas copies (not ImageBitmap) keep everything synchronous; the byte budget
 * caps memory (a 1080p frame at dpr 1 is ~8 MB, so the default 512 MB budget
 * holds ~60 full-res frames — far more at preview resolutions).
 *
 * An optional DISK TIER sits underneath (`frameDiskCache.ts`) and holds the
 * frames this budget cannot. It is deliberately not consulted on a miss — `get`
 * is synchronous and the render loop cannot await a database, so a read that
 * started on a miss would always land too late to be drawn. Instead every `get`
 * asks the tier to pull the NEXT few frames in, so the playhead finds them
 * already here. See that file's header for why the tier is session-scoped.
 *
 * ## LRU and the byte budget
 *
 * Recency is the Map's own insertion order — a touch deletes and re-inserts, so
 * `frames.keys().next()` is always the least recently used. The parallel
 * `order: number[]` this replaced cost an O(n) `indexOf` + `splice` on every
 * single `get`, i.e. on every frame of smooth playback.
 *
 * The budget is charged against each entry's REAL byte size rather than a
 * single `bytesPerFrame` reading of the current canvas. Adaptive resolution
 * flips the canvas density mid-playback and cached frames deliberately keep
 * whatever resolution they were rendered at (see {@link setKey}), so a cache
 * holding a mix of Full and Quarter frames was being sized as if every frame
 * matched the newest one — overshooting the budget by up to 16× after a
 * degrade, and evicting valid frames early after a restore.
 */

import type { FrameDiskCache } from './frameDiskCache';

interface CachedFrame {
  canvas: HTMLCanvasElement;
  bytes: number;
}

export class FrameCache {
  /** Insertion order IS the LRU order: least-recently-used first. */
  private frames = new Map<number, CachedFrame>();
  private totalBytes = 0;
  private key = '';
  private version = 0;
  private readonly maxBytes: number;
  private readonly listeners = new Set<() => void>();
  private disk: FrameDiskCache | null = null;
  /** Last frame the disk look-ahead was asked about — the pump's skip scan and
   *  repeated reads of one frame must not re-scan the same window every call. */
  private lastPrefetchFrom = -1;
  /** `ranges()` memo: the sort is O(n log n) and the bars re-read it on a
   *  timer, so recomputing an unchanged answer is pure waste. */
  private rangesMemo: { version: number; fps: number; out: Array<{ start: number; end: number }> } | null = null;

  constructor(maxBytes = 512 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  /** Attach the disk tier. Optional: without one this is exactly the RAM LRU it
   *  has always been, which is what the web edition and every test get. */
  attachDisk(disk: FrameDiskCache | null): void {
    this.disk = disk;
    if (disk && this.key) disk.setGeneration(this.key);
  }

  /** Spans the disk tier holds for the live generation, in seconds — the cache
   *  bar's second (blue) lane. This is a SUPERSET of RAM residency, not the
   *  difference: a frame in both tiers appears in both lists, and the bar draws
   *  the green RAM lane over the blue one. Empty when there is no disk cache. */
  diskRanges(fps: number): Array<{ start: number; end: number }> {
    return this.disk?.ranges(fps) ?? [];
  }

  /** Bumped on every put/clear — cheap subscription primitive for the UI. */
  getVersion(): number {
    return this.version;
  }

  /** Subscribe to cache changes (put/clear). Returns the unsubscriber. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /**
   * Set the invalidation key + frame dimensions. A changed KEY clears all.
   *
   * The dimensions deliberately do NOT join the invalidation: they change
   * whenever adaptive resolution flips the canvas density mid-playback, and
   * folding them in wiped the whole RAM+disk preview every time quality
   * degraded (3 slow frames) and again every time it restored (45 fast
   * frames) — the green bar could never complete on a heavy comp. Resolution
   * is QUALITY, not content: a frame cached at Half is still the right
   * pixels, just softer (exactly After Effects' behaviour — cached frames
   * keep the resolution they were rendered at). Framing-affecting facts (the
   * view transform, the comp, the CSS viewport size) belong in `key`, which
   * the caller assembles.
   *
   * `width`/`height` are now advisory only — eviction charges each entry its
   * own real size — but they stay in the signature because the caller has them
   * and a future budget heuristic would want the current frame's cost.
   */
  setKey(key: string, _width: number, _height: number): void {
    if (key !== this.key) {
      this.key = key;
      this.clearFrames();
      // The disk tier turns over with RAM: it is the same invalidation, and a
      // generation that outlived its key would serve pre-edit pixels.
      this.disk?.setGeneration(key);
    }
  }

  /**
   * Ask the disk tier to start promoting the frames at and after `frame` into
   * RAM. No read, no LRU touch, no return value.
   *
   * `get` normally carries the look-ahead, which is fine for the render loop —
   * it reads every frame it needs. The idle pre-render pump does not: it probes
   * with {@link has} precisely to avoid disturbing recency, and that would
   * otherwise leave it with no way to reach the disk tier at all, so it would
   * re-render from scratch every frame that had been evicted from RAM but is
   * still sitting on disk — the most expensive possible answer to a question
   * the disk already knows.
   */
  prefetchFrom(frame: number): void {
    if (!this.disk) return;
    this.lastPrefetchFrom = frame;
    this.disk.prefetch(
      frame,
      (f) => this.frames.has(f),
      (f, image) => this.insert(f, image, image.width, image.height),
    );
  }

  /**
   * Is this frame in RAM? A pure probe: it does NOT touch LRU recency and does
   * NOT trigger a disk look-ahead.
   *
   * The idle pre-render pump scans forward for the first uncached frame, and
   * doing that with `get` both re-ordered the whole cached run into "most
   * recently used" (so eviction then dropped the frames nearest the playhead)
   * and fired a prefetch per probe.
   */
  has(frame: number): boolean {
    return this.frames.has(frame);
  }

  /**
   * Last frame of the CONTIGUOUS cached run containing `frame` (or `frame`
   * itself when uncached). The playback path uses it to park video elements
   * at the end of the green span they are riding.
   */
  contiguousEnd(frame: number): number {
    let f = frame;
    while (this.frames.has(f + 1)) f += 1;
    return f;
  }

  get size(): number {
    return this.frames.size;
  }

  /** Bytes currently held (for diagnostics and tests). */
  get bytes(): number {
    return this.totalBytes;
  }

  /** The cached frame's canvas, or null. Touches LRU order.
   *
   *  Also asks the disk tier to pull the frames just AHEAD of this one into
   *  RAM — on a hit as well as a miss, because during smooth playback every
   *  frame is a hit and that is exactly when the look-ahead has to keep
   *  running. */
  get(frame: number): HTMLCanvasElement | null {
    if (this.disk && frame !== this.lastPrefetchFrom) {
      this.lastPrefetchFrom = frame;
      this.disk.prefetch(
        frame,
        (f) => this.frames.has(f),
        (f, image) => this.insert(f, image, image.width, image.height),
      );
    }
    const e = this.frames.get(frame);
    if (!e) return null;
    // Re-insert to move this entry to the most-recently-used end. O(1).
    this.frames.delete(frame);
    this.frames.set(frame, e);
    return e.canvas;
  }

  /** Copy `source` in as the render of `frame` (evicting LRU past budget), and
   *  write it through to the disk tier so it outlives RAM eviction. */
  put(frame: number, source: HTMLCanvasElement): void {
    if (source.width < 1 || source.height < 1) return;
    this.insert(frame, source, source.width, source.height);
    // Hand the disk tier OUR copy, not the caller's canvas.
    //
    // The caller's canvas is the live WebGL content canvas, and the tier
    // encodes with `toBlob`, which snapshots at call time — so writing through
    // from here forced a second full GPU readback inside the render tick, on
    // top of the one `insert` just did, for every uncached frame of playback.
    // The copy is a plain 2D canvas that nothing else draws to, so it reads
    // back cheaply and stays valid if the tier ever defers its encode.
    const stored = this.frames.get(frame);
    this.disk?.write(frame, stored ? stored.canvas : source);
  }

  /**
   * Take a frame into RAM WITHOUT writing it back to disk.
   *
   * The promotion path from the disk tier lands here. Routing it through `put`
   * instead would re-encode and re-store a frame that was just read from the
   * store — a loop that costs the most on exactly the heavy comps this tier is
   * for.
   */
  private insert(frame: number, source: CanvasImageSource, width: number, height: number): void {
    if (width < 1 || height < 1) return;
    const bytes = width * height * 4;
    let e = this.frames.get(frame);
    if (e) {
      // Re-insert so the refreshed entry counts as most-recently-used.
      this.frames.delete(frame);
      this.totalBytes -= e.bytes;
      e.bytes = bytes;
    } else {
      e = { canvas: document.createElement('canvas'), bytes };
    }
    const c = e.canvas;
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    this.frames.set(frame, e);
    this.totalBytes += bytes;
    // The pixel copy is guarded (jsdom has no 2D context), but the LRU
    // bookkeeping + notification must run regardless so eviction and the
    // cache bar stay correct.
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(source, 0, 0);
    }
    // Never evict down to nothing: one frame larger than the whole budget is a
    // misconfiguration, not a reason to hold zero frames and re-render forever.
    while (this.totalBytes > this.maxBytes && this.frames.size > 1) {
      const oldest = this.frames.keys().next();
      if (oldest.done) break;
      const victim = this.frames.get(oldest.value);
      this.frames.delete(oldest.value);
      if (victim) this.totalBytes -= victim.bytes;
    }
    this.notify();
  }

  /** Merged spans of cached frames, in SECONDS, for the timeline's cache bar. */
  ranges(fps: number): Array<{ start: number; end: number }> {
    if (fps <= 0 || this.frames.size === 0) return [];
    const memo = this.rangesMemo;
    if (memo && memo.version === this.version && memo.fps === fps) return memo.out;
    const sorted = [...this.frames.keys()].sort((a, b) => a - b);
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
    this.rangesMemo = { version: this.version, fps, out };
    return out;
  }

  clear(): void {
    this.clearFrames();
  }

  private clearFrames(): void {
    if (this.frames.size === 0) return;
    this.frames.clear();
    this.totalBytes = 0;
    this.lastPrefetchFrom = -1;
    this.notify();
  }
}

/** The viewport's shared cache instance. */
export const viewportFrameCache = new FrameCache();
