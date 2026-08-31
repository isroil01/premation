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
 * **Both halves have since landed** (2026-08-17). Identity first
 * (`sceneContentHash.ts`): the key is a hash of the scene and animation
 * content, memoized on the revision counters, so it names a scene rather than
 * merely noticing that one changed. Then RETENTION, in this file: a generation
 * that stops being live is no longer deleted — it is parked, and comes back
 * whole if its key returns. That is what makes two things work that never did:
 *
 *  • **Undo gets its frames back.** The content hash returns to its previous
 *    value, `setGeneration` finds that generation parked, and every frame it
 *    held is immediately servable again — nothing is re-rendered.
 *  • **A restart inherits the previous session.** A MANIFEST (see
 *    `FrameBlobStore.readManifest`) records which generations hold which
 *    frames at what size; `open()` reconciles it against the blobs actually
 *    present — orphan blobs are deleted, manifest rows without blobs are
 *    dropped — and parks the survivors. When the project loads and produces
 *    the same content hash, the disk cache is warm from launch.
 *
 * The budget is GLOBAL across generations, oldest generation evicted first and
 * wholesale: a parked generation is speculative value, and half of one is
 * barely better than none. The live generation still evicts frame-by-frame,
 * LRU. A store without a manifest (anything but IndexedDB) cannot know what a
 * previous session's blobs weigh without reading them all, so it keeps the old
 * behaviour: purge at open, retention within the session only.
 *
 * ── What surviving a restart made necessary ─────────────────────────────────
 *
 * Retention closed the identity half and opened a second hole, and the paragraph
 * above did not notice: the content hash names the DOCUMENT, and nothing named
 * the RENDERER. Within one session that is fine — the code cannot change while
 * the process runs. Across a restart it is not: upgrade the app, or update a
 * plugin whose effect a layer uses, and a generation written by the OLD build
 * matches the new build's key exactly and is served. The green and blue bars
 * then promise pixels the current code would not produce, silently.
 *
 * So every generation id is NAMESPACED with `rendererIdentity()` (app version +
 * the compiled shader source of every ready plugin effect, plus a per-process
 * nonce in development). A build that differs cannot name a previous build's
 * generation, and `open()` drops parked generations from any other namespace
 * outright rather than leaving them to age out of the budget. The failure mode
 * is a cold cache, never a wrong frame — which is the same direction
 * `isPersistableProxy` errs in one layer up.
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
import { rendererIdentity } from './rendererIdentity';
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
  /**
   * Generations kept at once, the live one included. Default 4: the current
   * state, the state one undo back, and a couple more. Each parked generation
   * is a full work area of PNGs, so this is a real multiplier on disk use —
   * which is why it is a count and not "whatever fits".
   */
  maxGenerations?: number;
  /** Injected so tests do not need a canvas. Returns null when encoding fails. */
  encode?: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
  /** Injected for the same reason. */
  decode?: (blob: Blob) => Promise<DecodedFrame | null>;
  /**
   * Which renderer produced these frames — see the header.
   *
   * DEFAULTED rather than required, deliberately: a caller that forgets it must
   * get versioning anyway, because the whole point is that this cannot be left
   * out. Injected only so tests can drive a version change without rebuilding.
   */
  identity?: () => string;
}

/** Manifest schema. Versioned so a future shape change reads as "no manifest"
 *  rather than as garbage — the failure mode is then a cold cache, not a wrong
 *  one. Generations are ordered OLDEST FIRST; age is the eviction order. */
interface ManifestV1 {
  v: 1;
  gens: Array<{ id: string; frames: Array<[frame: number, bytes: number]> }>;
}

/**
 * How many frame encodes may be in flight at once.
 *
 * Encoding is slower than the render loop offers frames, so without a ceiling
 * the queue grows for as long as playback stays ahead of it — unbounded memory
 * for a tier whose whole job is to SAVE memory. Eight keeps the encoder busy
 * without letting it become the backlog.
 */
const MAX_INFLIGHT_WRITES = 8;

/** How long to sit on manifest changes before writing them out. The manifest is
 *  reconstruction metadata, not correctness-critical (a missing row just means
 *  a colder cache next launch), so it does not deserve an IO round trip per
 *  encoded frame — which a per-microtask flush effectively gave it. */
const MANIFEST_DEBOUNCE_MS = 500;

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
  private readonly maxGenerations: number;
  private readonly encode: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
  private readonly decode: (blob: Blob) => Promise<DecodedFrame | null>;

  /** frame → bytes, for the frames the LIVE generation holds. The LRU index
   *  lives here rather than in the store so eviction costs no round trips. */
  private index = new Map<number, number>();
  private order: number[] = [];
  private bytes = 0;

  /**
   * Parked generations, oldest first (Map preserves insertion order, and age
   * IS the eviction order). Each is frame → bytes for a generation that
   * stopped being live but whose blobs are still on disk, waiting for its key
   * to come back — an undo, or a relaunch of the same project.
   */
  private retained = new Map<string, Map<number, number>>();
  private retainedBytes = 0;

  /** Generation token. Every stored key carries it, so a key change makes the
   *  previous generation unreachable in one assignment — no scan, no await. */
  private generation = '';
  private writing = new Set<number>();
  private reading = new Set<number>();
  private opened = false;
  private persistScheduled = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly identity: () => string;

  constructor(opts: FrameDiskCacheOptions) {
    this.store = opts.store;
    this.maxBytes = opts.maxBytes ?? 4 * 1024 * 1024 * 1024;
    this.maxGenerations = Math.max(1, opts.maxGenerations ?? 4);
    this.encode = opts.encode ?? defaultEncode;
    this.decode = opts.decode ?? defaultDecode;
    this.identity = opts.identity ?? rendererIdentity;
  }

  /**
   * The caller's key, namespaced by the renderer that would render it.
   *
   * Every generation id on disk goes through here, so a build that differs
   * cannot NAME a previous build's generation — the protection is structural
   * rather than a check anyone has to remember to perform. `~` separates the
   * halves and appears in neither: the identity is version digits and base-36
   * hashes, the caller's key is a colon-joined list.
   */
  private namespaced(key: string): string {
    return `${this.identity()}~${key}`;
  }

  /**
   * Adopt what a previous session left — or discard it, when the store cannot
   * say what it is.
   *
   * With a manifest: reconcile it against the blobs actually present. A blob
   * without a manifest row is an orphan (a write that landed after the last
   * manifest flush) and is deleted; a manifest row without its blob is dropped.
   * What survives is parked, and comes back the moment its generation key is
   * set — which for a reloaded project is the first render.
   *
   * Without a manifest the old contract holds: purge. The alternative would be
   * reading every blob just to learn its size, which on a cold start is the
   * exact IO storm a cache exists to avoid.
   */
  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    if (!this.store.readManifest || !this.store.writeManifest) {
      await this.store.clear();
      return;
    }
    let manifest: ManifestV1 | null = null;
    try {
      const raw = await this.store.readManifest();
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && (parsed as ManifestV1).v === 1) {
          manifest = parsed as ManifestV1;
        }
      }
    } catch {
      manifest = null;
    }
    if (!manifest) {
      // No manifest (first run) or an unreadable one (future version, corrupt
      // write). Either way the blobs cannot be trusted — cold cache, not wrong.
      await this.store.clear();
      return;
    }

    const present = new Set(await this.store.keys());
    const orphans: string[] = [];
    // Only this renderer's generations are adoptable. A generation written by
    // another build could never be NAMED again (ids are namespaced), so leaving
    // it parked would just hold budget until the LRU got round to it — and it
    // would sit in the size readout as cache the user does not have. Dropping
    // it here is the same reconcile the orphan sweep below performs, one level
    // up: what cannot be used is not kept.
    const mine = `${this.identity()}~`;
    for (const gen of manifest.gens) {
      if (!gen.id.startsWith(mine)) continue;
      const frames = new Map<number, number>();
      for (const [frame, size] of gen.frames) {
        if (present.has(`${gen.id}#${frame}`)) {
          frames.set(frame, size);
          this.retainedBytes += size;
          present.delete(`${gen.id}#${frame}`);
        }
      }
      if (frames.size > 0) this.retained.set(gen.id, frames);
    }
    // Whatever remains in `present` has no manifest row — unaccounted bytes.
    for (const key of present) orphans.push(key);
    if (orphans.length) await this.store.delete(orphans);

    this.enforceCaps();
    this.schedulePersist();
  }

  get storedFrames(): number {
    return this.index.size;
  }

  get storedBytes(): number {
    return this.bytes;
  }

  /** Parked generations currently held (live excluded). */
  get retainedGenerations(): number {
    return this.retained.size;
  }

  /** Bytes across the LIVE generation and every parked one. */
  get totalBytes(): number {
    return this.bytes + this.retainedBytes;
  }

  /**
   * Point the tier at a new invalidation key.
   *
   * The outgoing generation is PARKED, not deleted — its blobs stay on disk
   * and its index moves to `retained`. If the incoming key names a parked
   * generation (an undo whose content hash returns, a reloaded project), that
   * generation is promoted whole and every frame it held is immediately
   * servable. This exchange is the entire payoff of the content-derived key.
   */
  setGeneration(key: string): void {
    // Namespaced HERE, at the single door every generation comes through, so
    // there is one place to get right rather than one per call site.
    const generation = this.namespaced(key);
    if (generation === this.generation) return;

    if (this.generation && this.index.size > 0) {
      this.retained.set(this.generation, this.index);
      this.retainedBytes += this.bytes;
    }
    this.index = new Map();
    this.order = [];
    this.bytes = 0;
    // In-flight encodes/decodes for the old generation check the token and
    // abandon themselves; clearing here just lets new work start immediately.
    this.writing.clear();
    this.reading.clear();
    this.generation = generation;

    const parked = this.retained.get(generation);
    if (parked) {
      this.retained.delete(generation);
      this.index = parked;
      // Ascending frame order is the honest LRU seed for a promoted
      // generation: nothing has been "recently used", and the playhead
      // usually moves forward, so the earliest frames are the safest to shed.
      this.order = [...parked.keys()].sort((a, b) => a - b);
      for (const size of parked.values()) {
        this.bytes += size;
        this.retainedBytes -= size;
      }
    }

    this.enforceCaps();
    this.schedulePersist();
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
    // Backpressure. A first playback pass over a heavy comp offers a frame
    // every tick, and PNG encoding a full-resolution frame is slower than that
    // — so the in-flight set grew without bound, holding a canvas copy each and
    // queueing encodes the machine was already losing ground on. Dropping the
    // offer is free: the frame stays in RAM, and the next pass over the same
    // span offers it again (`put` write-throughs are unconditional), by which
    // time the queue has drained.
    if (this.writing.size >= MAX_INFLIGHT_WRITES) return;
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
    this.enforceCaps();
    this.schedulePersist();
  }

  /**
   * Hold the two caps: generation count, then the GLOBAL byte budget.
   *
   * Parked generations go first, oldest first, WHOLESALE — a parked generation
   * is speculative value, and half of one is barely better than none. Only
   * when nothing is parked does the live generation shed frames, LRU.
   */
  private enforceCaps(): void {
    const drop: string[] = [];

    const dropOldestRetained = (): void => {
      const oldest = this.retained.keys().next();
      if (oldest.done) return;
      const frames = this.retained.get(oldest.value)!;
      for (const [frame, size] of frames) {
        this.retainedBytes -= size;
        drop.push(`${oldest.value}#${frame}`);
      }
      this.retained.delete(oldest.value);
    };

    while (this.retained.size > this.maxGenerations - 1) dropOldestRetained();
    while (this.bytes + this.retainedBytes > this.maxBytes && this.retained.size > 0) {
      dropOldestRetained();
    }
    while (this.bytes > this.maxBytes && this.order.length > 0) {
      const frame = this.order.shift()!;
      this.bytes -= this.index.get(frame) ?? 0;
      this.index.delete(frame);
      drop.push(this.keyFor(frame));
    }
    if (drop.length) void this.store.delete(drop);
  }

  /**
   * Persist the manifest, coalesced to one write per microtask turn — `track`
   * fires once per encoded frame, and a store write per frame would double the
   * IO this tier performs.
   */
  private schedulePersist(): void {
    if (!this.store.writeManifest || this.persistScheduled) return;
    this.persistScheduled = true;
    // A trailing TIMER, not a microtask. `track` fires once per encoded frame,
    // and a microtask flush lands between frames — so a playback pass rebuilt
    // and re-serialized the entire frame index, thousands of entries, on
    // essentially every frame it cached. Nothing reads the manifest until the
    // next launch, so coalescing it over half a second costs nothing.
    this.persistTimer = setTimeout(() => {
      this.persistScheduled = false;
      this.persistTimer = null;
      this.writeManifestNow();
    }, MANIFEST_DEBOUNCE_MS);
    // Node/jsdom keep the process alive for a pending timer; a cache flushing
    // its manifest must never be the reason a test run or a quit hangs.
    this.persistTimer.unref?.();
  }

  private writeManifestNow(): void {
    if (!this.store.writeManifest) return;
    const gens: ManifestV1['gens'] = [];
    for (const [id, frames] of this.retained) {
      gens.push({ id, frames: [...frames.entries()] });
    }
    if (this.generation && this.index.size > 0) {
      gens.push({ id: this.generation, frames: [...this.index.entries()] });
    }
    const manifest: ManifestV1 = { v: 1, gens };
    void this.store.writeManifest(JSON.stringify(manifest));
  }

  /** Write the manifest immediately, cancelling any pending debounce. Called on
   *  dispose so a session's last frames are still findable next launch. */
  flushManifest(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistScheduled) return;
    this.persistScheduled = false;
    this.writeManifestNow();
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

  /** Drop everything — live, parked, and the manifest. Backs a Purge control
   *  and is what a user reaches for when the quota is full. */
  async purge(): Promise<void> {
    this.index.clear();
    this.order = [];
    this.bytes = 0;
    this.retained.clear();
    this.retainedBytes = 0;
    this.writing.clear();
    this.reading.clear();
    await this.store.clear();
  }
}

/**
 * The viewport's disk tier, or null where no store exists (jsdom, and any
 * runtime without IndexedDB).
 *
 * ORDER MATTERS AT THE CALL SITE: `open()` reconciles (or, without a manifest,
 * purges) the previous session, so the tier must be opened BEFORE it is
 * attached to the RAM cache. Attaching first lets the render loop write frames
 * that the reconcile then deletes as orphans — a cache that silently drops
 * everything written in its first few hundred milliseconds.
 */
export function createViewportDiskCache(): FrameDiskCache | null {
  if (!frameStoreAvailable()) return null;
  const cache = new FrameDiskCache({ store: new IndexedDbFrameStore() });
  active = cache;
  return cache;
}

/** The live viewport tier, for surfaces outside the render loop — the settings
 *  dialog's size readout and Purge button. Null until the viewport mounts. */
let active: FrameDiskCache | null = null;
export function activeViewportDiskCache(): FrameDiskCache | null {
  return active;
}
