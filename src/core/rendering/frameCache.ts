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
 */

import type { FrameDiskCache } from './frameDiskCache';

export class FrameCache {
  private frames = new Map<number, HTMLCanvasElement>();
  private order: number[] = [];
  private key = '';
  private bytesPerFrame = 0;
  private version = 0;
  private readonly maxBytes: number;
  private readonly listeners = new Set<() => void>();
  private disk: FrameDiskCache | null = null;

  constructor(maxBytes = 512 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  /** Attach the disk tier. Optional: without one this is exactly the RAM LRU it
   *  has always been, which is what the web edition and every test get. */
  attachDisk(disk: FrameDiskCache | null): void {
    this.disk = disk;
    if (disk && this.key) disk.setGeneration(this.key);
  }

  /** Spans held on disk but not in RAM, in seconds — for the cache bar's
   *  second tier. Empty when there is no disk cache. */
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
   */
  setKey(key: string, width: number, height: number): void {
    if (key !== this.key) {
      this.key = key;
      this.clearFrames();
      // The disk tier turns over with RAM: it is the same invalidation, and a
      // generation that outlived its key would serve pre-edit pixels.
      this.disk?.setGeneration(key);
    }
    this.bytesPerFrame = Math.max(1, width * height * 4);
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

  private get maxFrames(): number {
    return Math.max(2, Math.floor(this.maxBytes / this.bytesPerFrame));
  }

  /** The cached frame's canvas, or null. Touches LRU order.
   *
   *  Also asks the disk tier to pull the frames just AHEAD of this one into
   *  RAM — on a hit as well as a miss, because during smooth playback every
   *  frame is a hit and that is exactly when the look-ahead has to keep
   *  running. */
  get(frame: number): HTMLCanvasElement | null {
    this.disk?.prefetch(
      frame,
      (f) => this.frames.has(f),
      (f, image) => this.insert(f, image, image.width, image.height),
    );
    const c = this.frames.get(frame);
    if (!c) return null;
    const i = this.order.indexOf(frame);
    if (i !== -1) this.order.splice(i, 1);
    this.order.push(frame);
    return c;
  }

  /** Copy `source` in as the render of `frame` (evicting LRU past budget), and
   *  write it through to the disk tier so it outlives RAM eviction. */
  put(frame: number, source: HTMLCanvasElement): void {
    if (source.width < 1 || source.height < 1) return;
    this.insert(frame, source, source.width, source.height);
    this.disk?.write(frame, source);
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
    let c = this.frames.get(frame);
    if (!c) {
      c = document.createElement('canvas');
      this.frames.set(frame, c);
      this.order.push(frame);
    } else {
      const i = this.order.indexOf(frame);
      if (i !== -1) this.order.splice(i, 1);
      this.order.push(frame);
    }
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    // The pixel copy is guarded (jsdom has no 2D context), but the LRU
    // bookkeeping + notification must run regardless so eviction and the
    // cache bar stay correct.
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(source, 0, 0);
    }
    while (this.frames.size > this.maxFrames) {
      const evict = this.order.shift();
      if (evict === undefined) break;
      this.frames.delete(evict);
    }
    this.notify();
  }

  /** Merged spans of cached frames, in SECONDS, for the timeline's cache bar. */
  ranges(fps: number): Array<{ start: number; end: number }> {
    if (fps <= 0 || this.frames.size === 0) return [];
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
    return out;
  }

  clear(): void {
    this.clearFrames();
  }

  private clearFrames(): void {
    if (this.frames.size === 0) return;
    this.frames.clear();
    this.order = [];
    this.notify();
  }
}

/** The viewport's shared cache instance. */
export const viewportFrameCache = new FrameCache();
