/**
 * Motion graphics library — self-contained animated elements (lower thirds,
 * callouts, loops, titles) built from engine primitives + keyframes, following
 * the animPresets model exactly: each item authors `build` (static nodes) and
 * `animate` (a SetKf choreography) ONCE, and both the live insert and the
 * panel's animated preview cards replay them — so an inserted element lands
 * looking exactly like its card.
 *
 * Geometry uses only rect / ellipse / text primitives so the Canvas2D gallery
 * previewer (templatePreview.drawSnapshot) renders every design faithfully.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { addRoot, addText, addGradientShape, radialFill, liveKf, choreographyDuration, type SetKf } from '@core/template/templates/builders';
import { mountPreview } from '@core/template/previewController';
import type { SceneNode, Transform } from '@core/types';

export type MographCategory = 'lower-thirds' | 'callouts' | 'shapes' | 'titles';

export interface MographItem {
  id: string;
  name: string;
  cat: MographCategory;
  /** Accent colour shown on the card. */
  color: string;
  /** Build the static element into `g` under `parent`, centred at (x, y);
   *  `u` scales the authored (720p-reference) size to the target comp. */
  build: (g: SceneGraph, id: string, parent: string, x: number, y: number, u: number) => void;
  /** Keyframe choreography, offset to start at t0 seconds. */
  animate: (set: SetKf, id: string, x: number, y: number, t0: number, u: number) => void;
}

/** Reference comp height the items are authored at (matches animPresets). */
const REF_H = 720;
const PREVIEW_W = 1280, PREVIEW_H = 720;

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

function addEllipse(g: SceneGraph, id: string, parent: string, x: number, y: number, w: number, h: number, fill: string): string {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: w, height: h, shapeType: 'ellipse' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
    ],
  } as unknown as SceneNode;
  g.addChild(parent, node);
  return id;
}

const scaleIn = (set: SetKf, id: string, t: number, over = 0.4): void => {
  set(id, 'scaleX', t, 0, 'easeOut'); set(id, 'scaleY', t, 0, 'easeOut');
  set(id, 'scaleX', t + over, 1, 'easeOut'); set(id, 'scaleY', t + over, 1, 'easeOut');
};
const fadeIn = (set: SetKf, id: string, t: number, over = 0.3): void => {
  set(id, 'opacity', t, 0, 'easeOut'); set(id, 'opacity', t + over, 100, 'easeOut');
};

// ── The library ──────────────────────────────────────────────────────

export const MOGRAPH_ITEMS: readonly MographItem[] = [
  {
    id: 'mg-lower-clean', name: 'Clean Lower Third', cat: 'lower-thirds', color: '#2988ff',
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_bar`, parent, x, y, 480 * u, 84 * u, 'rgba(16,18,28,0.92)', { radius: 10 * u });
      addRect(g, `${id}_acc`, parent, x - 226 * u, y, 8 * u, 84 * u, '#2988ff', { radius: 4 * u });
      addText(g, `${id}_name`, parent, 'Name Surname', x + 12 * u, y - 14 * u, 30 * u, 700, '#ffffff');
      addText(g, `${id}_role`, parent, 'Title / Role', x + 12 * u, y + 18 * u, 18 * u, 500, '#9aa4b8');
    },
    animate: (set, id, x, _y, t0, u) => {
      set(`${id}_bar`, 'scaleX', t0, 0, 'easeOut'); set(`${id}_bar`, 'scaleX', t0 + 0.45, 1, 'easeOut');
      fadeIn(set, `${id}_bar`, t0, 0.2);
      scaleIn(set, `${id}_acc`, t0 + 0.3, 0.25);
      set(`${id}_name`, 'x', t0 + 0.25, x - 40 * u, 'easeOut'); set(`${id}_name`, 'x', t0 + 0.65, x + 12 * u, 'easeOut');
      fadeIn(set, `${id}_name`, t0 + 0.25);
      set(`${id}_role`, 'x', t0 + 0.4, x - 40 * u, 'easeOut'); set(`${id}_role`, 'x', t0 + 0.8, x + 12 * u, 'easeOut');
      fadeIn(set, `${id}_role`, t0 + 0.4);
    },
  },
  {
    id: 'mg-lower-bold', name: 'Bold Name Plate', cat: 'lower-thirds', color: '#8b5cf6',
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_plate`, parent, x, y, 460 * u, 96 * u, '#8b5cf6', { radius: 14 * u });
      addRect(g, `${id}_under`, parent, x + 10 * u, y + 10 * u, 460 * u, 96 * u, 'rgba(139,92,246,0.35)', { radius: 14 * u });
      addText(g, `${id}_name`, parent, 'BOLD NAME', x, y - 8 * u, 40 * u, 900, '#ffffff');
      addText(g, `${id}_sub`, parent, 'subtitle line', x, y + 28 * u, 17 * u, 600, 'rgba(255,255,255,0.85)');
    },
    animate: (set, id, _x, y, t0, u) => {
      set(`${id}_plate`, 'y', t0, y + 160 * u, 'easeOut'); set(`${id}_plate`, 'y', t0 + 0.4, y - 10 * u, 'easeOut'); set(`${id}_plate`, 'y', t0 + 0.55, y, 'easeInOut');
      fadeIn(set, `${id}_plate`, t0, 0.2);
      set(`${id}_under`, 'y', t0, y + 180 * u, 'easeOut'); set(`${id}_under`, 'y', t0 + 0.5, y + 10 * u, 'easeOut');
      fadeIn(set, `${id}_under`, t0 + 0.1, 0.3);
      scaleIn(set, `${id}_name`, t0 + 0.35, 0.3);
      fadeIn(set, `${id}_sub`, t0 + 0.55, 0.3);
    },
  },
  {
    id: 'mg-lower-ticker', name: 'News Ticker', cat: 'lower-thirds', color: '#f59e0b',
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_bar`, parent, x, y, 900 * u, 56 * u, 'rgba(10,12,20,0.95)');
      addRect(g, `${id}_tag`, parent, x - 400 * u, y, 100 * u, 56 * u, '#ef4444');
      addText(g, `${id}_live`, parent, 'LIVE', x - 400 * u, y, 22 * u, 800, '#ffffff');
      addText(g, `${id}_txt`, parent, 'Breaking: your headline scrolls across the ticker', x + 60 * u, y, 20 * u, 600, '#f4f6fb');
    },
    animate: (set, id, x, _y, t0, u) => {
      fadeIn(set, `${id}_bar`, t0, 0.2);
      fadeIn(set, `${id}_tag`, t0, 0.2);
      fadeIn(set, `${id}_live`, t0, 0.2);
      // Marquee crawl: right edge → left edge, looping is a re-trim away.
      set(`${id}_txt`, 'x', t0 + 0.2, x + 520 * u, 'linear');
      set(`${id}_txt`, 'x', t0 + 6.2, x - 520 * u, 'linear');
      set(`${id}_live`, 'opacity', t0 + 0.4, 100, 'easeInOut'); set(`${id}_live`, 'opacity', t0 + 0.9, 30, 'easeInOut');
      set(`${id}_live`, 'opacity', t0 + 1.4, 100, 'easeInOut'); set(`${id}_live`, 'opacity', t0 + 1.9, 30, 'easeInOut');
      set(`${id}_live`, 'opacity', t0 + 2.4, 100, 'easeInOut');
    },
  },
  {
    id: 'mg-callout-bubble', name: 'Speech Bubble', cat: 'callouts', color: '#10b981',
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_box`, parent, x, y, 300 * u, 110 * u, '#10b981', { radius: 20 * u });
      addRect(g, `${id}_tail`, parent, x - 90 * u, y + 62 * u, 34 * u, 34 * u, '#10b981', { rotation: 45 });
      addText(g, `${id}_txt`, parent, 'Say something!', x, y, 24 * u, 700, '#08130e');
    },
    animate: (set, id, _x, _y, t0) => {
      for (const part of ['_box', '_tail', '_txt'] as const) {
        set(`${id}${part}`, 'scaleX', t0, 0, 'easeOut'); set(`${id}${part}`, 'scaleY', t0, 0, 'easeOut');
        set(`${id}${part}`, 'scaleX', t0 + 0.32, 1.12, 'easeOut'); set(`${id}${part}`, 'scaleY', t0 + 0.32, 1.12, 'easeOut');
        set(`${id}${part}`, 'scaleX', t0 + 0.5, 1, 'easeInOut'); set(`${id}${part}`, 'scaleY', t0 + 0.5, 1, 'easeInOut');
      }
      fadeIn(set, `${id}_txt`, t0 + 0.25);
    },
  },
  {
    id: 'mg-callout-arrow', name: 'Arrow Callout', cat: 'callouts', color: '#ec4899',
    build: (g, id, parent, x, y, u) => {
      addRect(g, `${id}_shaft`, parent, x, y, 180 * u, 8 * u, '#ec4899', { radius: 4 * u, rotation: -35 });
      addRect(g, `${id}_headA`, parent, x - 82 * u, y + 50 * u, 44 * u, 8 * u, '#ec4899', { radius: 4 * u, rotation: 15 });
      addRect(g, `${id}_headB`, parent, x - 82 * u, y + 50 * u, 44 * u, 8 * u, '#ec4899', { radius: 4 * u, rotation: -85 });
      addText(g, `${id}_txt`, parent, 'Look here', x + 96 * u, y - 78 * u, 26 * u, 800, '#ffffff');
    },
    animate: (set, id, _x, _y, t0) => {
      scaleIn(set, `${id}_shaft`, t0, 0.3);
      scaleIn(set, `${id}_headA`, t0 + 0.22, 0.2);
      scaleIn(set, `${id}_headB`, t0 + 0.22, 0.2);
      fadeIn(set, `${id}_txt`, t0 + 0.35);
    },
  },
  {
    id: 'mg-callout-box', name: 'Highlight Box', cat: 'callouts', color: '#6366f1',
    build: (g, id, parent, x, y, u) => {
      const w = 320 * u, h = 180 * u, t = 6 * u;
      addRect(g, `${id}_top`, parent, x, y - h / 2, w, t, '#6366f1', { radius: 3 * u });
      addRect(g, `${id}_bot`, parent, x, y + h / 2, w, t, '#6366f1', { radius: 3 * u });
      addRect(g, `${id}_lft`, parent, x - w / 2, y, t, h, '#6366f1', { radius: 3 * u });
      addRect(g, `${id}_rgt`, parent, x + w / 2, y, t, h, '#6366f1', { radius: 3 * u });
      addRect(g, `${id}_fill`, parent, x, y, w, h, 'rgba(99,102,241,0.14)');
    },
    animate: (set, id, _x, _y, t0) => {
      // Draw the frame on clockwise, then breathe the fill.
      set(`${id}_top`, 'scaleX', t0, 0, 'easeInOut'); set(`${id}_top`, 'scaleX', t0 + 0.2, 1, 'easeInOut');
      set(`${id}_rgt`, 'scaleY', t0 + 0.2, 0, 'easeInOut'); set(`${id}_rgt`, 'scaleY', t0 + 0.4, 1, 'easeInOut');
      set(`${id}_bot`, 'scaleX', t0 + 0.4, 0, 'easeInOut'); set(`${id}_bot`, 'scaleX', t0 + 0.6, 1, 'easeInOut');
      set(`${id}_lft`, 'scaleY', t0 + 0.6, 0, 'easeInOut'); set(`${id}_lft`, 'scaleY', t0 + 0.8, 1, 'easeInOut');
      set(`${id}_fill`, 'opacity', t0, 0, 'easeInOut'); set(`${id}_fill`, 'opacity', t0 + 0.8, 0, 'easeInOut');
      set(`${id}_fill`, 'opacity', t0 + 1.1, 100, 'easeInOut'); set(`${id}_fill`, 'opacity', t0 + 1.6, 55, 'easeInOut');
    },
  },
  {
    id: 'mg-shape-orbit', name: 'Geometric Orbit', cat: 'shapes', color: '#f97316',
    build: (g, id, parent, x, y, u) => {
      addEllipse(g, `${id}_core`, parent, x, y, 60 * u, 60 * u, '#f97316');
      addEllipse(g, `${id}_sat`, parent, x + 95 * u, y, 26 * u, 26 * u, '#fdba74');
      addEllipse(g, `${id}_halo`, parent, x, y, 190 * u, 190 * u, 'rgba(249,115,22,0.12)');
    },
    animate: (set, id, x, y, t0, u) => {
      scaleIn(set, `${id}_core`, t0, 0.35);
      fadeIn(set, `${id}_halo`, t0, 0.4);
      // Orbit: sampled circular motion (8 keys/turn), 2s per revolution.
      const R = 95 * u;
      for (let i = 0; i <= 16; i++) {
        const a = (i / 8) * Math.PI;
        set(`${id}_sat`, 'x', t0 + 0.3 + i * 0.25, x + Math.cos(a) * R, 'linear');
        set(`${id}_sat`, 'y', t0 + 0.3 + i * 0.25, y + Math.sin(a) * R, 'linear');
      }
      set(`${id}_halo`, 'scaleX', t0 + 0.4, 0.95, 'easeInOut'); set(`${id}_halo`, 'scaleX', t0 + 1.4, 1.08, 'easeInOut'); set(`${id}_halo`, 'scaleX', t0 + 2.4, 0.95, 'easeInOut');
      set(`${id}_halo`, 'scaleY', t0 + 0.4, 0.95, 'easeInOut'); set(`${id}_halo`, 'scaleY', t0 + 1.4, 1.08, 'easeInOut'); set(`${id}_halo`, 'scaleY', t0 + 2.4, 0.95, 'easeInOut');
    },
  },
  {
    id: 'mg-shape-burst', name: 'Particle Burst', cat: 'shapes', color: '#84cc16',
    build: (g, id, parent, x, y, u) => {
      for (let i = 0; i < 8; i++) {
        addEllipse(g, `${id}_p${i}`, parent, x, y, 16 * u, 16 * u, i % 2 ? '#84cc16' : '#bef264');
      }
      addEllipse(g, `${id}_flash`, parent, x, y, 70 * u, 70 * u, 'rgba(190,242,100,0.8)');
    },
    animate: (set, id, x, y, t0, u) => {
      set(`${id}_flash`, 'scaleX', t0, 0, 'easeOut'); set(`${id}_flash`, 'scaleY', t0, 0, 'easeOut');
      set(`${id}_flash`, 'scaleX', t0 + 0.25, 1.4, 'easeOut'); set(`${id}_flash`, 'scaleY', t0 + 0.25, 1.4, 'easeOut');
      set(`${id}_flash`, 'opacity', t0, 100, 'easeOut'); set(`${id}_flash`, 'opacity', t0 + 0.3, 0, 'easeOut');
      const R = 130 * u;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const pid = `${id}_p${i}`;
        set(pid, 'x', t0, x, 'easeOut'); set(pid, 'y', t0, y, 'easeOut');
        set(pid, 'x', t0 + 0.55, x + Math.cos(a) * R, 'easeOut'); set(pid, 'y', t0 + 0.55, y + Math.sin(a) * R, 'easeOut');
        set(pid, 'opacity', t0, 100, 'easeOut'); set(pid, 'opacity', t0 + 0.35, 100, 'easeOut'); set(pid, 'opacity', t0 + 0.6, 0, 'easeOut');
        set(pid, 'scaleX', t0 + 0.55, 0.3, 'easeOut'); set(pid, 'scaleY', t0 + 0.55, 0.3, 'easeOut');
      }
    },
  },
  {
    id: 'mg-shape-grid', name: 'Grid Reveal', cat: 'shapes', color: '#14b8a6',
    build: (g, id, parent, x, y, u) => {
      const cell = 74 * u, gap = 10 * u;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          addRect(g, `${id}_c${r}${c}`, parent, x + (c - 1) * (cell + gap), y + (r - 1) * (cell + gap), cell, cell, r === 1 && c === 1 ? '#14b8a6' : 'rgba(20,184,166,0.35)', { radius: 10 * u });
        }
      }
    },
    animate: (set, id, _x, _y, t0) => {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const d = (r + c) * 0.09; // diagonal stagger
          scaleIn(set, `${id}_c${r}${c}`, t0 + d, 0.3);
        }
      }
    },
  },
  {
    id: 'mg-title-kinetic', name: 'Kinetic Title', cat: 'titles', color: '#a78bfa',
    build: (g, id, parent, x, y, u) => {
      addText(g, `${id}_top`, parent, 'KINETIC', x, y - 26 * u, 64 * u, 900, '#ffffff');
      addText(g, `${id}_bot`, parent, 'TITLE', x, y + 34 * u, 64 * u, 900, '#a78bfa');
      addRect(g, `${id}_rule`, parent, x, y + 4 * u, 320 * u, 5 * u, '#a78bfa', { radius: 2 * u });
    },
    animate: (set, id, x, _y, t0, u) => {
      set(`${id}_top`, 'x', t0, x - 260 * u, 'easeOut'); set(`${id}_top`, 'x', t0 + 0.55, x, 'easeOut');
      fadeIn(set, `${id}_top`, t0, 0.35);
      set(`${id}_bot`, 'x', t0 + 0.15, x + 260 * u, 'easeOut'); set(`${id}_bot`, 'x', t0 + 0.7, x, 'easeOut');
      fadeIn(set, `${id}_bot`, t0 + 0.15, 0.35);
      set(`${id}_rule`, 'scaleX', t0 + 0.3, 0, 'easeOut'); set(`${id}_rule`, 'scaleX', t0 + 0.8, 1, 'easeOut');
    },
  },
  {
    id: 'mg-title-glitch', name: 'Glitch Title', cat: 'titles', color: '#fb7185',
    build: (g, id, parent, x, y, u) => {
      addText(g, `${id}_r`, parent, 'GLITCH', x - 4 * u, y, 68 * u, 900, 'rgba(244,63,94,0.8)');
      addText(g, `${id}_c`, parent, 'GLITCH', x + 4 * u, y, 68 * u, 900, 'rgba(6,182,212,0.8)');
      addText(g, `${id}_w`, parent, 'GLITCH', x, y, 68 * u, 900, '#ffffff');
    },
    animate: (set, id, x, _y, t0, u) => {
      const jit = [10, -8, 12, -6, 4, 0];
      fadeIn(set, `${id}_w`, t0, 0.1);
      fadeIn(set, `${id}_r`, t0, 0.1);
      fadeIn(set, `${id}_c`, t0, 0.1);
      jit.forEach((j, i) => {
        const t = t0 + i * 0.09;
        set(`${id}_r`, 'x', t, x - 4 * u - j * u, 'linear');
        set(`${id}_c`, 'x', t, x + 4 * u + j * u, 'linear');
        set(`${id}_w`, 'x', t, x + (i % 2 ? j * 0.4 : -j * 0.4) * u, 'linear');
      });
      // Settle: coloured copies collapse behind the white pass.
      set(`${id}_r`, 'x', t0 + 0.62, x - 2 * u, 'easeOut');
      set(`${id}_c`, 'x', t0 + 0.62, x + 2 * u, 'easeOut');
      set(`${id}_w`, 'x', t0 + 0.62, x, 'easeOut');
    },
  },
  {
    id: 'mg-title-neon', name: 'Neon Glow Title', cat: 'titles', color: '#38bdf8',
    build: (g, id, parent, x, y, u) => {
      addGradientShape(g, `${id}_glow`, parent, x, y, 560 * u, 220 * u,
        radialFill(0.5, 0.5, 0.9, [[0, 'rgba(56,189,248,0.55)'], [1, 'rgba(56,189,248,0)']]));
      addText(g, `${id}_txt`, parent, 'NEON', x, y, 84 * u, 900, '#e0f6ff');
      addRect(g, `${id}_base`, parent, x, y + 58 * u, 300 * u, 4 * u, '#38bdf8', { radius: 2 * u });
    },
    animate: (set, id, _x, _y, t0) => {
      // Flicker on, then a slow pulse.
      const flick: Array<[number, number]> = [[0, 0], [0.08, 80], [0.14, 15], [0.2, 100], [0.26, 40], [0.34, 100]];
      for (const [dt, v] of flick) {
        set(`${id}_txt`, 'opacity', t0 + dt, v, 'linear');
        set(`${id}_glow`, 'opacity', t0 + dt, v * 0.9, 'linear');
      }
      set(`${id}_glow`, 'opacity', t0 + 1.4, 55, 'easeInOut'); set(`${id}_glow`, 'opacity', t0 + 2.4, 90, 'easeInOut');
      set(`${id}_base`, 'scaleX', t0 + 0.3, 0, 'easeOut'); set(`${id}_base`, 'scaleX', t0 + 0.75, 1, 'easeOut');
    },
  },
] as const;

export function getMographItem(id: string): MographItem | null {
  return MOGRAPH_ITEMS.find((m) => m.id === id) ?? null;
}

/** Loop length (seconds) of an item's choreography — shown on its card. */
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

  useSelectionStore.getState().set([baseId]);
  getTimelineController().syncFromScene();
  bumpScene();
  return baseId;
}

// ── Animated card preview (isolated; same build + choreography) ──────

/** Play an item's animation live into `canvas` via the shared gallery ticker.
 *  Isolated throwaway graph — never touches the live scene. */
export function createMographPlayer(canvas: HTMLCanvasElement, item: MographItem): { stop: () => void } {
  const cx = PREVIEW_W / 2, cy = PREVIEW_H / 2;
  return mountPreview(canvas, {
    build: (g) => {
      addRoot(g, 'tpl_root', item.name);
      item.build(g, 'el', 'tpl_root', cx, cy, 1);
    },
    animate: (set) => item.animate(set, 'el', cx, cy, 0, 1),
    width: PREVIEW_W,
    height: PREVIEW_H,
    background: '#101016',
  });
}
