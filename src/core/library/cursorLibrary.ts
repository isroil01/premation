/**
 * Cursor library — real vector cursor elements for screen-recording style
 * motion work (tutorials, product demos). Each item is authored as actual
 * outline geometry (the same `Geometry.points` path layers the SVG importer
 * and Lottie importer produce), so an inserted cursor is a fully editable
 * vector layer, not a screenshot. Click/trail items ship with a built-in
 * keyframe choreography starting at the playhead.
 *
 * The outline data is PURE (unit-tested); the insert function realises it
 * against the live scene via the same node shapes sceneInsert uses.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { bezierCorner as corner } from '@motion/workspace';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { liveKf, type SetKf } from '@core/template/templates/builders';
import type { SceneNode, Transform } from '@core/types';

export type CursorCategory = 'click' | 'trail' | 'spotlight' | 'hand' | 'text';

export interface CursorItem {
  id: string;
  name: string;
  cat: CursorCategory;
  /** Accent colour used for fills / rings. */
  color: string;
  /** Ships with a keyframe choreography. */
  animated: boolean;
}

/** All outlines are authored in a 0..100 design box (y down). */
export const CURSOR_DESIGN_BOX = 100;

type Pt = { x: number; y: number };

/** Classic pointer arrow (Windows/macOS silhouette), tip at top-left. */
const ARROW_OUTLINE: readonly Pt[] = [
  { x: 24, y: 6 }, { x: 24, y: 78 }, { x: 41, y: 62 }, { x: 53, y: 90 },
  { x: 62, y: 86 }, { x: 50.5, y: 59 }, { x: 73, y: 59 },
];

/** Simplified hand-pointer silhouette (index finger extended). */
const HAND_OUTLINE: readonly Pt[] = [
  { x: 40, y: 38 }, { x: 40, y: 10 }, { x: 43, y: 6 }, { x: 50, y: 6 },
  { x: 53, y: 10 }, { x: 53, y: 36 }, { x: 64, y: 36 }, { x: 75, y: 40 },
  { x: 80, y: 48 }, { x: 80, y: 66 }, { x: 74, y: 78 }, { x: 63, y: 85 },
  { x: 41, y: 85 }, { x: 31, y: 75 }, { x: 25, y: 58 }, { x: 25, y: 48 },
  { x: 31, y: 44 }, { x: 36, y: 46 }, { x: 36, y: 38 },
];

/** Text I-beam (top / bottom serifs joined by a stem). */
const IBEAM_OUTLINE: readonly Pt[] = [
  { x: 34, y: 6 }, { x: 66, y: 6 }, { x: 66, y: 12 }, { x: 54, y: 15 },
  { x: 54, y: 85 }, { x: 66, y: 88 }, { x: 66, y: 94 }, { x: 34, y: 94 },
  { x: 34, y: 88 }, { x: 46, y: 85 }, { x: 46, y: 15 }, { x: 34, y: 12 },
];

/** Thin-armed crosshair (plus). */
const CROSSHAIR_OUTLINE: readonly Pt[] = [
  { x: 46, y: 4 }, { x: 54, y: 4 }, { x: 54, y: 46 }, { x: 96, y: 46 },
  { x: 96, y: 54 }, { x: 54, y: 54 }, { x: 54, y: 96 }, { x: 46, y: 96 },
  { x: 46, y: 54 }, { x: 4, y: 54 }, { x: 4, y: 46 }, { x: 46, y: 46 },
];

export const CURSOR_ITEMS: readonly CursorItem[] = [
  { id: 'cur-arrow',       name: 'Default Arrow',    cat: 'click',     color: '#f4f6fb', animated: false },
  { id: 'cur-ripple',      name: 'Click Ripple',     cat: 'click',     color: '#8b5cf6', animated: true },
  { id: 'cur-burst',       name: 'Double Burst',     cat: 'click',     color: '#f59e0b', animated: true },
  { id: 'cur-crosshair',   name: 'Crosshair',        cat: 'click',     color: '#fb7185', animated: false },
  { id: 'cur-glow-trail',  name: 'Glow Trail',       cat: 'trail',     color: '#10b981', animated: true },
  { id: 'cur-neon-trail',  name: 'Neon Trail',       cat: 'trail',     color: '#ec4899', animated: true },
  { id: 'cur-dot-trail',   name: 'Particle Trail',   cat: 'trail',     color: '#6366f1', animated: true },
  { id: 'cur-spotlight',   name: 'Spotlight Circle', cat: 'spotlight', color: '#f97316', animated: false },
  { id: 'cur-soft-spot',   name: 'Soft Spotlight',   cat: 'spotlight', color: '#84cc16', animated: true },
  { id: 'cur-hand',        name: 'Hand Pointer',     cat: 'hand',      color: '#f4f6fb', animated: false },
  { id: 'cur-hand-click',  name: 'Hand Click',       cat: 'hand',      color: '#14b8a6', animated: true },
  { id: 'cur-ibeam',       name: 'Text I-Beam',      cat: 'text',      color: '#38bdf8', animated: false },
] as const;

export function getCursorItem(id: string): CursorItem | null {
  return CURSOR_ITEMS.find((c) => c.id === id) ?? null;
}

/** The pointer outline an item is built on (null → ellipse-only designs). */
export function cursorOutline(id: string): readonly Pt[] | null {
  switch (id) {
    case 'cur-arrow':
    case 'cur-ripple':
    case 'cur-burst':
    case 'cur-glow-trail':
    case 'cur-neon-trail':
    case 'cur-dot-trail':
      return ARROW_OUTLINE;
    case 'cur-hand':
    case 'cur-hand-click':
      return HAND_OUTLINE;
    case 'cur-ibeam':
      return IBEAM_OUTLINE;
    case 'cur-crosshair':
      return CROSSHAIR_OUTLINE;
    default:
      return null; // spotlights are pure ellipses
  }
}

/** SVG path string for the panel's preview thumbnails — generated from the SAME
 *  outline data the insert uses, so the card is faithful by construction. */
export function cursorSvgPath(id: string): string | null {
  const pts = cursorOutline(id);
  if (!pts || pts.length === 0) return null;
  return `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
}

// ── Node construction ──────────────────────────────────────────────

const tf = (x: number, y: number): Transform => ({ position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } });
let seq = 0;
const nid = (base: string): string => `${base}_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;

function addGroup(graph: SceneGraph, id: string, parent: string, name: string, x: number, y: number): string {
  const node = {
    id, name, parent, children: [], transform: tf(x, y), visible: true, locked: false,
    components: [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
  graph.addChild(parent, node);
  return id;
}

/** A closed vector path layer (design-box points, centred on (x,y), scaled by `s`). */
function addPath(
  graph: SceneGraph, id: string, parent: string, name: string,
  pts: readonly Pt[], x: number, y: number, s: number, fill: string,
): string {
  const half = CURSOR_DESIGN_BOX / 2;
  const points = pts.map((p) => corner((p.x - half) * s, (p.y - half) * s));
  const node = {
    id, name, parent, children: [], transform: tf(x, y), visible: true, locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: CURSOR_DESIGN_BOX * s, height: CURSOR_DESIGN_BOX * s, shapeType: 'path' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
      { id: `${id}_g`, type: 'Geometry', props: { points } },
    ],
  } as unknown as SceneNode;
  graph.addChild(parent, node);
  return id;
}

function addEllipse(
  graph: SceneGraph, id: string, parent: string, name: string,
  x: number, y: number, w: number, h: number, fill: string,
  stroke?: { color: string; width: number },
): string {
  const components: SceneNode['components'] = [
    { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: w, height: h, shapeType: 'ellipse' } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
  ];
  if (stroke) {
    components.push({
      id: `${id}_fx`, type: 'fx',
      props: { stroke: { enabled: true, color: stroke.color, width: stroke.width, opacity: 1, cap: 'round', join: 'miter', align: 'center', dash: [] } },
    });
  }
  const node = { id, name, parent, children: [], transform: tf(x, y), visible: true, locked: false, components } as unknown as SceneNode;
  graph.addChild(parent, node);
  return id;
}

// ── Choreographies (seconds relative to t0; replayed via SetKf) ────

function pulseRing(set: SetKf, ringId: string, t0: number, delay: number, u: number): void {
  void u;
  set(ringId, 'scaleX', t0 + delay, 0.2, 'easeOut');
  set(ringId, 'scaleY', t0 + delay, 0.2, 'easeOut');
  set(ringId, 'opacity', t0 + delay, 90, 'easeOut');
  set(ringId, 'scaleX', t0 + delay + 0.55, 1.6, 'easeOut');
  set(ringId, 'scaleY', t0 + delay + 0.55, 1.6, 'easeOut');
  set(ringId, 'opacity', t0 + delay + 0.55, 0, 'easeOut');
}

function trailDot(set: SetKf, dotId: string, t0: number, delay: number, dx: number, dy: number): void {
  set(dotId, 'x', t0 + delay, dx, 'easeOut');
  set(dotId, 'y', t0 + delay, dy, 'easeOut');
  set(dotId, 'opacity', t0 + delay, 80, 'easeOut');
  set(dotId, 'x', t0 + delay + 0.6, 0, 'easeOut');
  set(dotId, 'y', t0 + delay + 0.6, 0, 'easeOut');
  set(dotId, 'opacity', t0 + delay + 0.6, 0, 'easeOut');
}

/**
 * Insert a cursor library item into the live composition at (x, y) — comp
 * centre when omitted. Click/trail items get their keyframe choreography
 * starting at the playhead. Returns the inserted root node id, or null for an
 * unknown id.
 */
export function insertCursorItem(cursorId: string, x?: number, y?: number): string | null {
  const item = getCursorItem(cursorId);
  if (!item) return null;
  const comp = useCompositionStore.getState();
  const u = (comp.height || 720) / 720;
  const px = x ?? comp.width / 2;
  const py = y ?? comp.height / 2;
  const rootId = activeCompRootId();
  const ws = useWorkspaceStore.getState();
  const t0 = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;

  const g = defaultSceneGraph;
  const groupId = addGroup(g, nid('cursor'), rootId, item.name, px, py);
  const outline = cursorOutline(cursorId);
  const s = 0.8 * u; // pointer glyph ≈ 80px tall in a 720p comp

  switch (cursorId) {
    case 'cur-ripple':
    case 'cur-hand-click': {
      const ring = addEllipse(g, nid('ring'), groupId, 'Click Ring', 0, 0, 90 * u, 90 * u, 'rgba(0,0,0,0)', { color: item.color, width: 4 * u });
      if (outline) addPath(g, nid('ptr'), groupId, 'Pointer', outline, 0, 0, s, cursorId === 'cur-ripple' ? item.color : '#f4f6fb');
      pulseRing(liveKf, ring, t0, 0, u);
      break;
    }
    case 'cur-burst': {
      const ringA = addEllipse(g, nid('ring'), groupId, 'Burst 1', 0, 0, 80 * u, 80 * u, 'rgba(0,0,0,0)', { color: item.color, width: 4 * u });
      const ringB = addEllipse(g, nid('ring'), groupId, 'Burst 2', 0, 0, 80 * u, 80 * u, 'rgba(0,0,0,0)', { color: item.color, width: 3 * u });
      if (outline) addPath(g, nid('ptr'), groupId, 'Pointer', outline, 0, 0, s, '#f4f6fb');
      pulseRing(liveKf, ringA, t0, 0, u);
      pulseRing(liveKf, ringB, t0, 0.18, u);
      break;
    }
    case 'cur-glow-trail':
    case 'cur-neon-trail':
    case 'cur-dot-trail': {
      const n = cursorId === 'cur-dot-trail' ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const d = 12 * u * (i + 1);
        const dot = addEllipse(g, nid('dot'), groupId, `Trail ${i + 1}`, -d, d, (18 - i * 2.4) * u, (18 - i * 2.4) * u, item.color);
        trailDot(liveKf, dot, t0, i * 0.08, -d - 26 * u * (i + 1), d + 26 * u * (i + 1));
      }
      if (outline) addPath(g, nid('ptr'), groupId, 'Pointer', outline, 0, 0, s, '#f4f6fb');
      break;
    }
    case 'cur-spotlight': {
      addEllipse(g, nid('spot'), groupId, 'Spotlight', 0, 0, 260 * u, 260 * u, 'rgba(249,115,22,0.30)', { color: item.color, width: 3 * u });
      break;
    }
    case 'cur-soft-spot': {
      const spot = addEllipse(g, nid('spot'), groupId, 'Soft Spotlight', 0, 0, 300 * u, 300 * u, 'rgba(132,204,22,0.22)');
      liveKf(spot, 'scaleX', t0, 0.92, 'easeInOut'); liveKf(spot, 'scaleX', t0 + 0.8, 1.06, 'easeInOut'); liveKf(spot, 'scaleX', t0 + 1.6, 0.92, 'easeInOut');
      liveKf(spot, 'scaleY', t0, 0.92, 'easeInOut'); liveKf(spot, 'scaleY', t0 + 0.8, 1.06, 'easeInOut'); liveKf(spot, 'scaleY', t0 + 1.6, 0.92, 'easeInOut');
      break;
    }
    default: {
      // Static glyphs: arrow / hand / I-beam / crosshair.
      if (outline) addPath(g, nid('ptr'), groupId, 'Pointer', outline, 0, 0, s, item.color);
      break;
    }
  }

  useSelectionStore.getState().set([groupId]);
  getTimelineController().syncFromScene();
  bumpScene();
  return groupId;
}
