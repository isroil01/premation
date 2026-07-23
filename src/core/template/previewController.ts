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
  graph: SceneGraph;
  anim: AnimationEngine;
  spec: Required<Pick<PreviewSpec, 'width' | 'height' | 'background' | 'rootId'>>;
  duration: number;
  loop: number;
  start: number;
  visible: boolean;
  lastW: number;
  lastH: number;
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

function dprCap(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(2, dpr);
}

function renderInstance(inst: Instance, now: number): void {
  const canvas = inst.canvas;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;
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
}

function tick(now: number): void {
  raf = requestAnimationFrame(tick);
  if (now - lastTick < FRAME_MS) return;
  lastTick = now;
  for (const inst of instances) {
    if (!inst.visible) continue;
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

/** Mount a looping preview onto a card canvas. Returns a stop() to unmount. */
export function mountPreview(canvas: HTMLCanvasElement, spec: PreviewSpec): { stop: () => void } {
  const rootId = spec.rootId ?? 'tpl_root';
  const graph = new SceneGraph();
  try {
    spec.build(graph);
  } catch {
    /* leave an empty graph — the card just shows the background */
  }
  const anim = new AnimationEngine();
  const rawSet: SetKf = (id, prop, time, value, ease) => anim.setKeyframe(id, prop, time, value, ease ?? 'easeInOut');
  if (spec.animate) spec.animate(rawSet);
  try {
    spec.decorate?.(anim);
  } catch {
    /* a bad decoration must not kill the card — keyframes still play */
  }
  const duration = spec.duration ?? (spec.animate ? choreographyDuration(spec.animate) : 0);

  const inst: Instance = {
    canvas,
    graph,
    anim,
    spec: { width: spec.width, height: spec.height, background: spec.background ?? '#0e0e12', rootId },
    duration,
    // Explicit loop windows (expression loops) restart seamlessly; finite
    // choreographies hold on the final pose, then restart.
    loop: spec.duration !== undefined ? Math.max(0.1, spec.duration) : duration > 0 ? duration + 0.9 : 1,
    start: typeof performance !== 'undefined' ? performance.now() : 0,
    visible: true,
    lastW: 0,
    lastH: 0,
  };
  instances.add(inst);
  byCanvas.set(canvas, inst);
  ensureObserver()?.observe(canvas);
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
