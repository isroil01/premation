/**
 * One animation clock for every preset thumbnail on screen.
 *
 * The library shows dozens of cards and all of them loop continuously — you
 * should be able to see what a preset does without hovering it, let alone
 * applying it and undoing. That is the whole reason the gallery exists.
 *
 * Dozens of cards each owning a `requestAnimationFrame` loop is how a gallery
 * becomes the most expensive thing in the app, so there is exactly ONE rAF
 * here. It runs only while something is subscribed, and cards unsubscribe the
 * moment they scroll out of view.
 *
 * Frames are throttled: a thumbnail redraw lays out its glyphs from scratch, so
 * 30 cards at 60fps is 30 text layouts a frame for content the eye reads as
 * smooth at half that. The editor viewport is what deserves the frame budget.
 */

/** Redraw rate for thumbnails. Fast enough to read as motion, half the cost. */
const PREVIEW_FPS = 30;
const FRAME_MS = 1000 / PREVIEW_FPS;

type Tick = (elapsedSeconds: number) => void;

const subscribers = new Set<Tick>();
let raf = 0;
let startedAt = 0;
let lastFrame = 0;

function loop(now: number): void {
  raf = requestAnimationFrame(loop);
  if (now - lastFrame < FRAME_MS) return;
  lastFrame = now;
  const elapsed = (now - startedAt) / 1000;
  // Snapshot: a subscriber may unsubscribe from inside its own tick (a card
  // unmounting mid-frame), and mutating the set while iterating it skips one.
  for (const fn of [...subscribers]) {
    try {
      fn(elapsed);
    } catch {
      // One bad preview must not stop the clock for every other card.
    }
  }
}

/**
 * Drive `fn` until the returned function is called.
 *
 * `fn` receives seconds since the clock started — a shared timebase, not a
 * per-card one, so cards stay in phase with each other unless they choose not
 * to be (see the phase offset in PresetPreview).
 */
export function subscribePreviewTick(fn: Tick): () => void {
  subscribers.add(fn);
  if (raf === 0) {
    startedAt = performance.now();
    lastFrame = 0;
    raf = requestAnimationFrame(loop);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

/** True when the user has asked for less motion. A wall of looping thumbnails
 *  is exactly the kind of thing that setting exists for, so those users get a
 *  representative still instead. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A stable 0..1 offset from a string, so neighbouring cards do not all hit the
 *  same beat of their loops at once — a grid pulsing in lockstep reads as a
 *  glitch rather than as a set of independent examples. */
export function phaseFor(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}
