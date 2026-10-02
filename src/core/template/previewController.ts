/**
 * Gallery preview controller — the library / template / preset cards.
 *
 * A card shows the ENGINE's picture of its item: the item's scene is built into
 * an isolated throwaway SceneGraph + AnimationEngine (the choreography replayed
 * in raw seconds — previews never touch the user's document), handed to the
 * engine as a preview document, and drawn with `renderDocumentStill`
 * (core/engine/previewDocument.ts). So a card shows what inserting the item
 * will render, drawn by the renderer that will render it.
 *
 *   • POSTER — every card that is on screen gets one still, at the time its
 *     choreography shows the most of itself. Cards scrolled out of view ask for
 *     nothing (a shared IntersectionObserver), and nothing is built until the
 *     card is first seen.
 *   • MOTION — a card plays while the pointer is over it (or it has keyboard
 *     focus): its loop is rendered once as a flipbook of engine stills and then
 *     replayed from memory. Frames are asked one at a time, in order, and play
 *     as they arrive.
 *
 * Why not every card looping at once, as the page renderer did: a frame is now
 * a still the ENGINE draws (a few ms each for these small scenes, on the render
 * thread the viewport uses) and then a decoded bitmap the page holds — a
 * gallery looping every visible card would hold a flipbook per card in memory.
 * One poster per visible card and a flipbook for the card being pointed at
 * keeps a library panel from costing the viewport or the page anything
 * noticeable.
 */

import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { graphNodes, previewDocumentOf, previewStill, isTransparentColor, type PreviewDocument } from '@core/engine/previewDocument';
import { choreographyDuration, choreographyRestTime, type SetKf } from './templates/builders';

export interface PreviewSpec {
  /** Populate the isolated graph (root id must be `rootId`, default 'tpl_root'). */
  build: (g: SceneGraph) => void;
  /** The choreography, replayed against the preview engine in raw seconds. */
  animate?: (set: SetKf) => void;
  /** Optional post-pass with direct access to the isolated preview engine —
   *  attach expressions (loopOut/wiggle) or data keyframes (text.source) that
   *  the plain numeric SetKf abstraction cannot carry. */
  decorate?: (anim: AnimationEngine) => void;
  /** Override the card's loop length (seconds). Needed for expression-driven
   *  loops, whose motion outlives their finite keyframe span. When set, the
   *  card loops seamlessly over exactly this window (no end-pose hold). */
  duration?: number;
  /** The still frame's time (seconds). Default: where the choreography shows
   *  the most of itself (`choreographyRestTime`), 0 without one. */
  posterTime?: number;
  /**
   * A stable identity for the item (e.g. `mograph:<id>`). With one, the card's
   * poster and flipbook are remembered across unmounts, so reopening a library
   * section does not ask the engine again. Without one they live with the mount.
   */
  cacheKey?: string;
  width: number;
  height: number;
  background?: string;
  rootId?: string;
}

/** A spec's scene as the engine takes it, with the times the card plays. */
export interface PreviewScene {
  doc: PreviewDocument;
  /** The choreography's length (seconds); 0 for a static scene. */
  duration: number;
  /** The card's loop: explicit windows restart seamlessly, finite choreographies hold the last pose first. */
  loop: number;
  posterTime: number;
}

/** A beat of the settled pose before a finite choreography restarts. */
const END_HOLD_SECONDS = 0.9;

/**
 * Build a card's isolated scene + choreography and serialise it for the engine
 * — the expensive half of a preview, deferred until the card is actually on
 * screen. A recipe that throws leaves what it built so far (the card shows
 * that), never a broken gallery.
 */
export function buildPreviewScene(spec: PreviewSpec): PreviewScene {
  const rootId = spec.rootId ?? 'tpl_root';
  const graph = new SceneGraph();
  try {
    spec.build(graph);
  } catch {
    /* leave what was built — the card shows it */
  }
  const anim = new AnimationEngine();
  const rawSet: SetKf = (id, prop, time, value, ease) =>
    anim.setKeyframe(id, prop, time, value, ease ?? 'easeInOut');
  try {
    if (spec.animate) spec.animate(rawSet);
    spec.decorate?.(anim);
  } catch {
    /* a bad choreography must not kill the card — what was keyed still plays */
  }
  const duration = spec.duration ?? (spec.animate ? choreographyDuration(spec.animate) : 0);
  const loop = spec.duration !== undefined ? Math.max(0.1, spec.duration) : duration > 0 ? duration + END_HOLD_SECONDS : 1;
  const posterTime = spec.posterTime ?? (spec.animate ? choreographyRestTime(spec.animate) : 0);
  const doc = previewDocumentOf(graphNodes(graph), anim.snapshot(), {
    rootId,
    width: spec.width,
    height: spec.height,
    background: spec.background ?? '#0e0e12',
    durationSeconds: Math.max(60, loop + 1),
  });
  return { doc, duration, loop, posterTime };
}

// ── Pictures (posters and flipbooks), remembered per item ────────────────────

/** Long side of a poster / a flipbook frame, in px. A card is ~250–320 CSS px wide. */
const POSTER_SIZE = 480;
const FRAME_SIZE = 320;
/** Flipbook rate, and the most frames one card's loop is cut into (a longer loop plays at a lower rate). */
const FLIPBOOK_FPS = 20;
const MAX_FLIPBOOK_FRAMES = 80;
/** How many items' pictures are kept (posters ~0.5 MB each; a flipbook ~0.23 MB a frame, typically 20–30 frames). */
const MAX_POSTERS = 64;
const MAX_FLIPBOOKS = 3;

interface Flipbook {
  /** The choreography cut evenly: frame 0 its start, the last one its end pose; null until it has arrived. */
  frames: Array<ImageBitmap | null>;
  /** The next frame to ask for; `frames.length` once every frame was asked. */
  next: number;
  asking: boolean;
}

interface Pictures {
  poster: ImageBitmap | null;
  posterAsked: boolean;
  flipbook: Flipbook | null;
}

const posters = new Map<string, ImageBitmap>();
const flipbooks = new Map<string, Flipbook>();

function closeBitmap(b: ImageBitmap | null | undefined): void {
  try {
    b?.close();
  } catch {
    /* already closed */
  }
}

function rememberPoster(key: string, b: ImageBitmap): void {
  const old = posters.get(key);
  if (old && old !== b) closeBitmap(old);
  posters.delete(key);
  posters.set(key, b);
  while (posters.size > MAX_POSTERS) {
    const oldest = posters.keys().next();
    if (oldest.done) break;
    const dropped = posters.get(oldest.value);
    posters.delete(oldest.value);
    // A mounted card may still show it: that card asks again when next painted.
    for (const inst of instances) {
      if (inst.pictures.poster !== dropped) continue;
      inst.pictures.poster = null;
      inst.pictures.posterAsked = false;
    }
    closeBitmap(dropped);
  }
}

/** The remembered poster of `key`, refreshed as the most recently used. */
function recallPoster(key: string): ImageBitmap | null {
  const hit = posters.get(key);
  if (!hit) return null;
  posters.delete(key);
  posters.set(key, hit);
  return hit;
}

function rememberFlipbook(key: string, f: Flipbook): void {
  flipbooks.delete(key);
  flipbooks.set(key, f);
  while (flipbooks.size > MAX_FLIPBOOKS) {
    const oldest = flipbooks.keys().next();
    if (oldest.done) break;
    const dropped = flipbooks.get(oldest.value);
    flipbooks.delete(oldest.value);
    // A mounted card may still hold it: it then re-renders on its next hover.
    for (const inst of instances) if (inst.pictures.flipbook === dropped) inst.pictures.flipbook = null;
    for (const b of dropped?.frames ?? []) closeBitmap(b);
  }
}

async function toBitmap(blob: Blob | null): Promise<ImageBitmap | null> {
  if (!blob || typeof createImageBitmap === 'undefined') return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

// ── Instances ────────────────────────────────────────────────────────────────

interface Instance {
  canvas: HTMLCanvasElement;
  /** The recipe, kept so the build can be deferred off the mount path. */
  source: PreviewSpec;
  background: string;
  /** Null until the card first becomes visible — see `ensureBuilt`. */
  scene: PreviewScene | null;
  pictures: Pictures;
  visible: boolean;
  /** The pointer is over the card, or it has keyboard focus: it plays. */
  active: boolean;
  /** When the current play started (performance.now()). */
  playStart: number;
  /** The canvas needs repainting (a picture arrived, it was resized, play ended). */
  dirty: boolean;
  /** The picture the canvas shows now (a playing card repaints only when its frame changes). */
  painted: ImageBitmap | null;
  alive: boolean;
  lastW: number;
  lastH: number;
  unlisten: () => void;
}

const instances = new Set<Instance>();
const byCanvas = new WeakMap<Element, Instance>();
let raf = 0;
let lastPlayTick = 0;
let intersection: IntersectionObserver | null = null;
let resize: ResizeObserver | null = null;

function ensureBuilt(inst: Instance): PreviewScene {
  if (!inst.scene) inst.scene = buildPreviewScene(inst.source);
  return inst.scene;
}

/** Same slack the IntersectionObserver uses, so both agree on "near enough". */
const VIEWPORT_MARGIN = 120;

/**
 * Is this canvas on (or near) screen RIGHT NOW — answered synchronously.
 *
 * The IntersectionObserver is the steady-state source of truth, but its first
 * callback is ASYNC. Seeding a card's visibility from it means the card cannot
 * paint until that callback lands, and if it never lands — the element had no
 * box when observed, the panel was hidden at mount, the callback was missed —
 * the card stays empty forever. A direct geometry read has no such failure mode.
 */
function isOnScreen(canvas: HTMLCanvasElement): boolean {
  if (typeof window === 'undefined' || typeof canvas.getBoundingClientRect !== 'function') return true;
  const r = canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return (
    r.bottom >= -VIEWPORT_MARGIN &&
    r.right >= -VIEWPORT_MARGIN &&
    r.top <= (window.innerHeight || 0) + VIEWPORT_MARGIN &&
    r.left <= (window.innerWidth || 0) + VIEWPORT_MARGIN
  );
}

function ensureObservers(): void {
  if (!intersection && typeof IntersectionObserver !== 'undefined') {
    intersection = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const inst = byCanvas.get(e.target);
          if (!inst) continue;
          inst.visible = e.isIntersecting;
          if (inst.visible) inst.dirty = true;
        }
        schedule();
      },
      { rootMargin: `${VIEWPORT_MARGIN}px` },
    );
  }
  if (!resize && typeof ResizeObserver !== 'undefined') {
    // A card that got its box after mount (its panel opened) or changed size.
    resize = new ResizeObserver((entries) => {
      for (const e of entries) {
        const inst = byCanvas.get(e.target);
        if (!inst) continue;
        if (!inst.visible) inst.visible = isOnScreen(inst.canvas);
        inst.dirty = true;
      }
      schedule();
    });
  }
}

function dprCap(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(2, dpr);
}

/** Ask for the card's poster once; it repaints when the still lands. */
function askPoster(inst: Instance): void {
  const p = inst.pictures;
  if (p.poster || p.posterAsked) return;
  p.posterAsked = true;
  const scene = ensureBuilt(inst);
  void previewStill(scene.doc, scene.posterTime, POSTER_SIZE, { priority: 'poster', wanted: () => inst.alive })
    .then(toBitmap)
    .then((bitmap) => {
      if (!bitmap) return; // no picture: the card keeps its background (the engine could not draw it)
      const key = inst.source.cacheKey;
      if (key) rememberPoster(key, bitmap);
      else if (!inst.alive) { closeBitmap(bitmap); return; }
      p.poster = bitmap;
      inst.dirty = true;
      schedule();
    });
}

/** Ask for the flipbook's next missing frame while the card is being played; one request at a time. */
function askFrames(inst: Instance): void {
  const scene = ensureBuilt(inst);
  if (scene.duration <= 0) return; // a static scene: the poster is the whole preview
  const key = inst.source.cacheKey;
  let book = inst.pictures.flipbook;
  if (!book) {
    const count = Math.min(MAX_FLIPBOOK_FRAMES, Math.max(2, Math.ceil(scene.duration * FLIPBOOK_FPS) + 1));
    book = { frames: new Array<ImageBitmap | null>(count).fill(null), next: 0, asking: false };
    inst.pictures.flipbook = book;
    if (key) rememberFlipbook(key, book);
  }
  if (book.asking || book.next >= book.frames.length) return;
  const b = book;
  const index = b.next;
  b.asking = true;
  // Spread over the whole choreography, the last frame exactly its end pose.
  const t = b.frames.length > 1 ? (scene.duration * index) / (b.frames.length - 1) : 0;
  const stillWanted = (): boolean => inst.alive && inst.active && inst.pictures.flipbook === b;
  void previewStill(scene.doc, t, FRAME_SIZE, { priority: 'frame', wanted: stillWanted })
    .then(toBitmap)
    .then((bitmap) => {
      b.asking = false;
      if (inst.pictures.flipbook !== b && !(key && flipbooks.get(key) === b)) { closeBitmap(bitmap); return; }
      if (!bitmap) return; // dropped (the pointer left) or failed: asked again on the next hover
      b.frames[index] = bitmap;
      b.next = index + 1;
      if (inst.alive && inst.active) askFrames(inst);
      schedule();
    });
}

/** The flipbook frame for second `t` of the loop: the newest arrived frame at or before it. */
function frameAt(book: Flipbook, scene: PreviewScene, t: number): ImageBitmap | null {
  const last = book.frames.length - 1;
  const at = scene.duration > 0 ? Math.min(last, Math.floor((Math.min(t, scene.duration) / scene.duration) * last + 1e-6)) : 0;
  for (let i = at; i >= 0; i--) {
    const f = book.frames[i];
    if (f) return f;
  }
  return null;
}

function paint(inst: Instance, now: number): void {
  const canvas = inst.canvas;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;
  const dpr = dprCap();
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  let force = inst.dirty;
  inst.dirty = false;
  if (w !== inst.lastW || h !== inst.lastH) {
    canvas.width = w;
    canvas.height = h;
    inst.lastW = w;
    inst.lastH = h;
    force = true;
  }
  // First visible frame pays for the build; every later one is a no-op.
  const scene = ensureBuilt(inst);
  askPoster(inst);

  let picture: ImageBitmap | null = null;
  if (inst.active && inst.pictures.flipbook) {
    const elapsed = (now - inst.playStart) / 1000;
    picture = frameAt(inst.pictures.flipbook, scene, elapsed % scene.loop);
  }
  picture ??= inst.pictures.poster;
  if (!force && picture === inst.painted) return;
  inst.painted = picture;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (!isTransparentColor(inst.background)) {
    ctx.fillStyle = inst.background;
    ctx.fillRect(0, 0, w, h);
  }
  if (!picture) return;
  // Contain-fit, centred: the still has the composition's aspect.
  const s = Math.min(w / picture.width, h / picture.height);
  const dw = picture.width * s;
  const dh = picture.height * s;
  ctx.drawImage(picture, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

const PLAY_FRAME_MS = 1000 / 30;

function tick(now: number): void {
  raf = 0;
  let playing = false;
  const playDue = now - lastPlayTick >= PLAY_FRAME_MS;
  for (const inst of instances) {
    if (!inst.visible) continue;
    const plays = inst.active && !!inst.pictures.flipbook;
    if (plays) playing = true;
    if (!inst.dirty && !(plays && playDue)) continue;
    try {
      paint(inst, now);
    } catch {
      /* a bad frame must not kill the shared loop */
    }
  }
  if (playDue) lastPlayTick = now;
  if (playing) schedule();
}

function schedule(): void {
  if (raf || typeof requestAnimationFrame === 'undefined') return;
  raf = requestAnimationFrame(tick);
}

/** How often a card that has no box yet re-checks its own geometry (ms) — only where there is no ResizeObserver. */
const REVIVE_INTERVAL_MS = 250;
let reviveTimer: ReturnType<typeof setInterval> | null = null;

function startRevive(): void {
  if (reviveTimer || typeof ResizeObserver !== 'undefined') return;
  reviveTimer = setInterval(() => {
    let waiting = false;
    for (const inst of instances) {
      if (inst.visible) continue;
      waiting = true;
      if (isOnScreen(inst.canvas)) {
        inst.visible = true;
        inst.dirty = true;
        schedule();
      }
    }
    if (!waiting || instances.size === 0) stopRevive();
  }, REVIVE_INTERVAL_MS);
}

function stopRevive(): void {
  if (reviveTimer) clearInterval(reviveTimer);
  reviveTimer = null;
}

/** How long the pointer (or focus) rests on a card before it plays (ms). */
const HOVER_INTENT_MS = 120;

/** The element whose hover / focus plays the card: its button, else the canvas. */
function hoverTarget(canvas: HTMLCanvasElement): Element | null {
  if (typeof canvas.closest !== 'function') return typeof canvas.addEventListener === 'function' ? canvas : null;
  return canvas.closest('button, [role="button"], a') ?? canvas;
}

/**
 * Mount a preview onto a card canvas: the engine's poster of the item, playing
 * its loop while the card is hovered or focused. Returns a stop to unmount.
 */
export function mountPreview(canvas: HTMLCanvasElement, spec: PreviewSpec): { stop: () => void } {
  ensureObservers();
  const key = spec.cacheKey;

  // Registration only — the scene and its document are built on the first
  // VISIBLE frame (see ensureBuilt), so opening a gallery costs one object
  // allocation per card instead of a full build per card.
  const inst: Instance = {
    canvas,
    source: spec,
    background: spec.background ?? '#0e0e12',
    scene: null,
    pictures: {
      poster: key ? recallPoster(key) : null,
      posterAsked: false,
      flipbook: key ? flipbooks.get(key) ?? null : null,
    },
    // Seeded SYNCHRONOUSLY from geometry, never from the observer: off-screen
    // cards start paused (opening a gallery neither builds nor asks the engine
    // for the cards below the fold), an on-screen card paints on the next tick.
    visible: isOnScreen(canvas),
    active: false,
    playStart: 0,
    dirty: true,
    painted: null,
    alive: true,
    lastW: 0,
    lastH: 0,
    unlisten: () => undefined,
  };

  const target = hoverTarget(canvas);
  if (target) {
    let intent: ReturnType<typeof setTimeout> | null = null;
    const play = (): void => {
      intent = null;
      if (!inst.alive || inst.active) return;
      inst.active = true;
      inst.playStart = typeof performance !== 'undefined' ? performance.now() : 0;
      if (key && inst.pictures.flipbook) rememberFlipbook(key, inst.pictures.flipbook);
      if (inst.visible) askFrames(inst);
      schedule();
    };
    // After a beat, so a pointer crossing the list (scrolling it) starts nothing.
    const start = (): void => {
      if (inst.active || intent !== null) return;
      intent = setTimeout(play, HOVER_INTENT_MS);
    };
    const end = (): void => {
      if (intent !== null) clearTimeout(intent);
      intent = null;
      if (!inst.active) return;
      inst.active = false;
      inst.dirty = true; // back to the poster
      schedule();
    };
    target.addEventListener('pointerenter', start);
    target.addEventListener('pointerleave', end);
    target.addEventListener('focus', start);
    target.addEventListener('blur', end);
    inst.unlisten = () => {
      if (intent !== null) clearTimeout(intent);
      intent = null;
      target.removeEventListener('pointerenter', start);
      target.removeEventListener('pointerleave', end);
      target.removeEventListener('focus', start);
      target.removeEventListener('blur', end);
    };
  }

  instances.add(inst);
  byCanvas.set(canvas, inst);
  if (typeof Element !== 'undefined' && canvas instanceof Element) {
    intersection?.observe(canvas);
    resize?.observe(canvas);
  }
  if (!inst.visible) startRevive();
  schedule();

  return {
    stop: () => {
      inst.alive = false;
      inst.active = false;
      inst.unlisten();
      instances.delete(inst);
      byCanvas.delete(canvas);
      if (typeof Element !== 'undefined' && canvas instanceof Element) {
        intersection?.unobserve(canvas);
        resize?.unobserve(canvas);
      }
      // Pictures of an item with a cache key outlive the mount (bounded above);
      // the others go with it.
      if (!key) {
        closeBitmap(inst.pictures.poster);
        for (const b of inst.pictures.flipbook?.frames ?? []) closeBitmap(b);
      }
      inst.pictures = { poster: null, posterAsked: true, flipbook: null };
      if (instances.size === 0) {
        if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
        raf = 0;
        stopRevive();
      }
    },
  };
}
