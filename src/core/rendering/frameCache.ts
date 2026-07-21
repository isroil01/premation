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
 */

export class FrameCache {
  private frames = new Map<number, HTMLCanvasElement>();
  private order: number[] = [];
  private key = '';
  private bytesPerFrame = 0;
  private version = 0;
  private readonly maxBytes: number;
  private readonly listeners = new Set<() => void>();

  constructor(maxBytes = 512 * 1024 * 1024) {
    this.maxBytes = maxBytes;
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

  /** Set the invalidation key + frame dimensions. A changed key clears all. */
  setKey(key: string, width: number, height: number): void {
    const sized = `${key}|${width}x${height}`;
    if (sized !== this.key) {
      this.key = sized;
      this.clearFrames();
    }
    this.bytesPerFrame = Math.max(1, width * height * 4);
  }

  get size(): number {
    return this.frames.size;
  }

  private get maxFrames(): number {
    return Math.max(2, Math.floor(this.maxBytes / this.bytesPerFrame));
  }

  /** The cached frame's canvas, or null. Touches LRU order. */
  get(frame: number): HTMLCanvasElement | null {
    const c = this.frames.get(frame);
    if (!c) return null;
    const i = this.order.indexOf(frame);
    if (i !== -1) this.order.splice(i, 1);
    this.order.push(frame);
    return c;
  }

  /** Copy `source` in as the render of `frame` (evicting LRU past budget). */
  put(frame: number, source: HTMLCanvasElement): void {
    if (source.width < 1 || source.height < 1) return;
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
    if (c.width !== source.width || c.height !== source.height) {
      c.width = source.width;
      c.height = source.height;
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
