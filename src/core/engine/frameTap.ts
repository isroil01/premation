/**
 * Frame tap — a rate-limited, opt-in copy of the frame the viewport just drew.
 *
 * ## The constraint this exists to satisfy
 *
 * The viewport's content canvas is WebGL and has no `preserveDrawingBuffer`, so
 * its pixels are only readable inside the SAME task that drew them. Any
 * consumer that wants them (a scope, a histogram, a colour picker) therefore
 * cannot pull — by the time its timer fires, the drawing buffer is gone. It has
 * to be handed the pixels at draw time.
 *
 * So {@link publishFrame} copies SYNCHRONOUSLY: one `drawImage` onto a small 2D
 * scratch and one `getImageData`, both inside the render tick, and what
 * subscribers receive is that detached `ImageData` — safe to read whenever they
 * get round to it.
 *
 * ## Why it costs nothing when nobody is looking
 *
 * The render loop calls this on every frame it draws, including during
 * playback. With no subscribers the call returns on a `Set.size` check before
 * touching the canvas; with subscribers it still returns on a clock comparison
 * unless {@link setFrameTapInterval} milliseconds have passed. A scope panel
 * wants 10 Hz, and the loop can run at 60 — so five out of six calls do
 * nothing at all, and a closed panel makes all six do nothing.
 *
 * ## Region
 *
 * The content canvas is the VIEWPORT, not the composition: it carries the pan,
 * the zoom and whatever letterbox surrounds the comp at the current framing. A
 * scope reading that includes letterbox is wrong, so the consumer installs a
 * {@link setFrameTapRegion} callback returning the comp's rect in canvas
 * pixels, and the tap crops to it. The callback lives with the consumer rather
 * than here on purpose: this module must not import the workspace camera, or
 * `@core/rendering` would start depending on `@core/workspace` for the benefit
 * of one panel.
 *
 * ## Wiring
 *
 * Nothing publishes until one line is added to the viewport render loop, right
 * after the backend draws:
 *
 *     if (!ghost) publishFrame(content, t);
 *
 * Until then this module is inert and consumers fall back to the RAM preview
 * cache, which holds plain 2D canvases and can be read at any time.
 */

/** A detached copy of one rendered frame. Safe to hold and read later. */
export interface TappedFrame {
  /** RGBA, straight alpha, row-major. */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Composition time the frame was rendered at, in seconds. */
  readonly time: number;
  /** `performance.now()` at publish, for staleness checks. */
  readonly publishedAt: number;
}

/** Crop applied before the copy, in canvas pixels. */
export interface FrameTapRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FrameTapListener = (frame: TappedFrame) => void;

/**
 * Supplies the crop, given the size of the canvas being published.
 *
 * The size is a parameter rather than something the consumer looks up, because
 * only the render loop knows it: adaptive preview resolution changes the
 * content buffer's dimensions mid-playback without changing anything the
 * consumer can observe.
 */
export type FrameTapRegionFn = (canvasWidth: number, canvasHeight: number) => FrameTapRegion | null;

/** Default publish ceiling — the rate a scope panel wants. */
export const DEFAULT_FRAME_TAP_HZ = 10;

/** Longest edge of the copy. Matches the scopes' own downsample ceiling. */
const MAX_TAP_WIDTH = 320;

const listeners = new Set<FrameTapListener>();
let regionFn: FrameTapRegionFn | null = null;
let minIntervalMs = 1000 / DEFAULT_FRAME_TAP_HZ;
let lastPublishAt = Number.NEGATIVE_INFINITY;
let latest: TappedFrame | null = null;
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Subscribe to published frames. Returns the unsubscriber — CALL IT. */
export function subscribeFrames(fn: FrameTapListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    // Drop the held frame once the last consumer goes: it pins a few hundred
    // KB of pixels nobody can ask for any more.
    if (listeners.size === 0) latest = null;
  };
}

/** Whether anything is listening. The render loop's cheapest possible gate. */
export function frameTapActive(): boolean {
  return listeners.size > 0;
}

/**
 * Install the crop the tap applies, or `null` for the whole canvas.
 *
 * A function rather than a value because the framing changes on every pan and
 * zoom, and re-installing it on each would be a subscription of its own.
 */
export function setFrameTapRegion(fn: FrameTapRegionFn | null): void {
  regionFn = fn;
}

/** Ceiling on publish rate, in Hz. */
export function setFrameTapInterval(hz: number): void {
  minIntervalMs = hz > 0 ? 1000 / hz : 0;
}

/**
 * The most recent published frame, or `null` when there is none that recent.
 *
 * For consumers that sample on their own timer rather than reacting to the
 * subscription: a scope panel that has just been resized wants the frame it
 * already has, not to wait for the next render tick.
 */
export function latestTappedFrame(maxAgeMs = 1000): TappedFrame | null {
  if (!latest) return null;
  return now() - latest.publishedAt <= maxAgeMs ? latest : null;
}

/**
 * Publish the frame `canvas` currently holds.
 *
 * Call from inside the render tick, immediately after the draw. Never throws:
 * this sits on the viewport's hot path, and a scope panel must not be able to
 * take the preview down with it — a failed readback drops the frame silently
 * and the consumer falls back to the preview cache.
 */
export function publishFrame(canvas: HTMLCanvasElement | null | undefined, timeSec: number): void {
  if (listeners.size === 0) return;
  if (!canvas || canvas.width < 1 || canvas.height < 1) return;
  const t = now();
  if (t - lastPublishAt < minIntervalMs) return;
  lastPublishAt = t;

  try {
    const region = regionFn?.(canvas.width, canvas.height) ?? null;
    const sx = Math.max(0, Math.min(canvas.width - 1, Math.floor(region?.x ?? 0)));
    const sy = Math.max(0, Math.min(canvas.height - 1, Math.floor(region?.y ?? 0)));
    const sw = Math.max(1, Math.min(canvas.width - sx, Math.round(region?.width ?? canvas.width)));
    const sh = Math.max(1, Math.min(canvas.height - sy, Math.round(region?.height ?? canvas.height)));

    const scale = Math.min(1, MAX_TAP_WIDTH / sw);
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    if (!scratch) {
      scratch = document.createElement('canvas');
      // `willReadFrequently` puts the surface on the CPU side, which is what a
      // getImageData-every-frame consumer wants — without it Chromium keeps
      // re-uploading and re-downloading a texture nobody ever composites.
      scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
    }
    const ctx = scratchCtx;
    if (!ctx || !scratch) return;
    if (scratch.width !== dw || scratch.height !== dh) {
      scratch.width = dw;
      scratch.height = dh;
    }
    // The source can carry transparent letterbox; clearing first keeps stale
    // pixels from a previous, larger frame out of the copy.
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, dw, dh);
    const img = ctx.getImageData(0, 0, dw, dh);

    const frame: TappedFrame = {
      data: img.data,
      width: dw,
      height: dh,
      time: timeSec,
      publishedAt: t,
    };
    latest = frame;
    for (const fn of [...listeners]) {
      try {
        fn(frame);
      } catch {
        // A broken consumer is the consumer's problem, not the renderer's.
      }
    }
  } catch {
    // Context loss, a tainted canvas, a zero-sized crop — drop the frame.
  }
}

/** Test seam: forget listeners, region, clock and scratch surface. */
export function resetFrameTap(): void {
  listeners.clear();
  regionFn = null;
  minIntervalMs = 1000 / DEFAULT_FRAME_TAP_HZ;
  lastPublishAt = Number.NEGATIVE_INFINITY;
  latest = null;
  scratch = null;
  scratchCtx = null;
}
