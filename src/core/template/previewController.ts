/**
 * Gallery preview controller — one shared render loop for ALL animated cards.
 *
 * Every card would otherwise own an rAF loop; instead a single ticker walks the
 * live instance set at a capped frame rate and redraws each. Cards scrolled out
 * of view are paused by a shared IntersectionObserver, so an arbitrarily large
 * gallery costs only what's visible. Each instance owns an isolated throwaway
 * SceneGraph + a preview AnimationEngine (the choreography replayed in raw
 * seconds), so previews never touch the user's live scene.
 */

import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { drawSnapshot } from './templatePreview';
import { choreographyDuration, type SetKf } from './templates/builders';

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
  width: number;
  height: number;
  background?: string;
  rootId?: string;
}

interface Instance {
  canvas: HTMLCanvasElement;
  /** Null until the card first becomes visible — see `ensureBuilt`. */
  graph: SceneGraph | null;
  anim: AnimationEngine | null;
  /** The recipe, kept so the build can be deferred off the mount path. */
  source: PreviewSpec;
  spec: Required<Pick<PreviewSpec, 'width' | 'height' | 'background' | 'rootId'>>;
  /** Resolved by `ensureBuilt`; meaningless before it runs. */
  duration: number;
  loop: number;
  start: number;
  visible: boolean;
  /** False until the card has drawn at least one frame — see `tick`. */
  everPainted: boolean;
  lastW: number;
  lastH: number;
}

/**
 * Build a card's isolated scene + choreography — the expensive half of a
 * preview, deferred until the card is actually on screen.
 *
 * Doing this in `mountPreview` meant switching to the Library tab paid for
 * EVERY card up front (24 mograph presets ≈ 17 ms of graph construction,
 * keyframe writes and a duplicate `animate` replay for duration), even though
 * only about six fit on screen. Idempotent, so the render loop can call it
 * every frame without thinking.
 */
function ensureBuilt(inst: Instance): void {
  if (inst.graph) return;
  const spec = inst.source;
  const graph = new SceneGraph();
  try {
    spec.build(graph);
  } catch {
    /* leave an empty graph — the card just shows the background */
  }
  const anim = new AnimationEngine();
  const rawSet: SetKf = (id, prop, time, value, ease) =>
    anim.setKeyframe(id, prop, time, value, ease ?? 'easeInOut');
  if (spec.animate) spec.animate(rawSet);
  try {
    spec.decorate?.(anim);
  } catch {
    /* a bad decoration must not kill the card — keyframes still play */
  }
  const duration = spec.duration ?? (spec.animate ? choreographyDuration(spec.animate) : 0);
  inst.graph = graph;
  inst.anim = anim;
  inst.duration = duration;
  // Explicit loop windows (expression loops) restart seamlessly; finite
  // choreographies hold on the final pose, then restart.
  inst.loop = spec.duration !== undefined ? Math.max(0.1, spec.duration) : duration > 0 ? duration + 0.9 : 1;
  // Start the clock when the card first paints, not when it mounted — a card
  // built after scrolling would otherwise jump into the middle of its loop.
  inst.start = typeof performance !== 'undefined' ? performance.now() : 0;
}

const FPS_CAP = 30;
const FRAME_MS = 1000 / FPS_CAP;

const instances = new Set<Instance>();
const byCanvas = new WeakMap<HTMLCanvasElement, Instance>();
let raf = 0;
let lastTick = 0;
let observer: IntersectionObserver | null = null;

function ensureObserver(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver === 'undefined') return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const inst = byCanvas.get(e.target as HTMLCanvasElement);
        if (inst) inst.visible = e.isIntersecting;
      }
    },
    { rootMargin: '120px' },
  );
  return observer;
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
 * the card is frozen forever, showing only its static poster. A direct geometry
 * read has no such failure mode.
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

function dprCap(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(2, dpr);
}

function renderInstance(inst: Instance, now: number): void {
  const canvas = inst.canvas;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;
  // First visible frame pays for the build; every later one is a no-op.
  ensureBuilt(inst);
  if (!inst.graph || !inst.anim) return;
  const dpr = dprCap();
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (w !== inst.lastW || h !== inst.lastH) {
    canvas.width = w;
    canvas.height = h;
    inst.lastW = w;
    inst.lastH = h;
  }
  const elapsed = (now - inst.start) / 1000;
  const t = inst.duration > 0 ? Math.min(elapsed % inst.loop, inst.duration) : 0;
  const snap = buildSnapshot(
    inst.graph, inst.anim, t, undefined, undefined,
    { scale: 1, offsetX: 0, offsetY: 0 }, undefined,
    { rootId: inst.spec.rootId, width: inst.spec.width, height: inst.spec.height, background: inst.spec.background },
  );
  drawSnapshot(canvas, snap, inst.spec.background);
  inst.everPainted = true;
}

/** How often a card that has never painted re-checks its own geometry (ms). */
const REVIVE_INTERVAL_MS = 250;
let lastRevive = 0;

function tick(now: number): void {
  raf = requestAnimationFrame(tick);
  if (now - lastTick < FRAME_MS) return;
  lastTick = now;

  // Self-heal: a card that has NEVER painted is the only one that can be
  // permanently stuck — its poster stays up and it reads as a frozen preview.
  // That happens whenever the observer's verdict never arrives (mounted inside
  // a hidden panel, zero-size at observe time, a missed callback). Re-reading
  // the geometry of just those cards, four times a second, makes the freeze
  // impossible without putting a layout read in the per-frame path for the
  // cards that are working fine.
  const revive = now - lastRevive >= REVIVE_INTERVAL_MS;
  if (revive) lastRevive = now;

  for (const inst of instances) {
    if (!inst.visible) {
      if (!revive || inst.everPainted) continue;
      if (!isOnScreen(inst.canvas)) continue;
      inst.visible = true;
    }
    try {
      renderInstance(inst, now);
    } catch {
      /* a bad frame must not kill the shared loop */
    }
  }
}

function startLoop(): void {
  if (raf || typeof requestAnimationFrame === 'undefined') return;
  raf = requestAnimationFrame(tick);
}

function stopLoopIfIdle(): void {
  if (instances.size === 0 && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

/** Mount a looping preview onto a card canvas. Returns a stop to unmount. */
export function mountPreview(canvas: HTMLCanvasElement, spec: PreviewSpec): { stop: () => void } {
  const rootId = spec.rootId ?? 'tpl_root';
  const observer = ensureObserver();

  // Registration only — the scene, engine and choreography are built on the
  // first VISIBLE frame (see ensureBuilt), so opening a gallery tab costs one
  // object allocation per card instead of a full build per card.
  const inst: Instance = {
    canvas,
    graph: null,
    anim: null,
    source: spec,
    spec: { width: spec.width, height: spec.height, background: spec.background ?? '#0e0e12', rootId },
    duration: 0,
    loop: 1,
    start: typeof performance !== 'undefined' ? performance.now() : 0,
    // Seeded SYNCHRONOUSLY from geometry, never from the observer.
    //
    // Off-screen cards start paused (that is the win — opening a gallery does
    // not render or build the cards below the fold), but an on-screen card
    // paints on the very next tick without waiting for an async callback that
    // might arrive late or never. `tick` re-checks any card that has still not
    // painted, so a card that was hidden or unlaid-out at mount recovers on its
    // own rather than sitting frozen behind its poster image.
    visible: isOnScreen(canvas),
    everPainted: false,
    lastW: 0,
    lastH: 0,
  };
  instances.add(inst);
  byCanvas.set(canvas, inst);
  observer?.observe(canvas);
  startLoop();

  return {
    stop: () => {
      instances.delete(inst);
      byCanvas.delete(canvas);
      observer?.unobserve(canvas);
      stopLoopIfIdle();
    },
  };
}
