/**
 * Cursor library — real vector cursor elements for screen-recording style
 * motion work (tutorials, product demos). Each item is authored as actual
 * geometry — multi-part designs made of closed path outlines, discs and
 * stroked rings in a shared 0..100 design box — so an inserted cursor is a
 * group of fully editable vector layers, not a screenshot. Animated items
 * ship with a built-in keyframe choreography starting at the playhead.
 *
 * Every item has its OWN silhouette (system pointers, resize arrows, zoom
 * magnifiers, tool cursors, effect overlays) — no recoloured duplicates.
 * The design data is PURE (unit-tested); the insert function realises it
 * against the live scene via the same node shapes sceneInsert uses, and the
 * panel thumbnails are generated from the SAME part data (faithful by
 * construction).
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

export type CursorCategory = 'pointer' | 'text' | 'resize' | 'zoom' | 'tools' | 'effects';

export interface CursorItem {
  id: string;
  name: string;
  cat: CursorCategory;
  /** Accent colour used for default fills / rings / the card glow. */
  color: string;
  /** Ships with a keyframe choreography. */
  animated: boolean;
}

/** All designs are authored in a 0..100 design box (y down). */
export const CURSOR_DESIGN_BOX = 100;

type Pt = { x: number; y: number };

/** One geometric part of a cursor design. `fill`/`color` omitted → item accent. */
export type CursorPart =
  | { kind: 'path'; pts: readonly Pt[]; fill?: string; stroke?: { color: string; width: number } }
  | { kind: 'disc'; cx: number; cy: number; r: number; fill?: string }
  | { kind: 'ring'; cx: number; cy: number; r: number; width: number; color?: string };

interface CursorDesign {
  /** Parts in paint order (later parts draw on top). */
  parts: readonly CursorPart[];
  /** Design-box height in pixels when inserted into a 720p comp. */
  size: number;
}

// ── Silhouettes (each its own geometry — no recolours) ─────────────

const DARK = '#14161c';
const LIGHT = '#f8fafc';

/** macOS-style black arrow — compact, steep tail notch. */
const MAC_ARROW: readonly Pt[] = [
  { x: 30, y: 6 }, { x: 30, y: 74 }, { x: 45, y: 60 }, { x: 55, y: 84 },
  { x: 64, y: 80 }, { x: 54, y: 57 }, { x: 72, y: 57 },
];

/** Windows-style white arrow — slimmer and taller than the macOS glyph. */
const WIN_ARROW: readonly Pt[] = [
  { x: 36, y: 4 }, { x: 36, y: 80 }, { x: 49, y: 68 }, { x: 57, y: 92 },
  { x: 67, y: 88 }, { x: 58, y: 64 }, { x: 76, y: 64 },
];

/** Link pointer — hand with index finger extended. */
const HAND_LINK: readonly Pt[] = [
  { x: 40, y: 38 }, { x: 40, y: 10 }, { x: 43, y: 6 }, { x: 50, y: 6 },
  { x: 53, y: 10 }, { x: 53, y: 36 }, { x: 64, y: 36 }, { x: 75, y: 40 },
  { x: 80, y: 48 }, { x: 80, y: 66 }, { x: 74, y: 78 }, { x: 63, y: 85 },
  { x: 41, y: 85 }, { x: 31, y: 75 }, { x: 25, y: 58 }, { x: 25, y: 48 },
  { x: 31, y: 44 }, { x: 36, y: 46 }, { x: 36, y: 38 },
];

/** Open hand (grab) — four spread fingers + thumb, traced as one outline. */
const HAND_OPEN: readonly Pt[] = [
  { x: 26, y: 88 }, { x: 23, y: 64 }, { x: 14, y: 55 }, { x: 11, y: 47 },
  { x: 16, y: 41 }, { x: 24, y: 45 }, { x: 29, y: 50 },
  { x: 30, y: 29 }, { x: 32, y: 21 }, { x: 38, y: 20 }, { x: 40, y: 28 }, { x: 41, y: 42 },
  { x: 44, y: 19 }, { x: 46, y: 12 }, { x: 51, y: 12 }, { x: 53, y: 20 }, { x: 54, y: 42 },
  { x: 57, y: 21 }, { x: 59, y: 15 }, { x: 64, y: 16 }, { x: 65, y: 24 }, { x: 66, y: 44 },
  { x: 68, y: 31 }, { x: 70, y: 26 }, { x: 74, y: 28 }, { x: 75, y: 36 }, { x: 75, y: 52 },
  { x: 77, y: 64 }, { x: 72, y: 82 }, { x: 63, y: 88 },
];

/** Closed fist (grabbing) — curled knuckle bumps along the top. */
const HAND_FIST: readonly Pt[] = [
  { x: 26, y: 74 }, { x: 24, y: 54 }, { x: 26, y: 44 },
  { x: 32, y: 38 }, { x: 36, y: 34 }, { x: 40, y: 36 }, { x: 42, y: 40 },
  { x: 44, y: 34 }, { x: 48, y: 31 }, { x: 52, y: 33 }, { x: 53, y: 38 },
  { x: 55, y: 33 }, { x: 59, y: 31 }, { x: 63, y: 33 }, { x: 64, y: 38 },
  { x: 66, y: 35 }, { x: 70, y: 34 }, { x: 73, y: 37 }, { x: 74, y: 42 },
  { x: 76, y: 50 }, { x: 76, y: 62 }, { x: 72, y: 72 }, { x: 62, y: 78 }, { x: 36, y: 78 },
];

/** Text I-beam (vertical stem, top/bottom serifs). */
const IBEAM_V: readonly Pt[] = [
  { x: 34, y: 6 }, { x: 66, y: 6 }, { x: 66, y: 12 }, { x: 54, y: 15 },
  { x: 54, y: 85 }, { x: 66, y: 88 }, { x: 66, y: 94 }, { x: 34, y: 94 },
  { x: 34, y: 88 }, { x: 46, y: 85 }, { x: 46, y: 15 }, { x: 34, y: 12 },
];

/** Vertical-text I-beam — the same construction rotated 90°. */
const IBEAM_H: readonly Pt[] = [
  { x: 6, y: 34 }, { x: 6, y: 66 }, { x: 12, y: 66 }, { x: 15, y: 54 },
  { x: 85, y: 54 }, { x: 88, y: 66 }, { x: 94, y: 66 }, { x: 94, y: 34 },
  { x: 88, y: 34 }, { x: 85, y: 46 }, { x: 15, y: 46 }, { x: 12, y: 34 },
];

/** Thin-armed crosshair (plus spanning the box). */
const CROSSHAIR: readonly Pt[] = [
  { x: 46, y: 4 }, { x: 54, y: 4 }, { x: 54, y: 46 }, { x: 96, y: 46 },
  { x: 96, y: 54 }, { x: 54, y: 54 }, { x: 54, y: 96 }, { x: 46, y: 96 },
  { x: 46, y: 54 }, { x: 4, y: 54 }, { x: 4, y: 46 }, { x: 46, y: 46 },
];

/** Horizontal double-headed resize arrow (↔). */
const RESIZE_H: readonly Pt[] = [
  { x: 4, y: 50 }, { x: 22, y: 32 }, { x: 22, y: 43 }, { x: 78, y: 43 },
  { x: 78, y: 32 }, { x: 96, y: 50 }, { x: 78, y: 68 }, { x: 78, y: 57 },
  { x: 22, y: 57 }, { x: 22, y: 68 },
];

/** Vertical double-headed resize arrow (↕). */
const RESIZE_V: readonly Pt[] = [
  { x: 50, y: 4 }, { x: 68, y: 22 }, { x: 57, y: 22 }, { x: 57, y: 78 },
  { x: 68, y: 78 }, { x: 50, y: 96 }, { x: 32, y: 78 }, { x: 43, y: 78 },
  { x: 43, y: 22 }, { x: 32, y: 22 },
];

/** Diagonal resize NW↘SE (⤡) — the horizontal arrow rotated 45°. */
const RESIZE_NWSE: readonly Pt[] = [
  { x: 17.5, y: 17.5 }, { x: 42.9, y: 17.5 }, { x: 35.2, y: 25.3 }, { x: 74.7, y: 64.9 },
  { x: 82.5, y: 57.1 }, { x: 82.5, y: 82.5 }, { x: 57.1, y: 82.5 }, { x: 64.9, y: 74.7 },
  { x: 25.3, y: 35.2 }, { x: 17.5, y: 42.9 },
];

/** Diagonal resize NE↙SW (⤢) — mirror of ⤡. */
const RESIZE_NESW: readonly Pt[] = RESIZE_NWSE.map((p) => ({ x: 100 - p.x, y: p.y }));

/** Four-way move — plus bar with an arrowhead on every end. */
const MOVE_4WAY: readonly Pt[] = [
  { x: 50, y: 4 }, { x: 61, y: 17 }, { x: 54, y: 17 }, { x: 54, y: 46 },
  { x: 83, y: 46 }, { x: 83, y: 39 }, { x: 96, y: 50 }, { x: 83, y: 61 },
  { x: 83, y: 54 }, { x: 54, y: 54 }, { x: 54, y: 83 }, { x: 61, y: 83 },
  { x: 50, y: 96 }, { x: 39, y: 83 }, { x: 46, y: 83 }, { x: 46, y: 54 },
  { x: 17, y: 54 }, { x: 17, y: 61 }, { x: 4, y: 50 }, { x: 17, y: 39 },
  { x: 17, y: 46 }, { x: 46, y: 46 }, { x: 46, y: 17 }, { x: 39, y: 17 },
];

/** Magnifier handle (45° bar off the lens rim toward bottom-right). */
const ZOOM_HANDLE: readonly Pt[] = [
  { x: 58, y: 65 }, { x: 65, y: 58 }, { x: 95, y: 88 }, { x: 88, y: 95 },
];
/** Plus glyph inside the lens (centred on 42,42). */
const ZOOM_PLUS: readonly Pt[] = [
  { x: 38, y: 29 }, { x: 46, y: 29 }, { x: 46, y: 38 }, { x: 55, y: 38 },
  { x: 55, y: 46 }, { x: 46, y: 46 }, { x: 46, y: 55 }, { x: 38, y: 55 },
  { x: 38, y: 46 }, { x: 29, y: 46 }, { x: 29, y: 38 }, { x: 38, y: 38 },
];
/** Minus glyph inside the lens. */
const ZOOM_MINUS: readonly Pt[] = [
  { x: 29, y: 38 }, { x: 55, y: 38 }, { x: 55, y: 46 }, { x: 29, y: 46 },
];

/** Not-allowed slash (45° bar spanning the ring interior). */
const SLASH: readonly Pt[] = [
  { x: 24, y: 31 }, { x: 31, y: 24 }, { x: 76, y: 69 }, { x: 69, y: 76 },
];

/** Precision-select ticks (N/S/E/W of the ring). */
const TICK_N: readonly Pt[] = [{ x: 47, y: 4 }, { x: 53, y: 4 }, { x: 53, y: 14 }, { x: 47, y: 14 }];
const TICK_S: readonly Pt[] = [{ x: 47, y: 86 }, { x: 53, y: 86 }, { x: 53, y: 96 }, { x: 47, y: 96 }];
const TICK_W: readonly Pt[] = [{ x: 4, y: 47 }, { x: 14, y: 47 }, { x: 14, y: 53 }, { x: 4, y: 53 }];
const TICK_E: readonly Pt[] = [{ x: 86, y: 47 }, { x: 96, y: 47 }, { x: 96, y: 53 }, { x: 86, y: 53 }];

/** Pen nib — pointed writing tip with a breather hole. */
const PEN_NIB: readonly Pt[] = [
  { x: 50, y: 8 }, { x: 63, y: 22 }, { x: 68, y: 58 }, { x: 50, y: 88 },
  { x: 32, y: 58 }, { x: 37, y: 22 },
];

/** Eyedropper shaft (tip bottom-left) + collar diamond. */
const DROPPER_SHAFT: readonly Pt[] = [
  { x: 10, y: 90 }, { x: 16, y: 96 }, { x: 60, y: 52 }, { x: 54, y: 46 },
];
const DROPPER_COLLAR: readonly Pt[] = [
  { x: 50, y: 42 }, { x: 58, y: 34 }, { x: 66, y: 42 }, { x: 58, y: 50 },
];

// ── The designs ────────────────────────────────────────────────────

const glyph = (pts: readonly Pt[], fill: string, strokeColor: string): CursorPart => ({
  kind: 'path', pts, fill, stroke: { color: strokeColor, width: 3 },
});

const DESIGNS: Record<string, CursorDesign> = {
  // Pointers
  'cur-mac-arrow':   { size: 56, parts: [glyph(MAC_ARROW, '#111318', LIGHT)] },
  'cur-win-arrow':   { size: 56, parts: [glyph(WIN_ARROW, LIGHT, DARK)] },
  'cur-hand-link':   { size: 56, parts: [glyph(HAND_LINK, LIGHT, DARK)] },
  'cur-grab':        { size: 56, parts: [glyph(HAND_OPEN, LIGHT, DARK)] },
  'cur-grabbing':    { size: 52, parts: [glyph(HAND_FIST, LIGHT, DARK)] },
  'cur-precision': {
    size: 52,
    parts: [
      { kind: 'ring', cx: 50, cy: 50, r: 26, width: 6 },
      { kind: 'path', pts: TICK_N }, { kind: 'path', pts: TICK_S },
      { kind: 'path', pts: TICK_W }, { kind: 'path', pts: TICK_E },
      { kind: 'disc', cx: 50, cy: 50, r: 6 },
    ],
  },
  'cur-not-allowed': {
    size: 52,
    parts: [
      { kind: 'ring', cx: 50, cy: 50, r: 38, width: 10 },
      { kind: 'path', pts: SLASH },
    ],
  },
  'cur-crosshair':   { size: 52, parts: [{ kind: 'path', pts: CROSSHAIR }] },
  'cur-busy': {
    size: 48,
    parts: [
      { kind: 'ring', cx: 50, cy: 50, r: 34, width: 9, color: 'rgba(139,92,246,0.28)' },
      { kind: 'disc', cx: 50, cy: 16, r: 10 },
    ],
  },
  // Text
  'cur-ibeam':       { size: 56, parts: [glyph(IBEAM_V, LIGHT, DARK)] },
  'cur-ibeam-h':     { size: 56, parts: [glyph(IBEAM_H, LIGHT, DARK)] },
  // Resize / move
  'cur-resize-h':    { size: 52, parts: [glyph(RESIZE_H, LIGHT, DARK)] },
  'cur-resize-v':    { size: 52, parts: [glyph(RESIZE_V, LIGHT, DARK)] },
  'cur-resize-nwse': { size: 52, parts: [glyph(RESIZE_NWSE, LIGHT, DARK)] },
  'cur-resize-nesw': { size: 52, parts: [glyph(RESIZE_NESW, LIGHT, DARK)] },
  'cur-move':        { size: 56, parts: [glyph(MOVE_4WAY, LIGHT, DARK)] },
  // Zoom
  'cur-zoom-in': {
    size: 60,
    parts: [
      { kind: 'path', pts: ZOOM_HANDLE },
      { kind: 'ring', cx: 42, cy: 42, r: 27, width: 7 },
      { kind: 'path', pts: ZOOM_PLUS },
    ],
  },
  'cur-zoom-out': {
    size: 60,
    parts: [
      { kind: 'path', pts: ZOOM_HANDLE },
      { kind: 'ring', cx: 42, cy: 42, r: 27, width: 7 },
      { kind: 'path', pts: ZOOM_MINUS },
    ],
  },
  // Tools
  'cur-pen': {
    size: 56,
    parts: [
      { kind: 'path', pts: PEN_NIB },
      { kind: 'disc', cx: 50, cy: 44, r: 6, fill: LIGHT },
    ],
  },
  'cur-eyedropper': {
    size: 56,
    parts: [
      { kind: 'path', pts: DROPPER_SHAFT },
      { kind: 'path', pts: DROPPER_COLLAR },
      { kind: 'disc', cx: 70, cy: 30, r: 13 },
    ],
  },
  // Effects (animated choreography)
  'cur-click-ripple': {
    size: 96,
    parts: [
      { kind: 'ring', cx: 50, cy: 50, r: 44, width: 4 },
      glyph(WIN_ARROW, LIGHT, DARK),
    ],
  },
  'cur-double-burst': {
    size: 96,
    parts: [
      { kind: 'ring', cx: 50, cy: 50, r: 40, width: 4 },
      { kind: 'ring', cx: 50, cy: 50, r: 40, width: 3 },
      glyph(WIN_ARROW, LIGHT, DARK),
    ],
  },
  'cur-spotlight': {
    size: 300,
    parts: [
      { kind: 'disc', cx: 50, cy: 50, r: 48, fill: 'rgba(249,115,22,0.26)' },
      { kind: 'ring', cx: 50, cy: 50, r: 48, width: 2 },
    ],
  },
  'cur-glow-trail': {
    size: 72,
    parts: [
      { kind: 'disc', cx: 34, cy: 66, r: 8 },
      { kind: 'disc', cx: 24, cy: 76, r: 6 },
      { kind: 'disc', cx: 16, cy: 84, r: 4 },
      glyph(WIN_ARROW, LIGHT, DARK),
    ],
  },
};

export const CURSOR_ITEMS: readonly CursorItem[] = [
  // System pointers
  { id: 'cur-mac-arrow',    name: 'macOS Arrow',      cat: 'pointer', color: '#111318', animated: false },
  { id: 'cur-win-arrow',    name: 'Windows Arrow',    cat: 'pointer', color: '#f8fafc', animated: false },
  { id: 'cur-hand-link',    name: 'Link Pointer',     cat: 'pointer', color: '#e2e8f0', animated: false },
  { id: 'cur-grab',         name: 'Grab Hand',        cat: 'pointer', color: '#e2e8f0', animated: false },
  { id: 'cur-grabbing',     name: 'Grabbing Fist',    cat: 'pointer', color: '#e2e8f0', animated: false },
  { id: 'cur-precision',    name: 'Precision Select', cat: 'pointer', color: '#38bdf8', animated: false },
  { id: 'cur-not-allowed',  name: 'Not Allowed',      cat: 'pointer', color: '#ef4444', animated: false },
  { id: 'cur-crosshair',    name: 'Crosshair',        cat: 'pointer', color: '#fb7185', animated: false },
  { id: 'cur-busy',         name: 'Busy Spinner',     cat: 'pointer', color: '#8b5cf6', animated: true },
  // Text
  { id: 'cur-ibeam',        name: 'Text I-Beam',      cat: 'text',    color: '#38bdf8', animated: false },
  { id: 'cur-ibeam-h',      name: 'Vertical Text',    cat: 'text',    color: '#818cf8', animated: false },
  // Resize / move
  { id: 'cur-resize-h',     name: 'Resize ↔',        cat: 'resize',  color: '#34d399', animated: false },
  { id: 'cur-resize-v',     name: 'Resize ↕',        cat: 'resize',  color: '#2dd4bf', animated: false },
  { id: 'cur-resize-nwse',  name: 'Resize ⤡',        cat: 'resize',  color: '#4ade80', animated: false },
  { id: 'cur-resize-nesw',  name: 'Resize ⤢',        cat: 'resize',  color: '#a3e635', animated: false },
  { id: 'cur-move',         name: 'Move 4-Way',       cat: 'resize',  color: '#f8fafc', animated: false },
  // Zoom
  { id: 'cur-zoom-in',      name: 'Zoom In',          cat: 'zoom',    color: '#fbbf24', animated: false },
  { id: 'cur-zoom-out',     name: 'Zoom Out',         cat: 'zoom',    color: '#f59e0b', animated: false },
  // Tools
  { id: 'cur-pen',          name: 'Pen Nib',          cat: 'tools',   color: '#f472b6', animated: false },
  { id: 'cur-eyedropper',   name: 'Eyedropper',       cat: 'tools',   color: '#22d3ee', animated: false },
  // Effect overlays
  { id: 'cur-click-ripple', name: 'Click Ripple',     cat: 'effects', color: '#8b5cf6', animated: true },
  { id: 'cur-double-burst', name: 'Double Burst',     cat: 'effects', color: '#f59e0b', animated: true },
  { id: 'cur-spotlight',    name: 'Spotlight Follow', cat: 'effects', color: '#f97316', animated: true },
  { id: 'cur-glow-trail',   name: 'Glow Trail',       cat: 'effects', color: '#10b981', animated: true },
] as const;

export function getCursorItem(id: string): CursorItem | null {
  return CURSOR_ITEMS.find((c) => c.id === id) ?? null;
}

/** The full multi-part design an item is built from (null for unknown ids). */
export function cursorParts(id: string): readonly CursorPart[] | null {
  return DESIGNS[id]?.parts ?? null;
}

/** The primary path outline (first path part) — null for circle-only designs. */
export function cursorOutline(id: string): readonly Pt[] | null {
  const parts = DESIGNS[id]?.parts;
  if (!parts) return null;
  const p = parts.find((x): x is Extract<CursorPart, { kind: 'path' }> => x.kind === 'path');
  return p ? p.pts : null;
}

const polyD = (pts: readonly Pt[]): string => `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
const circleD = (cx: number, cy: number, r: number): string =>
  `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;

/** Compound SVG path over ALL parts — used by tests to assert every design
 *  yields drawable geometry inside the design box. */
export function cursorSvgPath(id: string): string | null {
  const parts = DESIGNS[id]?.parts;
  if (!parts || parts.length === 0) return null;
  return parts
    .map((p) => (p.kind === 'path' ? polyD(p.pts) : circleD(p.cx, p.cy, p.r)))
    .join(' ');
}

export interface CursorThumbPart {
  d: string;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

/** Per-part SVG render list for the panel thumbnail — generated from the SAME
 *  part data the insert uses, so the card is faithful by construction.
 *  `accent` fills in any part that has no explicit colour. */
export function cursorThumbParts(id: string, accent: string): CursorThumbPart[] {
  const parts = DESIGNS[id]?.parts ?? [];
  return parts.map((p) => {
    if (p.kind === 'path') {
      return {
        d: polyD(p.pts),
        fill: p.fill ?? accent,
        stroke: p.stroke?.color ?? 'rgba(0,0,0,0.35)',
        strokeWidth: p.stroke?.width ?? 2,
      };
    }
    if (p.kind === 'disc') return { d: circleD(p.cx, p.cy, p.r), fill: p.fill ?? accent };
    return { d: circleD(p.cx, p.cy, p.r), fill: 'none', stroke: p.color ?? accent, strokeWidth: p.width };
  });
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

/** A closed vector path layer (design-box points, centred on (x,y), scaled by `k` px/unit). */
function addPath(
  graph: SceneGraph, id: string, parent: string, name: string,
  pts: readonly Pt[], x: number, y: number, k: number, fill: string,
  stroke?: { color: string; width: number },
): string {
  const half = CURSOR_DESIGN_BOX / 2;
  const points = pts.map((p) => corner((p.x - half) * k, (p.y - half) * k));
  const components: SceneNode['components'] = [
    { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: CURSOR_DESIGN_BOX * k, height: CURSOR_DESIGN_BOX * k, shapeType: 'path' } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
    { id: `${id}_g`, type: 'Geometry', props: { points } },
  ];
  if (stroke) {
    components.push({
      id: `${id}_fx`, type: 'fx',
      props: { stroke: { enabled: true, color: stroke.color, width: stroke.width, opacity: 1, cap: 'round', join: 'round', align: 'center', dash: [] } },
    });
  }
  const node = { id, name, parent, children: [], transform: tf(x, y), visible: true, locked: false, components } as unknown as SceneNode;
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

/** Realise one design part as a scene node. `k` = pixels per design unit. */
function addPart(
  graph: SceneGraph, parent: string, part: CursorPart, index: number, k: number, accent: string,
): string {
  const half = CURSOR_DESIGN_BOX / 2;
  if (part.kind === 'path') {
    return addPath(graph, nid('cpart'), parent, `Shape ${index + 1}`, part.pts, 0, 0, k, part.fill ?? accent, part.stroke);
  }
  if (part.kind === 'disc') {
    return addEllipse(
      graph, nid('cpart'), parent, `Disc ${index + 1}`,
      (part.cx - half) * k, (part.cy - half) * k, part.r * 2 * k, part.r * 2 * k, part.fill ?? accent,
    );
  }
  return addEllipse(
    graph, nid('cpart'), parent, `Ring ${index + 1}`,
    (part.cx - half) * k, (part.cy - half) * k, part.r * 2 * k, part.r * 2 * k, 'rgba(0,0,0,0)',
    { color: part.color ?? accent, width: Math.max(1, part.width * k) },
  );
}

// ── Choreographies (seconds relative to t0; replayed via SetKf) ────

function pulseRing(set: SetKf, ringId: string, t0: number, delay: number): void {
  set(ringId, 'scaleX', t0 + delay, 0.2, 'easeOut');
  set(ringId, 'scaleY', t0 + delay, 0.2, 'easeOut');
  set(ringId, 'opacity', t0 + delay, 90, 'easeOut');
  set(ringId, 'scaleX', t0 + delay + 0.55, 1.6, 'easeOut');
  set(ringId, 'scaleY', t0 + delay + 0.55, 1.6, 'easeOut');
  set(ringId, 'opacity', t0 + delay + 0.55, 0, 'easeOut');
}

function trailDot(set: SetKf, dotId: string, t0: number, delay: number, x0: number, y0: number, dx: number, dy: number): void {
  set(dotId, 'x', t0 + delay, dx, 'easeOut');
  set(dotId, 'y', t0 + delay, dy, 'easeOut');
  set(dotId, 'opacity', t0 + delay, 80, 'easeOut');
  set(dotId, 'x', t0 + delay + 0.6, x0, 'easeOut');
  set(dotId, 'y', t0 + delay + 0.6, y0, 'easeOut');
  set(dotId, 'opacity', t0 + delay + 0.6, 0, 'easeOut');
}

/** Orbit a node around the group centre — the busy-spinner sweep. */
function orbit(set: SetKf, dotId: string, t0: number, radiusPx: number, periodSec: number): void {
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    set(dotId, 'x', t0 + (i / steps) * periodSec, Math.sin(a) * radiusPx, 'linear');
    set(dotId, 'y', t0 + (i / steps) * periodSec, -Math.cos(a) * radiusPx, 'linear');
  }
}

/**
 * Insert a cursor library item into the live composition at (x, y) — comp
 * centre when omitted. Animated items get their keyframe choreography starting
 * at the playhead (canonical time mapping via liveKf → compToKeyframeTime).
 * Returns the inserted root node id, or null for an unknown id.
 */
export function insertCursorItem(cursorId: string, x?: number, y?: number): string | null {
  const item = getCursorItem(cursorId);
  const design = DESIGNS[cursorId];
  if (!item || !design) return null;
  const comp = useCompositionStore.getState();
  const u = (comp.height || 720) / 720;
  const px = x ?? comp.width / 2;
  const py = y ?? comp.height / 2;
  const rootId = activeCompRootId();
  const ws = useWorkspaceStore.getState();
  const t0 = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;

  const g = defaultSceneGraph;
  const groupId = addGroup(g, nid('cursor'), rootId, item.name, px, py);
  const k = (design.size / CURSOR_DESIGN_BOX) * u; // px per design unit

  const partIds = design.parts.map((part, i) => addPart(g, groupId, part, i, k, item.color));

  switch (cursorId) {
    case 'cur-busy': {
      // Orbit the head dot around the faint track (1.2s sweep).
      orbit(liveKf, partIds[1]!, t0, 34 * k, 1.2);
      break;
    }
    case 'cur-click-ripple': {
      pulseRing(liveKf, partIds[0]!, t0, 0);
      break;
    }
    case 'cur-double-burst': {
      pulseRing(liveKf, partIds[0]!, t0, 0);
      pulseRing(liveKf, partIds[1]!, t0, 0.18);
      break;
    }
    case 'cur-spotlight': {
      for (const id of partIds) {
        liveKf(id, 'scaleX', t0, 0.94, 'easeInOut'); liveKf(id, 'scaleX', t0 + 0.8, 1.05, 'easeInOut'); liveKf(id, 'scaleX', t0 + 1.6, 0.94, 'easeInOut');
        liveKf(id, 'scaleY', t0, 0.94, 'easeInOut'); liveKf(id, 'scaleY', t0 + 0.8, 1.05, 'easeInOut'); liveKf(id, 'scaleY', t0 + 1.6, 0.94, 'easeInOut');
      }
      break;
    }
    case 'cur-glow-trail': {
      // The three trail dots sweep further down-left then return home.
      const half = CURSOR_DESIGN_BOX / 2;
      const dots: ReadonlyArray<{ cx: number; cy: number }> = [
        { cx: 34, cy: 66 }, { cx: 24, cy: 76 }, { cx: 16, cy: 84 },
      ];
      dots.forEach((d, i) => {
        const x0 = (d.cx - half) * k;
        const y0 = (d.cy - half) * k;
        trailDot(liveKf, partIds[i]!, t0, i * 0.08, x0, y0, x0 - 26 * u * (i + 1), y0 + 26 * u * (i + 1));
      });
      break;
    }
    default:
      break; // static designs — no choreography
  }

  useSelectionStore.getState().set([groupId]);
  getTimelineController().syncFromScene();
  bumpScene();
  return groupId;
}
