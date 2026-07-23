/**
 * Motion graphics library — self-contained animated elements (lower thirds,
 * callouts, titles, data widgets, loops) built from engine primitives +
 * keyframes, following the animPresets model exactly: each item authors
 * `build` (static nodes) and `animate` (a SetKf choreography) ONCE, and both
 * the live insert and the panel's animated preview cards replay them — so an
 * inserted element lands looking exactly like its card.
 *
 * Geometry uses only rect / ellipse / text primitives so the Canvas2D gallery
 * previewer (templatePreview.drawSnapshot) renders every design faithfully.
 * Two engine features beyond plain keyframes are used through `decorate`:
 *   • expressions (loopOut / wiggle) for genuinely infinite loops — evaluated
 *     by buildSnapshot in BOTH the live scene and the isolated card engine;
 *   • text.source data keyframes (hold) for animated number counters and
 *     word-swap kinetic type.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController, compToKeyframeTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { addRoot, addText, addGradientShape, radialFill, linearFill, liveKf, choreographyDuration, type SetKf } from '@core/template/templates/builders';
import { mountPreview } from '@core/template/previewController';
import type { SceneNode, Transform } from '@core/types';

export type MographCategory = 'lower-thirds' | 'callouts' | 'titles' | 'data' | 'shapes' | 'loops';

/** Non-keyframe engine writes a design may author: expressions for infinite
 *  loops, and text.source hold keyframes for counters / word swaps. One
 *  implementation targets the live engine, another the isolated card engine. */
export interface MographOps {
  expr: (id: string, prop: string, src: string) => void;
  textKf: (id: string, timeSec: number, value: string) => void;
}

export interface MographItem {
  id: string;
  name: string;
  cat: MographCategory;
  /** Accent colour shown on the card. */
  color: string;
  /** Expression-driven infinite loop — the card shows "Loop" instead of a
   *  finite duration and plays `previewSeconds` seamlessly. */
  loop?: boolean;
  /** Card loop window for `loop` items (seconds). */
  previewSeconds?: number;
  /** Child-id suffixes whose per-layer motion-blur switch is flipped on at
   *  insert (whip/slam moves). Live-scene only — cards render without blur. */
  motionBlurIds?: string[];
  /** Build the static element into `g` under `parent`, centred at (x, y);
   *  `u` scales the authored (720p-reference) size to the target comp. */
  build: (g: SceneGraph, id: string, parent: string, x: number, y: number, u: number) => void;
  /** Keyframe choreography, offset to start at t0 seconds. */
  animate: (set: SetKf, id: string, x: number, y: number, t0: number, u: number) => void;
  /** Optional expression / text-data pass (runs after `animate`). */
  decorate?: (ops: MographOps, id: string, x: number, y: number, t0: number, u: number) => void;
}

/** Reference comp height the items are authored at (matches animPresets). */
const REF_H = 720;
const PREVIEW_W = 1280, PREVIEW_H = 720;

/** Shared palette — dark-glass surfaces + a small disciplined accent set. */
const PAL = {
  ink: '#f4f6fb',
  sub: '#9aa4b8',
  glass: 'rgba(13,15,24,0.90)',
  glassHi: 'rgba(24,27,40,0.92)',
  line: 'rgba(255,255,255,0.16)',
  blue: '#2988ff',
  violet: '#8b5cf6',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#fb7185',
  cyan: '#22d3ee',
} as const;

const tf = (x: number, y: number): Transform => ({ position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } });

/** addShape with rotation + corner radius (builders' addShape has neither). */
function addRect(
  g: SceneGraph, id: string, parent: string, x: number, y: number, w: number, h: number,
  fill: string, opts: { rotation?: number; radius?: number; opacity?: number } = {},
): string {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: opts.rotation ?? 0, width: w, height: h, ...(opts.radius ? { cornerRadius: opts.radius } : {}) } },
      { id: `${id}_s`, type: 'Style', props: { opacity: opts.opacity ?? 100, fill } },
    ],
  } as unknown as SceneNode;
  g.addChild(parent, node);
  return id;
}

function addEllipse(g: SceneGraph, id: string, parent: string, x: number, y: number, w: number, h: number, fill: string, opacity = 100): string {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: w, height: h, shapeType: 'ellipse' } },
      { id: `${id}_s`, type: 'Style', props: { opacity, fill } },
    ],
  } as unknown as SceneNode;
  g.addChild(parent, node);
  return id;
}

// ── Choreography vocabulary ──────────────────────────────────────────

const fadeIn = (set: SetKf, id: string, t: number, over = 0.3): void => {
  set(id, 'opacity', t, 0, 'easeOut'); set(id, 'opacity', t + over, 100, 'easeOut');
};
/** Scale pop with a real overshoot chain (0 → peak → settle). */
const pop = (set: SetKf, id: string, t: number, over = 0.42, peak = 1.14): void => {
  set(id, 'scaleX', t, 0, 'easeOut'); set(id, 'scaleY', t, 0, 'easeOut');
  set(id, 'scaleX', t + over * 0.62, peak, 'easeOut'); set(id, 'scaleY', t + over * 0.62, peak, 'easeOut');
  set(id, 'scaleX', t + over, 1, 'easeInOut'); set(id, 'scaleY', t + over, 1, 'easeInOut');
};
/** Slide up from `from` px below with fade. */
const rise = (set: SetKf, id: string, t: number, y: number, from: number, over = 0.45): void => {
  set(id, 'y', t, y + from, 'easeOut'); set(id, 'y', t + over, y, 'easeOut');
  fadeIn(set, id, t, over * 0.7);
};
/**
 * Draw a horizontal bar on from one end. scaleX and x share the same easing
 * and timing, so `x(t) = anchor + dir·(w/2)·e(t)` while `scaleX = e(t)` — the
 * moving edge stays EXACTLY anchored (no centre-scale wobble).
 * `anchor` is the fixed edge; `dir` +1 grows rightward, −1 leftward.
 */
const growX = (set: SetKf, id: string, t: number, dur: number, anchor: number, w: number, dir: 1 | -1 = 1): void => {
  set(id, 'scaleX', t, 0, 'easeOut'); set(id, 'scaleX', t + dur, 1, 'easeOut');
  set(id, 'x', t, anchor, 'easeOut'); set(id, 'x', t + dur, anchor + dir * (w / 2), 'easeOut');
};
const growY = (set: SetKf, id: string, t: number, dur: number, anchor: number, h: number, dir: 1 | -1 = 1): void => {
  set(id, 'scaleY', t, 0, 'easeOut'); set(id, 'scaleY', t + dur, 1, 'easeOut');
  set(id, 'y', t, anchor, 'easeOut'); set(id, 'y', t + dur, anchor + dir * (h / 2), 'easeOut');
};

const easeOutCubic = (u: number): number => 1 - (1 - u) ** 3;
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Hold-keyframe a counter curve onto a text node (eased, comma-grouped). */
function counterKfs(ops: MographOps, id: string, t0: number, dur: number, target: number, suffix = '', steps = 30): void {
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    ops.textKf(id, t0 + u * dur, fmt(target * easeOutCubic(u)) + suffix);
  }
}

// ── The library ──────────────────────────────────────────────────────

export const MOGRAPH_ITEMS: readonly MographItem[] = [

  // ═══ Lower thirds ══════════════════════════════════════════════════
  {
    id: 'mg-lower-line', name: 'Minimal Line', cat: 'lower-thirds', color: PAL.blue,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_rule`, parent, x, y + 24 * u, 380 * u, 2.5 * u, PAL.ink, { radius: 1 * u });
      addRect(g, `${id}_dot`, parent, x - 190 * u, y + 24 * u, 9 * u, 9 * u, PAL.blue, { radius: 4.5 * u });
      addText(g, `${id}_name`, parent, 'Name Surname', x - 178 * u, y - 8 * u, 32 * u, 700, PAL.ink, 'left');
      addText(g, `${id}_role`, parent, 'Title / Role', x - 178 * u, y + 48 * u, 17 * u, 500, PAL.sub, 'left');
    },
    animate: (set, id, x, y, t0, u) => {
      growX(set, `${id}_rule`, t0, 0.5, x - 190 * u, 380 * u, 1);
      pop(set, `${id}_dot`, t0 + 0.05, 0.3, 1.5);
      rise(set, `${id}_name`, t0 + 0.22, y - 8 * u, 26 * u, 0.5);
      rise(set, `${id}_role`, t0 + 0.42, y + 48 * u, 18 * u, 0.45);
    },
  },
  {
    id: 'mg-lower-glass', name: 'Glass Panel', cat: 'lower-thirds', color: PAL.cyan,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_bar`, parent, x, y, 500 * u, 96 * u, PAL.glass, { radius: 14 * u });
      addRect(g, `${id}_edge`, parent, x - 238 * u, y, 5 * u, 68 * u, PAL.cyan, { radius: 2.5 * u });
      addText(g, `${id}_name`, parent, 'Name Surname', x - 214 * u, y - 15 * u, 30 * u, 700, PAL.ink, 'left');
      addText(g, `${id}_role`, parent, 'Title / Role', x - 214 * u, y + 21 * u, 17 * u, 500, PAL.sub, 'left');
      addGradientShape(g, `${id}_shine`, parent, x - 180 * u, y, 90 * u, 96 * u,
        linearFill(0, [[0, 'rgba(255,255,255,0)'], [0.5, 'rgba(255,255,255,0.18)'], [1, 'rgba(255,255,255,0)']]), 0);
    },
    animate: (set, id, x, y, t0, u) => {
      growX(set, `${id}_bar`, t0, 0.45, x - 250 * u, 500 * u, 1);
      fadeIn(set, `${id}_bar`, t0, 0.2);
      growY(set, `${id}_edge`, t0 + 0.3, 0.3, y + 34 * u, 68 * u, -1);
      set(`${id}_name`, 'x', t0 + 0.3, x - 246 * u, 'easeOut'); set(`${id}_name`, 'x', t0 + 0.75, x - 214 * u, 'easeOut');
      fadeIn(set, `${id}_name`, t0 + 0.3, 0.3);
      set(`${id}_role`, 'x', t0 + 0.44, x - 246 * u, 'easeOut'); set(`${id}_role`, 'x', t0 + 0.88, x - 214 * u, 'easeOut');
      fadeIn(set, `${id}_role`, t0 + 0.44, 0.3);
      // Shine sweep across the glass once the panel has landed.
      set(`${id}_shine`, 'x', t0 + 0.8, x - 230 * u, 'easeInOut'); set(`${id}_shine`, 'x', t0 + 1.35, x + 230 * u, 'easeInOut');
      set(`${id}_shine`, 'opacity', t0 + 0.8, 0, 'easeInOut'); set(`${id}_shine`, 'opacity', t0 + 1.0, 100, 'easeInOut');
      set(`${id}_shine`, 'opacity', t0 + 1.35, 0, 'easeInOut');
    },
  },
  {
    id: 'mg-lower-stack', name: 'Stacked Blocks', cat: 'lower-thirds', color: PAL.violet,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_top`, parent, x - 20 * u, y - 26 * u, 400 * u, 56 * u, PAL.violet, { radius: 8 * u });
      addRect(g, `${id}_bot`, parent, x, y + 26 * u, 440 * u, 44 * u, PAL.glass, { radius: 8 * u });
      addText(g, `${id}_name`, parent, 'NAME SURNAME', x - 200 * u, y - 26 * u, 28 * u, 800, '#0d0f18', 'left');
      addText(g, `${id}_role`, parent, 'Title / Role — Organisation', x - 200 * u, y + 26 * u, 17 * u, 500, PAL.sub, 'left');
    },
    animate: (set, id, x, _y, t0, u) => {
      set(`${id}_top`, 'x', t0, x - 20 * u - 520 * u, 'easeOut');
      set(`${id}_top`, 'x', t0 + 0.42, x - 8 * u, 'easeOut');
      set(`${id}_top`, 'x', t0 + 0.56, x - 20 * u, 'easeInOut');
      fadeIn(set, `${id}_top`, t0, 0.22);
      set(`${id}_bot`, 'x', t0 + 0.12, x + 520 * u, 'easeOut');
      set(`${id}_bot`, 'x', t0 + 0.54, x - 12 * u, 'easeOut');
      set(`${id}_bot`, 'x', t0 + 0.68, x, 'easeInOut');
      fadeIn(set, `${id}_bot`, t0 + 0.12, 0.22);
      fadeIn(set, `${id}_name`, t0 + 0.4, 0.3);
      fadeIn(set, `${id}_role`, t0 + 0.55, 0.3);
    },
  },
  {
    id: 'mg-lower-tab', name: 'Corner Tab', cat: 'lower-thirds', color: PAL.amber,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_tab`, parent, x - 218 * u, y - 54 * u, 84 * u, 30 * u, PAL.amber, { radius: 6 * u });
      addText(g, `${id}_tag`, parent, 'GUEST', x - 218 * u, y - 54 * u, 15 * u, 800, '#0d0f18');
      addRect(g, `${id}_panel`, parent, x, y, 460 * u, 78 * u, PAL.glass, { radius: 10 * u });
      addText(g, `${id}_name`, parent, 'Name Surname', x - 210 * u, y - 12 * u, 28 * u, 700, PAL.ink, 'left');
      addText(g, `${id}_role`, parent, 'Title / Role', x - 210 * u, y + 20 * u, 16 * u, 500, PAL.sub, 'left');
    },
    animate: (set, id, x, y, t0, u) => {
      // Tab drops in with a bounce…
      set(`${id}_tab`, 'y', t0, y - 130 * u, 'easeIn');
      set(`${id}_tab`, 'y', t0 + 0.26, y - 48 * u, 'easeOut');
      set(`${id}_tab`, 'y', t0 + 0.4, y - 54 * u, 'easeInOut');
      fadeIn(set, `${id}_tab`, t0, 0.16);
      fadeIn(set, `${id}_tag`, t0 + 0.18, 0.2);
      // …then the panel unrolls out of it.
      growX(set, `${id}_panel`, t0 + 0.34, 0.4, x - 230 * u, 460 * u, 1);
      fadeIn(set, `${id}_panel`, t0 + 0.34, 0.18);
      fadeIn(set, `${id}_name`, t0 + 0.62, 0.3);
      fadeIn(set, `${id}_role`, t0 + 0.74, 0.3);
    },
  },
  {
    id: 'mg-lower-social', name: 'Handle Bar', cat: 'lower-thirds', color: PAL.rose,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_pill`, parent, x, y, 380 * u, 64 * u, PAL.glassHi, { radius: 32 * u });
      addEllipse(g, `${id}_ring`, parent, x - 158 * u, y, 44 * u, 44 * u, 'rgba(251,113,133,0.35)');
      addEllipse(g, `${id}_icon`, parent, x - 158 * u, y, 36 * u, 36 * u, PAL.rose);
      addText(g, `${id}_at`, parent, '@', x - 158 * u, y - 1 * u, 22 * u, 800, '#0d0f18');
      addText(g, `${id}_handle`, parent, 'yourhandle', x - 122 * u, y, 24 * u, 700, PAL.ink, 'left');
    },
    animate: (set, id, x, _y, t0, u) => {
      growX(set, `${id}_pill`, t0, 0.4, x - 190 * u, 380 * u, 1);
      fadeIn(set, `${id}_pill`, t0, 0.2);
      pop(set, `${id}_icon`, t0 + 0.24, 0.34, 1.2);
      fadeIn(set, `${id}_at`, t0 + 0.4, 0.2);
      // Ring ripple off the icon.
      set(`${id}_ring`, 'scaleX', t0 + 0.5, 1, 'easeOut'); set(`${id}_ring`, 'scaleY', t0 + 0.5, 1, 'easeOut');
      set(`${id}_ring`, 'scaleX', t0 + 1.0, 2.1, 'easeOut'); set(`${id}_ring`, 'scaleY', t0 + 1.0, 2.1, 'easeOut');
      set(`${id}_ring`, 'opacity', t0 + 0.5, 90, 'easeOut'); set(`${id}_ring`, 'opacity', t0 + 1.0, 0, 'easeOut');
      set(`${id}_handle`, 'x', t0 + 0.34, x - 150 * u, 'easeOut'); set(`${id}_handle`, 'x', t0 + 0.72, x - 122 * u, 'easeOut');
      fadeIn(set, `${id}_handle`, t0 + 0.34, 0.28);
    },
  },

  // ═══ Callouts ══════════════════════════════════════════════════════
  {
    id: 'mg-callout-bubble', name: 'Chat Pop', cat: 'callouts', color: PAL.emerald,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_box`, parent, x, y, 320 * u, 104 * u, PAL.emerald, { radius: 22 * u });
      addRect(g, `${id}_tail`, parent, x - 110 * u, y + 56 * u, 30 * u, 30 * u, PAL.emerald, { rotation: 45, radius: 5 * u });
      for (let i = 0; i < 3; i++) addEllipse(g, `${id}_d${i}`, parent, x + (i - 1) * 30 * u, y, 13 * u, 13 * u, 'rgba(8,19,14,0.75)');
      addText(g, `${id}_txt`, parent, 'Sounds good!', x, y, 26 * u, 700, '#08130e');
    },
    animate: (set, id, _x, _y, t0) => {
      pop(set, `${id}_box`, t0, 0.4, 1.1);
      pop(set, `${id}_tail`, t0 + 0.12, 0.3, 1.15);
      // Typing dots pulse twice, then hand off to the message.
      for (let i = 0; i < 3; i++) {
        const d = `${id}_d${i}`, ph = t0 + 0.3 + i * 0.12;
        set(d, 'opacity', t0, 0, 'easeOut'); set(d, 'opacity', t0 + 0.28, 40, 'easeOut');
        for (let c = 0; c < 2; c++) {
          set(d, 'opacity', ph + c * 0.45, 100, 'easeInOut');
          set(d, 'opacity', ph + c * 0.45 + 0.24, 35, 'easeInOut');
        }
        set(d, 'opacity', t0 + 1.35, 0, 'easeIn');
        set(d, 'scaleY', ph, 1, 'easeInOut'); set(d, 'scaleY', ph + 0.12, 1.35, 'easeInOut'); set(d, 'scaleY', ph + 0.24, 1, 'easeInOut');
      }
      set(`${id}_txt`, 'opacity', t0, 0, 'easeOut'); set(`${id}_txt`, 'opacity', t0 + 1.38, 0, 'easeOut');
      set(`${id}_txt`, 'opacity', t0 + 1.55, 100, 'easeOut');
      set(`${id}_txt`, 'scaleX', t0 + 1.38, 0.8, 'easeOut'); set(`${id}_txt`, 'scaleY', t0 + 1.38, 0.8, 'easeOut');
      set(`${id}_txt`, 'scaleX', t0 + 1.62, 1, 'easeOut'); set(`${id}_txt`, 'scaleY', t0 + 1.62, 1, 'easeOut');
    },
  },
  {
    id: 'mg-callout-arrow', name: 'Arrow Point', cat: 'callouts', color: PAL.rose,
    build: (g, id, parent, x, y, u) => {
      // Shaft grows LEFTWARD toward the target point; arrowhead lands there.
      addRect(g, `${id}_shaft`, parent, x, y, 220 * u, 7 * u, PAL.rose, { radius: 3.5 * u });
      addRect(g, `${id}_headA`, parent, x - 122 * u, y - 12 * u, 42 * u, 7 * u, PAL.rose, { radius: 3.5 * u, rotation: 35 });
      addRect(g, `${id}_headB`, parent, x - 122 * u, y + 12 * u, 42 * u, 7 * u, PAL.rose, { radius: 3.5 * u, rotation: -35 });
      addRect(g, `${id}_lbl`, parent, x + 176 * u, y, 150 * u, 46 * u, PAL.glass, { radius: 10 * u });
      addText(g, `${id}_txt`, parent, 'Look here', x + 176 * u, y, 21 * u, 700, PAL.ink);
    },
    animate: (set, id, x, _y, t0, u) => {
      fadeIn(set, `${id}_lbl`, t0, 0.25);
      fadeIn(set, `${id}_txt`, t0 + 0.1, 0.25);
      growX(set, `${id}_shaft`, t0 + 0.15, 0.4, x + 110 * u, 220 * u, -1);
      pop(set, `${id}_headA`, t0 + 0.5, 0.26, 1.25);
      pop(set, `${id}_headB`, t0 + 0.5, 0.26, 1.25);
    },
  },
  {
    id: 'mg-callout-pin', name: 'Marker Pin', cat: 'callouts', color: PAL.blue,
    build: (g, id, parent, x, y, u) => {
      addEllipse(g, `${id}_rippleA`, parent, x, y, 70 * u, 70 * u, 'rgba(41,136,255,0.35)');
      addEllipse(g, `${id}_rippleB`, parent, x, y, 70 * u, 70 * u, 'rgba(41,136,255,0.25)');
      addEllipse(g, `${id}_disc`, parent, x, y, 62 * u, 62 * u, PAL.blue);
      addText(g, `${id}_num`, parent, '1', x, y - 1 * u, 30 * u, 800, '#ffffff');
      addText(g, `${id}_lbl`, parent, 'First stop', x, y + 58 * u, 19 * u, 600, PAL.sub);
    },
    animate: (set, id, _x, y, t0, u) => {
      // Drop with a squash on landing.
      set(`${id}_disc`, 'y', t0, y - 120 * u, 'easeIn'); set(`${id}_disc`, 'y', t0 + 0.24, y, 'easeIn');
      set(`${id}_disc`, 'scaleY', t0 + 0.24, 1, 'easeOut'); set(`${id}_disc`, 'scaleY', t0 + 0.32, 0.72, 'easeOut'); set(`${id}_disc`, 'scaleY', t0 + 0.46, 1, 'easeOut');
      fadeIn(set, `${id}_disc`, t0, 0.15);
      set(`${id}_num`, 'y', t0, y - 121 * u, 'easeIn'); set(`${id}_num`, 'y', t0 + 0.24, y - 1 * u, 'easeIn');
      fadeIn(set, `${id}_num`, t0, 0.15);
      // Two staggered ripple rings.
      for (const [suffix, dt] of [['_rippleA', 0.3], ['_rippleB', 0.55]] as const) {
        const r = `${id}${suffix}`;
        set(r, 'scaleX', t0 + dt, 0.8, 'easeOut'); set(r, 'scaleY', t0 + dt, 0.8, 'easeOut');
        set(r, 'scaleX', t0 + dt + 0.7, 2.6, 'easeOut'); set(r, 'scaleY', t0 + dt + 0.7, 2.6, 'easeOut');
        set(r, 'opacity', t0 + dt, 90, 'easeOut'); set(r, 'opacity', t0 + dt + 0.7, 0, 'easeOut');
      }
      rise(set, `${id}_lbl`, t0 + 0.4, y + 58 * u, 14 * u, 0.4);
    },
  },
  {
    id: 'mg-callout-focus', name: 'Focus Frame', cat: 'callouts', color: PAL.violet,
    build: (g, id, parent, x, y, u) => {
      const w = 330 * u, h = 190 * u, t = 5 * u;
      addRect(g, `${id}_top`, parent, x, y - h / 2, w, t, PAL.violet, { radius: 2.5 * u });
      addRect(g, `${id}_rgt`, parent, x + w / 2, y, t, h, PAL.violet, { radius: 2.5 * u });
      addRect(g, `${id}_bot`, parent, x, y + h / 2, w, t, PAL.violet, { radius: 2.5 * u });
      addRect(g, `${id}_lft`, parent, x - w / 2, y, t, h, PAL.violet, { radius: 2.5 * u });
      addRect(g, `${id}_fill`, parent, x, y, w, h, 'rgba(139,92,246,0.12)');
      // Corner ticks give the frame a camera-focus read.
      for (const [sfx, dx, dy] of [['_ca', -1, -1], ['_cb', 1, -1], ['_cc', 1, 1], ['_cd', -1, 1]] as const) {
        addRect(g, `${id}${sfx}`, parent, x + dx * (w / 2 + 16 * u), y + dy * (h / 2 + 16 * u), 14 * u, 14 * u, PAL.ink, { radius: 3 * u, rotation: 45 });
      }
    },
    animate: (set, id, x, y, t0, u) => {
      const w = 330 * u, h = 190 * u;
      // Edges draw clockwise, each anchored at the corner it starts from.
      growX(set, `${id}_top`, t0, 0.22, x - w / 2, w, 1);
      growY(set, `${id}_rgt`, t0 + 0.22, 0.22, y - h / 2, h, 1);
      growX(set, `${id}_bot`, t0 + 0.44, 0.22, x + w / 2, w, -1);
      growY(set, `${id}_lft`, t0 + 0.66, 0.22, y + h / 2, h, -1);
      set(`${id}_fill`, 'opacity', t0, 0, 'easeInOut'); set(`${id}_fill`, 'opacity', t0 + 0.85, 0, 'easeInOut');
      set(`${id}_fill`, 'opacity', t0 + 1.1, 100, 'easeInOut'); set(`${id}_fill`, 'opacity', t0 + 1.6, 45, 'easeInOut');
      ([['_ca', 0], ['_cb', 1], ['_cc', 2], ['_cd', 3]] as const).forEach(([sfx, i]) => {
        pop(set, `${id}${sfx}`, t0 + 0.9 + i * 0.07, 0.24, 1.3);
      });
    },
  },

  // ═══ Titles ════════════════════════════════════════════════════════
  {
    id: 'mg-title-slam', name: 'Slam Title', cat: 'titles', color: PAL.amber,
    motionBlurIds: ['_word'],
    build: (g, id, parent, x, y, u) => {
      addText(g, `${id}_word`, parent, 'IMPACT', x, y - 8 * u, 84 * u, 900, PAL.ink);
      addRect(g, `${id}_shockL`, parent, x - 190 * u, y + 52 * u, 130 * u, 5 * u, PAL.amber, { radius: 2.5 * u });
      addRect(g, `${id}_shockR`, parent, x + 190 * u, y + 52 * u, 130 * u, 5 * u, PAL.amber, { radius: 2.5 * u });
      addText(g, `${id}_sub`, parent, 'HITS THE FRAME', x, y + 62 * u, 20 * u, 700, PAL.sub);
    },
    animate: (set, id, x, _y, t0, u) => {
      // Slam: 3.2× → 1 fast easeIn, then a tiny settle bounce.
      set(`${id}_word`, 'scaleX', t0, 3.2, 'easeIn'); set(`${id}_word`, 'scaleY', t0, 3.2, 'easeIn');
      set(`${id}_word`, 'scaleX', t0 + 0.26, 1, 'easeIn'); set(`${id}_word`, 'scaleY', t0 + 0.26, 1, 'easeIn');
      set(`${id}_word`, 'scaleX', t0 + 0.36, 1.05, 'easeOut'); set(`${id}_word`, 'scaleY', t0 + 0.36, 1.05, 'easeOut');
      set(`${id}_word`, 'scaleX', t0 + 0.48, 1, 'easeInOut'); set(`${id}_word`, 'scaleY', t0 + 0.48, 1, 'easeInOut');
      set(`${id}_word`, 'opacity', t0, 0, 'easeIn'); set(`${id}_word`, 'opacity', t0 + 0.18, 100, 'easeIn');
      // Shockwave lines burst outward at impact.
      for (const [sfx, dir] of [['_shockL', -1], ['_shockR', 1]] as const) {
        const s = `${id}${sfx}`;
        set(s, 'x', t0 + 0.26, x + dir * 120 * u, 'easeOut'); set(s, 'x', t0 + 0.66, x + dir * 210 * u, 'easeOut');
        set(s, 'scaleX', t0 + 0.26, 0.2, 'easeOut'); set(s, 'scaleX', t0 + 0.55, 1, 'easeOut');
        set(s, 'opacity', t0 + 0.26, 100, 'easeOut'); set(s, 'opacity', t0 + 0.7, 0, 'easeOut');
      }
      rise(set, `${id}_sub`, t0 + 0.42, _y + 62 * u, 18 * u, 0.45);
    },
  },
  {
    id: 'mg-title-track', name: 'Tracking Reveal', cat: 'titles', color: PAL.cyan,
    build: (g, id, parent, x, y, u) => {
      const word = 'MOTION';
      const adv = 52 * u;
      const x0 = x - ((word.length - 1) / 2) * adv;
      for (let i = 0; i < word.length; i++) {
        addText(g, `${id}_l${i}`, parent, word[i]!, x0 + i * adv, y - 6 * u, 66 * u, 900, PAL.ink);
      }
      addRect(g, `${id}_rule`, parent, x, y + 48 * u, 340 * u, 3 * u, PAL.cyan, { radius: 1.5 * u });
      addText(g, `${id}_kick`, parent, 'DESIGN IN', x, y - 66 * u, 18 * u, 700, PAL.sub);
    },
    animate: (set, id, x, y, t0, u) => {
      const word = 'MOTION';
      const adv = 52 * u;
      const x0 = x - ((word.length - 1) / 2) * adv;
      for (let i = 0; i < word.length; i++) {
        const l = `${id}_l${i}`;
        const home = x0 + i * adv;
        const off = (home - x) * 2.4; // letters converge from a wide spread
        set(l, 'x', t0, x + off, 'easeOut'); set(l, 'x', t0 + 0.7, home, 'easeOut');
        fadeIn(set, l, t0 + i * 0.03, 0.4);
      }
      growX(set, `${id}_rule`, t0 + 0.5, 0.45, x - 170 * u, 340 * u, 1);
      set(`${id}_kick`, 'y', t0 + 0.3, y - 52 * u, 'easeOut'); set(`${id}_kick`, 'y', t0 + 0.7, y - 66 * u, 'easeOut');
      fadeIn(set, `${id}_kick`, t0 + 0.3, 0.35);
    },
  },
  {
    id: 'mg-title-split', name: 'Split Duo', cat: 'titles', color: PAL.violet,
    build: (g, id, parent, x, y, u) => {
      addText(g, `${id}_kick`, parent, 'PRESENTING', x, y - 74 * u, 17 * u, 700, PAL.sub);
      addText(g, `${id}_top`, parent, 'KINETIC', x, y - 26 * u, 62 * u, 900, PAL.ink);
      addText(g, `${id}_bot`, parent, 'TITLES', x, y + 38 * u, 62 * u, 900, PAL.violet);
      addRect(g, `${id}_rule`, parent, x, y + 6 * u, 340 * u, 4 * u, PAL.violet, { radius: 2 * u });
    },
    animate: (set, id, x, y, t0, u) => {
      set(`${id}_top`, 'x', t0, x - 300 * u, 'easeOut'); set(`${id}_top`, 'x', t0 + 0.5, x + 10 * u, 'easeOut'); set(`${id}_top`, 'x', t0 + 0.64, x, 'easeInOut');
      fadeIn(set, `${id}_top`, t0, 0.3);
      set(`${id}_bot`, 'x', t0 + 0.12, x + 300 * u, 'easeOut'); set(`${id}_bot`, 'x', t0 + 0.62, x - 10 * u, 'easeOut'); set(`${id}_bot`, 'x', t0 + 0.76, x, 'easeInOut');
      fadeIn(set, `${id}_bot`, t0 + 0.12, 0.3);
      // Rule grows symmetrically from the centre — pure scaleX is correct here.
      set(`${id}_rule`, 'scaleX', t0 + 0.34, 0, 'easeOut'); set(`${id}_rule`, 'scaleX', t0 + 0.8, 1, 'easeOut');
      set(`${id}_kick`, 'y', t0 + 0.55, y - 62 * u, 'easeOut'); set(`${id}_kick`, 'y', t0 + 0.95, y - 74 * u, 'easeOut');
      fadeIn(set, `${id}_kick`, t0 + 0.55, 0.35);
    },
  },
  {
    id: 'mg-title-glitch', name: 'Glitch Title', cat: 'titles', color: PAL.rose,
    build: (g, id, parent, x, y, u) => {
      addText(g, `${id}_r`, parent, 'GLITCH', x - 4 * u, y, 68 * u, 900, 'rgba(244,63,94,0.8)');
      addText(g, `${id}_c`, parent, 'GLITCH', x + 4 * u, y, 68 * u, 900, 'rgba(6,182,212,0.8)');
      addText(g, `${id}_w`, parent, 'GLITCH', x, y, 68 * u, 900, PAL.ink);
      addRect(g, `${id}_sliceA`, parent, x, y - 14 * u, 300 * u, 8 * u, 'rgba(6,182,212,0.5)', { opacity: 0 });
      addRect(g, `${id}_sliceB`, parent, x, y + 18 * u, 260 * u, 6 * u, 'rgba(244,63,94,0.5)', { opacity: 0 });
    },
    animate: (set, id, x, y, t0, u) => {
      const jit: Array<[number, number, number]> = [
        [0.0, 10, 4], [0.09, -8, -5], [0.18, 12, 2], [0.27, -6, -3], [0.36, 4, 5], [0.45, -9, -2], [0.54, 3, 1],
      ];
      fadeIn(set, `${id}_w`, t0, 0.08);
      fadeIn(set, `${id}_r`, t0, 0.08);
      fadeIn(set, `${id}_c`, t0, 0.08);
      for (const [dt, jx, jy] of jit) {
        const t = t0 + dt;
        set(`${id}_r`, 'x', t, x - 4 * u - jx * u, 'linear'); set(`${id}_r`, 'y', t, y + jy * u, 'linear');
        set(`${id}_c`, 'x', t, x + 4 * u + jx * u, 'linear'); set(`${id}_c`, 'y', t, y - jy * u, 'linear');
        set(`${id}_w`, 'x', t, x + jx * 0.35 * u, 'linear');
        // White pass flickers hard on the strongest hits.
        set(`${id}_w`, 'opacity', t, Math.abs(jx) > 7 ? 35 : 100, 'linear');
      }
      // Slice bars flash across during the burst.
      for (const [sfx, dtOn, dir] of [['_sliceA', 0.09, 1], ['_sliceB', 0.27, -1]] as const) {
        const s = `${id}${sfx}`;
        set(s, 'opacity', t0 + dtOn, 0, 'linear'); set(s, 'opacity', t0 + dtOn + 0.04, 90, 'linear');
        set(s, 'opacity', t0 + dtOn + 0.2, 0, 'linear');
        set(s, 'x', t0 + dtOn, x - dir * 30 * u, 'linear'); set(s, 'x', t0 + dtOn + 0.2, x + dir * 30 * u, 'linear');
      }
      // Settle: coloured copies collapse behind the white pass.
      set(`${id}_r`, 'x', t0 + 0.66, x - 2 * u, 'easeOut'); set(`${id}_r`, 'y', t0 + 0.66, y, 'easeOut');
      set(`${id}_c`, 'x', t0 + 0.66, x + 2 * u, 'easeOut'); set(`${id}_c`, 'y', t0 + 0.66, y, 'easeOut');
      set(`${id}_w`, 'x', t0 + 0.66, x, 'easeOut');
      set(`${id}_w`, 'opacity', t0 + 0.66, 100, 'easeOut');
    },
  },
  {
    id: 'mg-title-neon', name: 'Neon Flicker', cat: 'titles', color: '#38bdf8',
    build: (g, id, parent, x, y, u) => {
      addGradientShape(g, `${id}_glow`, parent, x, y, 560 * u, 220 * u,
        radialFill(0.5, 0.5, 0.9, [[0, 'rgba(56,189,248,0.55)'], [1, 'rgba(56,189,248,0)']]));
      addText(g, `${id}_txt`, parent, 'NEON', x, y, 84 * u, 900, '#e0f6ff');
      addRect(g, `${id}_base`, parent, x, y + 58 * u, 300 * u, 4 * u, '#38bdf8', { radius: 2 * u });
      addGradientShape(g, `${id}_refl`, parent, x, y + 78 * u, 300 * u, 26 * u,
        radialFill(0.5, 0.1, 0.9, [[0, 'rgba(56,189,248,0.3)'], [1, 'rgba(56,189,248,0)']]), 0);
    },
    animate: (set, id, x, _y, t0, u) => {
      // Flicker on (broken-tube starts), then a slow breathing glow.
      const flick: Array<[number, number]> = [[0, 0], [0.07, 75], [0.12, 10], [0.19, 100], [0.24, 30], [0.3, 100], [0.36, 55], [0.42, 100]];
      for (const [dt, v] of flick) {
        set(`${id}_txt`, 'opacity', t0 + dt, v, 'linear');
        set(`${id}_glow`, 'opacity', t0 + dt, v * 0.9, 'linear');
      }
      set(`${id}_glow`, 'opacity', t0 + 1.3, 55, 'easeInOut'); set(`${id}_glow`, 'opacity', t0 + 2.2, 90, 'easeInOut');
      growX(set, `${id}_base`, t0 + 0.34, 0.45, x - 150 * u, 300 * u, 1);
      set(`${id}_refl`, 'opacity', t0 + 0.6, 0, 'easeOut'); set(`${id}_refl`, 'opacity', t0 + 1.1, 70, 'easeOut');
    },
  },
  {
    id: 'mg-title-words', name: 'Word Swap', cat: 'titles', color: PAL.emerald,
    build: (g, id, parent, x, y, u) => {
      addText(g, `${id}_lead`, parent, 'WE', x - 150 * u, y, 58 * u, 900, PAL.ink);
      addText(g, `${id}_word`, parent, 'DESIGN', x + 60 * u, y, 58 * u, 900, PAL.emerald, 'left');
      addRect(g, `${id}_under`, parent, x + 60 * u, y + 42 * u, 230 * u, 5 * u, PAL.emerald, { radius: 2.5 * u });
    },
    animate: (set, id, _x, y, t0, u) => {
      fadeIn(set, `${id}_lead`, t0, 0.3);
      fadeIn(set, `${id}_under`, t0, 0.3);
      // A vertical pop on every swap beat (the text itself swaps via hold
      // keyframes in decorate — same beats).
      for (let i = 0; i < 3; i++) {
        const t = t0 + 0.2 + i * 0.75;
        set(`${id}_word`, 'y', t, y + 26 * u, 'easeOut'); set(`${id}_word`, 'y', t + 0.24, y, 'easeOut');
        set(`${id}_word`, 'opacity', t, 0, 'easeOut'); set(`${id}_word`, 'opacity', t + 0.2, 100, 'easeOut');
        if (i < 2) {
          set(`${id}_word`, 'y', t + 0.62, y, 'easeIn'); set(`${id}_word`, 'y', t + 0.75, y - 22 * u, 'easeIn');
          set(`${id}_word`, 'opacity', t + 0.62, 100, 'easeIn'); set(`${id}_word`, 'opacity', t + 0.75, 0, 'easeIn');
        }
        // Underline snaps to each word's rough width.
        set(`${id}_under`, 'scaleX', t + 0.1, [1, 0.75, 0.62][i]!, 'easeOut');
      }
    },
    decorate: (ops, id, _x, _y, t0) => {
      const words = ['DESIGN', 'BUILD', 'SHIP'];
      words.forEach((w, i) => ops.textKf(`${id}_word`, t0 + 0.2 + i * 0.75, w));
    },
  },

  // ═══ Data / utility ════════════════════════════════════════════════
  {
    id: 'mg-data-counter', name: 'Number Counter', cat: 'data', color: PAL.blue,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_tick`, parent, x - 130 * u, y - 2 * u, 6 * u, 76 * u, PAL.blue, { radius: 3 * u });
      addText(g, `${id}_num`, parent, '0', x - 104 * u, y - 14 * u, 66 * u, 800, PAL.ink, 'left');
      addText(g, `${id}_lbl`, parent, 'ACTIVE USERS', x - 104 * u, y + 40 * u, 18 * u, 700, PAL.sub, 'left');
      addText(g, `${id}_pct`, parent, '+18%', x + 152 * u, y - 14 * u, 24 * u, 700, PAL.emerald, 'left');
    },
    animate: (set, id, _x, y, t0, u) => {
      growY(set, `${id}_tick`, t0, 0.35, y + 36 * u, 76 * u, -1);
      fadeIn(set, `${id}_num`, t0, 0.25);
      rise(set, `${id}_lbl`, t0 + 0.25, y + 40 * u, 16 * u, 0.4);
      set(`${id}_pct`, 'opacity', t0, 0, 'easeOut'); set(`${id}_pct`, 'opacity', t0 + 1.3, 0, 'easeOut');
      set(`${id}_pct`, 'opacity', t0 + 1.6, 100, 'easeOut');
      set(`${id}_pct`, 'y', t0 + 1.3, y + 2 * u, 'easeOut'); set(`${id}_pct`, 'y', t0 + 1.6, y - 14 * u, 'easeOut');
    },
    decorate: (ops, id, _x, _y, t0) => {
      counterKfs(ops, `${id}_num`, t0 + 0.1, 1.5, 12480);
    },
  },
  {
    id: 'mg-data-progress', name: 'Progress Bar', cat: 'data', color: PAL.emerald,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_track`, parent, x - 20 * u, y, 380 * u, 14 * u, PAL.glassHi, { radius: 7 * u });
      addRect(g, `${id}_fill`, parent, x - 58 * u, y, 304 * u, 14 * u, PAL.emerald, { radius: 7 * u });
      addText(g, `${id}_pct`, parent, '0%', x + 196 * u, y, 26 * u, 800, PAL.ink, 'left');
      addText(g, `${id}_lbl`, parent, 'UPLOADING', x - 210 * u, y - 28 * u, 16 * u, 700, PAL.sub, 'left');
    },
    animate: (set, id, x, _y, t0, u) => {
      fadeIn(set, `${id}_track`, t0, 0.25);
      fadeIn(set, `${id}_lbl`, t0, 0.25);
      fadeIn(set, `${id}_pct`, t0 + 0.1, 0.25);
      // Fill grows from the track's left edge to 80%; same-ease anchor trick.
      growX(set, `${id}_fill`, t0 + 0.25, 1.2, x - 210 * u, 304 * u, 1);
      // Terminal pulse when it lands.
      set(`${id}_fill`, 'scaleY', t0 + 1.45, 1, 'easeOut'); set(`${id}_fill`, 'scaleY', t0 + 1.58, 1.5, 'easeOut'); set(`${id}_fill`, 'scaleY', t0 + 1.72, 1, 'easeOut');
    },
    decorate: (ops, id, _x, _y, t0) => {
      // Percentage counts on the SAME easeOut feel as the bar (quadratic out ≈
      // the keyframe easeOut, so bar and number read as one movement).
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        ops.textKf(`${id}_pct`, t0 + 0.25 + u * 1.2, `${Math.round(80 * u * (2 - u))}%`);
      }
    },
  },

  // ═══ Shapes ════════════════════════════════════════════════════════
  {
    id: 'mg-shape-burst', name: 'Particle Burst', cat: 'shapes', color: '#84cc16',
    build: (g, id, parent, x, y, u) => {
      for (let i = 0; i < 12; i++) {
        const d = (i % 3 === 0 ? 18 : i % 3 === 1 ? 12 : 8) * u;
        addEllipse(g, `${id}_p${i}`, parent, x, y, d, d, i % 2 ? '#84cc16' : '#bef264');
      }
      addEllipse(g, `${id}_flash`, parent, x, y, 70 * u, 70 * u, 'rgba(190,242,100,0.8)');
      addEllipse(g, `${id}_ring`, parent, x, y, 90 * u, 90 * u, 'rgba(190,242,100,0.25)');
    },
    animate: (set, id, x, y, t0, u) => {
      set(`${id}_flash`, 'scaleX', t0, 0, 'easeOut'); set(`${id}_flash`, 'scaleY', t0, 0, 'easeOut');
      set(`${id}_flash`, 'scaleX', t0 + 0.22, 1.4, 'easeOut'); set(`${id}_flash`, 'scaleY', t0 + 0.22, 1.4, 'easeOut');
      set(`${id}_flash`, 'opacity', t0, 100, 'easeOut'); set(`${id}_flash`, 'opacity', t0 + 0.28, 0, 'easeOut');
      set(`${id}_ring`, 'scaleX', t0 + 0.06, 0.3, 'easeOut'); set(`${id}_ring`, 'scaleY', t0 + 0.06, 0.3, 'easeOut');
      set(`${id}_ring`, 'scaleX', t0 + 0.55, 2.4, 'easeOut'); set(`${id}_ring`, 'scaleY', t0 + 0.55, 2.4, 'easeOut');
      set(`${id}_ring`, 'opacity', t0 + 0.06, 80, 'easeOut'); set(`${id}_ring`, 'opacity', t0 + 0.55, 0, 'easeOut');
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + (i % 2) * 0.22;
        const R = (i % 3 === 0 ? 150 : 115) * u;
        const dur = 0.5 + (i % 4) * 0.05;
        const pid = `${id}_p${i}`;
        set(pid, 'x', t0, x, 'easeOut'); set(pid, 'y', t0, y, 'easeOut');
        set(pid, 'x', t0 + dur, x + Math.cos(a) * R, 'easeOut');
        // Slight gravity: particles drift a touch downward at the end.
        set(pid, 'y', t0 + dur, y + Math.sin(a) * R + 14 * u, 'easeOut');
        set(pid, 'opacity', t0, 100, 'easeOut'); set(pid, 'opacity', t0 + dur * 0.6, 100, 'easeOut'); set(pid, 'opacity', t0 + dur + 0.08, 0, 'easeOut');
        set(pid, 'scaleX', t0 + dur, 0.25, 'easeOut'); set(pid, 'scaleY', t0 + dur, 0.25, 'easeOut');
      }
    },
  },
  {
    id: 'mg-shape-grid', name: 'Grid Reveal', cat: 'shapes', color: '#14b8a6',
    build: (g, id, parent, x, y, u) => {
      const cell = 74 * u, gap = 10 * u;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          addRect(g, `${id}_c${r}${c}`, parent, x + (c - 1) * (cell + gap), y + (r - 1) * (cell + gap), cell, cell,
            r === 1 && c === 1 ? '#14b8a6' : 'rgba(20,184,166,0.35)', { radius: 12 * u });
        }
      }
    },
    animate: (set, id, _x, _y, t0) => {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const d = (r + c) * 0.09; // diagonal stagger
          const cid = `${id}_c${r}${c}`;
          pop(set, cid, t0 + d, 0.34, 1.08);
          fadeIn(set, cid, t0 + d, 0.2);
        }
      }
      // Centre cell claims focus with a late pulse.
      set(`${id}_c11`, 'scaleX', t0 + 0.85, 1, 'easeInOut'); set(`${id}_c11`, 'scaleY', t0 + 0.85, 1, 'easeInOut');
      set(`${id}_c11`, 'scaleX', t0 + 1.05, 1.16, 'easeInOut'); set(`${id}_c11`, 'scaleY', t0 + 1.05, 1.16, 'easeInOut');
      set(`${id}_c11`, 'scaleX', t0 + 1.3, 1, 'easeInOut'); set(`${id}_c11`, 'scaleY', t0 + 1.3, 1, 'easeInOut');
    },
  },
  {
    id: 'mg-shape-ripple', name: 'Ripple Rings', cat: 'shapes', color: PAL.cyan,
    build: (g, id, parent, x, y, u) => {
      addEllipse(g, `${id}_core`, parent, x, y, 34 * u, 34 * u, PAL.cyan);
      for (let i = 0; i < 3; i++) {
        addEllipse(g, `${id}_r${i}`, parent, x, y, 60 * u, 60 * u, `rgba(34,211,238,${0.3 - i * 0.08})`);
      }
    },
    animate: (set, id, _x, _y, t0) => {
      pop(set, `${id}_core`, t0, 0.35, 1.3);
      for (let i = 0; i < 3; i++) {
        const r = `${id}_r${i}`, t = t0 + 0.15 + i * 0.28;
        set(r, 'scaleX', t, 0.5, 'easeOut'); set(r, 'scaleY', t, 0.5, 'easeOut');
        set(r, 'scaleX', t + 1.0, 3.4, 'easeOut'); set(r, 'scaleY', t + 1.0, 3.4, 'easeOut');
        set(r, 'opacity', t, 90, 'easeOut'); set(r, 'opacity', t + 1.0, 0, 'easeOut');
      }
    },
  },

  // ═══ Loops (expression-driven — play forever in the live scene) ═════
  {
    id: 'mg-loop-ring', name: 'Loader Ring', cat: 'loops', color: PAL.blue, loop: true, previewSeconds: 1.92,
    build: (g, id, parent, x, y, u) => {
      const R = 52 * u;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        addEllipse(g, `${id}_d${i}`, parent, x + Math.cos(a) * R, y + Math.sin(a) * R, 16 * u, 16 * u, PAL.blue, 25);
      }
    },
    animate: (set, id, _x, _y, t0) => {
      // One 0.96s chase cycle, sampled on 8 beats per dot so EVERY dot's
      // keyframe span covers exactly one period (first == last value) —
      // loopOut('cycle') then chases forever without phase drift.
      const T = 0.96;
      for (let i = 0; i < 8; i++) {
        const d = `${id}_d${i}`;
        for (let k = 0; k <= 8; k++) {
          const dist = ((k - i) % 8 + 8) % 8; // wrapped beat distance to this dot's peak
          const o = dist === 0 ? 100 : dist === 1 ? 60 : dist === 7 ? 45 : 25;
          const s = dist === 0 ? 1.25 : 1;
          const t = t0 + (k / 8) * T;
          set(d, 'opacity', t, o, 'easeInOut');
          set(d, 'scaleX', t, s, 'easeInOut'); set(d, 'scaleY', t, s, 'easeInOut');
        }
      }
    },
    decorate: (ops, id) => {
      for (let i = 0; i < 8; i++) {
        ops.expr(`${id}_d${i}`, 'opacity', "loopOut('cycle')");
        ops.expr(`${id}_d${i}`, 'scaleX', "loopOut('cycle')");
        ops.expr(`${id}_d${i}`, 'scaleY', "loopOut('cycle')");
      }
    },
  },
  {
    id: 'mg-loop-orbit', name: 'Orbit Spinner', cat: 'loops', color: '#f97316', loop: true, previewSeconds: 3.2,
    build: (g, id, parent, x, y, u) => {
      addEllipse(g, `${id}_halo`, parent, x, y, 190 * u, 190 * u, 'rgba(249,115,22,0.12)');
      addEllipse(g, `${id}_core`, parent, x, y, 58 * u, 58 * u, '#f97316');
      addEllipse(g, `${id}_sat`, parent, x + 95 * u, y, 24 * u, 24 * u, '#fdba74');
      addEllipse(g, `${id}_sat2`, parent, x - 60 * u, y, 14 * u, 14 * u, 'rgba(253,186,116,0.7)');
    },
    animate: (set, id, x, y, t0, u) => {
      // One full revolution per satellite (12 samples), cycled by loopOut.
      const orbit = (sfx: string, R: number, T: number, phase: number): void => {
        for (let i = 0; i <= 12; i++) {
          const a = (i / 12) * Math.PI * 2 + phase;
          set(`${id}${sfx}`, 'x', t0 + (i / 12) * T, x + Math.cos(a) * R, 'linear');
          set(`${id}${sfx}`, 'y', t0 + (i / 12) * T, y + Math.sin(a) * R, 'linear');
        }
      };
      orbit('_sat', 95 * u, 1.6, 0);
      orbit('_sat2', 60 * u, 1.07, Math.PI); // counter-phased inner orbit
      // Halo breathes over the same window.
      set(`${id}_halo`, 'scaleX', t0, 0.95, 'easeInOut'); set(`${id}_halo`, 'scaleY', t0, 0.95, 'easeInOut');
      set(`${id}_halo`, 'scaleX', t0 + 0.8, 1.08, 'easeInOut'); set(`${id}_halo`, 'scaleY', t0 + 0.8, 1.08, 'easeInOut');
      set(`${id}_halo`, 'scaleX', t0 + 1.6, 0.95, 'easeInOut'); set(`${id}_halo`, 'scaleY', t0 + 1.6, 0.95, 'easeInOut');
    },
    decorate: (ops, id) => {
      for (const sfx of ['_sat', '_sat2', '_halo'] as const) {
        ops.expr(`${id}${sfx}`, 'x', "loopOut('cycle')");
        ops.expr(`${id}${sfx}`, 'y', "loopOut('cycle')");
        ops.expr(`${id}${sfx}`, 'scaleX', "loopOut('cycle')");
        ops.expr(`${id}${sfx}`, 'scaleY', "loopOut('cycle')");
      }
    },
  },
  {
    id: 'mg-loop-ticker', name: 'News Ticker', cat: 'loops', color: PAL.amber, loop: true, previewSeconds: 6,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_bar`, parent, x, y, 900 * u, 56 * u, 'rgba(10,12,20,0.95)');
      addRect(g, `${id}_tag`, parent, x - 400 * u, y, 100 * u, 56 * u, '#ef4444');
      addText(g, `${id}_live`, parent, 'LIVE', x - 400 * u, y, 22 * u, 800, '#ffffff');
      addEllipse(g, `${id}_dot`, parent, x - 434 * u, y - 16 * u, 8 * u, 8 * u, '#ffffff');
      addText(g, `${id}_txt`, parent, 'Breaking: your headline scrolls across the ticker  •  more news follows', x, y, 20 * u, 600, PAL.ink);
    },
    animate: (set, id, x, _y, t0, u) => {
      fadeIn(set, `${id}_bar`, t0, 0.2);
      fadeIn(set, `${id}_tag`, t0, 0.2);
      fadeIn(set, `${id}_live`, t0, 0.2);
      // One crawl period (right edge → left edge); loopOut('cycle') repeats it.
      set(`${id}_txt`, 'x', t0 + 0.2, x + 620 * u, 'linear');
      set(`${id}_txt`, 'x', t0 + 6.0, x - 620 * u, 'linear');
      // Blink cycle on the LIVE dot.
      set(`${id}_dot`, 'opacity', t0, 100, 'easeInOut');
      set(`${id}_dot`, 'opacity', t0 + 0.5, 20, 'easeInOut');
      set(`${id}_dot`, 'opacity', t0 + 1.0, 100, 'easeInOut');
    },
    decorate: (ops, id) => {
      ops.expr(`${id}_txt`, 'x', "loopOut('cycle')");
      ops.expr(`${id}_dot`, 'opacity', "loopOut('cycle')");
    },
  },
  {
    id: 'mg-loop-badge', name: 'Float Badge', cat: 'loops', color: PAL.violet, loop: true, previewSeconds: 4,
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_card`, parent, x, y, 220 * u, 220 * u, PAL.glassHi, { radius: 28 * u });
      addEllipse(g, `${id}_medal`, parent, x, y - 24 * u, 92 * u, 92 * u, PAL.violet);
      addText(g, `${id}_star`, parent, '★', x, y - 26 * u, 44 * u, 700, '#ffffff');
      addText(g, `${id}_lbl`, parent, 'PRO', x, y + 62 * u, 26 * u, 800, PAL.ink);
    },
    animate: (set, id, _x, _y, t0) => {
      pop(set, `${id}_card`, t0, 0.45, 1.06);
      pop(set, `${id}_medal`, t0 + 0.18, 0.4, 1.18);
      fadeIn(set, `${id}_star`, t0 + 0.35, 0.25);
      fadeIn(set, `${id}_lbl`, t0 + 0.45, 0.3);
    },
    decorate: (ops, id, _x, _y, _t0, u) => {
      // Idle life after the entrance: the whole badge floats and sways.
      ops.expr(`${id}_card`, 'y', `wiggle(0.4, ${8 * u})`);
      ops.expr(`${id}_medal`, 'y', `wiggle(0.4, ${10 * u})`);
      ops.expr(`${id}_star`, 'y', `wiggle(0.4, ${10 * u})`);
      ops.expr(`${id}_card`, 'rotation', 'wiggle(0.3, 1.5)');
    },
  },
] as const;

export function getMographItem(id: string): MographItem | null {
  return MOGRAPH_ITEMS.find((m) => m.id === id) ?? null;
}

/** Loop length (seconds) of an item's keyframed choreography — shown on its
 *  card. Loop items keep a finite keyframe span (their expressions cycle it),
 *  so this stays positive; their card shows "Loop" instead. */
export function mographDuration(item: MographItem): number {
  return choreographyDuration((set) => item.animate(set, 'd', 0, 0, 0, 1));
}

// ── Insert into the live composition ─────────────────────────────────

let seq = 0;

/** Insert a motion-graphics item at (x, y) — comp centre when omitted —
 *  starting at the playhead. Returns the group node id, or null. */
export function insertMographItem(mgId: string, x?: number, y?: number): string | null {
  const item = getMographItem(mgId);
  if (!item) return null;
  const comp = useCompositionStore.getState();
  const u = (comp.height || REF_H) / REF_H;
  const px = x ?? comp.width / 2;
  const py = y ?? comp.height / 2;
  const rootId = activeCompRootId();
  const baseId = `mg_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;

  // Group wrapper so the element moves/scales as one unit.
  const group = {
    id: baseId, name: item.name, parent: rootId, children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true, locked: false,
    components: [{ id: `${baseId}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
  defaultSceneGraph.addChild(rootId, group);
  item.build(defaultSceneGraph, baseId, baseId, px, py, u);

  const ws = useWorkspaceStore.getState();
  const t0 = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
  item.animate(liveKf, baseId, px, py, t0, u);

  // Expressions + text data keyframes onto the LIVE engine (canonical time).
  const liveOps: MographOps = {
    expr: (id, prop, src) => defaultAnimation.setExpression(id, prop, src),
    textKf: (id, timeSec, value) =>
      defaultAnimation.setDataKeyframe(id, 'text.source', 'text', compToKeyframeTime(id, timeSec), value),
  };
  item.decorate?.(liveOps, baseId, px, py, t0, u);

  // Per-layer motion-blur switch for whip/slam moves (renders when the comp's
  // motion-blur master switch is on).
  for (const sfx of item.motionBlurIds ?? []) setNodeMotionBlur(`${baseId}${sfx}`, true);

  useSelectionStore.getState().set([baseId]);
  getTimelineController().syncFromScene();
  bumpScene();
  return baseId;
}

// ── Animated card preview (isolated; same build + choreography) ──────

/** Play an item's animation live into `canvas` via the shared gallery ticker.
 *  Isolated throwaway graph — never touches the live scene. Expressions and
 *  text.source keyframes replay through the SAME buildSnapshot evaluation the
 *  live renderer uses, so loop/counter cards are faithful. */
export function createMographPlayer(canvas: HTMLCanvasElement, item: MographItem): { stop: () => void } {
  const cx = PREVIEW_W / 2, cy = PREVIEW_H / 2;
  return mountPreview(canvas, {
    build: (g) => {
      addRoot(g, 'tpl_root', item.name);
      item.build(g, 'el', 'tpl_root', cx, cy, 1);
    },
    animate: (set) => item.animate(set, 'el', cx, cy, 0, 1),
    decorate: item.decorate
      ? (anim) => {
          item.decorate!({
            expr: (id, prop, src) => anim.setExpression(id, prop, src),
            textKf: (id, t, value) => anim.setDataKeyframe(id, 'text.source', 'text', t, value),
          }, 'el', cx, cy, 0, 1);
        }
      : undefined,
    duration: item.loop ? item.previewSeconds ?? 4 : undefined,
    width: PREVIEW_W,
    height: PREVIEW_H,
    background: '#101016',
  });
}
