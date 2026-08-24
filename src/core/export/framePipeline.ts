/**
 * Frame pipeline — let the render run ahead of the encode.
 *
 * The export loop is "render frame, hand it to the sink, wait, repeat". For the
 * desktop sink that wait is a PNG/JPEG encode (`canvas.toBlob`, 30–100 ms at
 * 1080p) followed by an IPC write — so the GPU sat idle for most of every
 * frame, and a 4-core machine encoded on one of them. This is the After
 * Effects Multi-Frame Rendering idea applied where it actually pays here:
 * the per-frame render stays serial (one GPU, one scene graph), but the
 * encode-and-stage of frame N overlaps the render of N+1 … N+k, and the
 * browser's image encoder runs `toBlob` calls on its own thread pool, so k
 * encodes in flight use k cores.
 *
 * The pipeline is a bounded queue of in-flight jobs. `push` returns as soon as
 * the job is STARTED unless the queue is full, in which case it waits for the
 * oldest to finish — back-pressure, so a slow disk cannot make memory grow
 * without bound. `drain` waits for everything. An error in any job is held
 * and rethrown by the next `push` or by `drain`, so a failed frame cannot
 * be silently skipped into a file with a hole in it.
 *
 * Pure and DOM-free so the ordering and back-pressure can be tested with
 * fake timers rather than a real encoder.
 */

export interface FramePipelineOptions {
  /** Jobs allowed in flight at once. Default: cores − 1, clamped to 2..6. */
  concurrency?: number;
}

export function defaultConcurrency(cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4): number {
  const n = (cores || 4) - 1;
  return Math.max(2, Math.min(6, n));
}

export class FramePipeline {
  private readonly limit: number;
  private readonly inFlight = new Set<Promise<void>>();
  private failure: unknown = null;
  private closed = false;

  constructor(opts: FramePipelineOptions = {}) {
    this.limit = opts.concurrency ?? defaultConcurrency();
  }

  /** Jobs currently running. */
  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * Start a job. Resolves once it has been ADMITTED — immediately when there
   * is room, or after the oldest in-flight job completes when there is not.
   */
  async push(job: () => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('FramePipeline is closed.');
    if (this.failure) throw this.failure;
    if (this.inFlight.size >= this.limit) {
      // Wait for ANY job to finish, not the oldest specifically — with equal
      // encoders the oldest usually is the first out, but a slow frame must
      // not hold a free slot hostage.
      await Promise.race(this.inFlight);
      if (this.failure) throw this.failure;
    }
    const p = job()
      .catch((err: unknown) => {
        // First failure wins; the rest are consequences.
        if (!this.failure) this.failure = err;
      })
      .finally(() => {
        this.inFlight.delete(p);
      });
    this.inFlight.add(p);
  }

  /** Wait for every job; rethrow the first failure. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
    if (this.failure) throw this.failure;
  }

  /** Wait for in-flight jobs and refuse further pushes. Swallows failures —
   *  used on the dispose path, where the job is already being abandoned. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }
}

/**
 * A pool of scratch canvases so the renderer's canvas can be released to the
 * next frame the moment its pixels are copied. One `drawImage` is a GPU→GPU
 * (or memory) blit and far cheaper than the encode it decouples.
 *
 * Sized to the pipeline's concurrency plus one: every in-flight encode owns a
 * canvas, and the next frame needs one free.
 */
export class CanvasPool {
  private readonly free: HTMLCanvasElement[] = [];

  constructor(private readonly width: number, private readonly height: number, size: number) {
    for (let i = 0; i < size; i++) this.free.push(this.make());
  }

  private make(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    return c;
  }

  /** Copy `src` into a pooled canvas and return it. Never blocks: a pool that
   *  runs dry (more encodes in flight than planned) grows, since a late
   *  allocation beats a stall. */
  snapshot(src: HTMLCanvasElement): HTMLCanvasElement {
    const c = this.free.pop() ?? this.make();
    if (c.width !== src.width || c.height !== src.height) {
      c.width = src.width;
      c.height = src.height;
    }
    const g = c.getContext('2d');
    if (!g) throw new Error('Scratch canvas has no 2D context.');
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0);
    return c;
  }

  release(c: HTMLCanvasElement): void {
    this.free.push(c);
  }
}
