/**
 * uiComponents — one-click insertable UI mock-ups (browser, phone, card,
 * button, chat bubble, chart, notification). Each inserts a GROUP of ordinary
 * editable primitives (shape + text nodes) at the composition centre and
 * selects it, so the user can move it, restyle it, and keyframe it like any
 * other layer. These are the building blocks a designer needs to assemble a
 * SaaS-style ad by hand.
 *
 * Design language: one shared PALETTE, corner radii on a 6/10/16 rhythm,
 * realistic proportions (traffic lights are discs, status bars carry real
 * glyph clusters, charts have axes + gridlines + two series and a line).
 */

import type { SceneNode, Component, Transform } from '@core/types';
import defaultSceneGraph from './DefaultSceneGraph';
import { activeCompRootId } from './activeComp';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';

let seq = 0;
const uid = (p: string) => `${p}_${(seq += 1)}_${Math.random().toString(36).slice(2, 5)}`;

const PALETTE = { ink: '#ffffff', sub: '#9aa3c0', accent: '#635bff', cyan: '#22d3ee', green: '#34d399', pink: '#f472b6', amber: '#fbbf24', panel: '#14141f', panelHi: '#1c1c2b', faint: 'rgba(255,255,255,0.06)' };
const FAINT2 = 'rgba(255,255,255,0.12)';
const ACCENT_DIM = 'rgba(99,91,255,0.16)';

function tf(x: number, y: number, rot = 0): Transform {
  return { position: { x, y }, rotation: rot, scale: { x: 1, y: 1 } };
}
function compCenter(): { cx: number; cy: number } {
  const s = useCompositionStore.getState();
  return { cx: (s.width ?? 1920) / 2, cy: (s.height ?? 1080) / 2 };
}

function rootId(): string {
  return activeCompRootId();
}

/** A group container (structural, holds children so they move together).
 *  `'__root__'` resolves to the composition root. */
function group(parent: string, name: string, x: number, y: number): string {
  const p = parent === '__root__' ? rootId() : parent;
  const id = uid('g');
  const node: SceneNode = { id, name, parent: p, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }] } as unknown as SceneNode;
  defaultSceneGraph.addChild(p, node);
  return id;
}

interface ShapeOpts { radius?: number; rotation?: number; opacity?: number; extra?: Component[] }

/** An editable rounded-rect shape with width/height + fill (relative to parent).
 *  The last argument accepts either extra components (legacy) or ShapeOpts. */
function shape(parent: string, name: string, x: number, y: number, w: number, h: number, fill: string, extraOrOpts?: Component[] | ShapeOpts): string {
  const opts: ShapeOpts = Array.isArray(extraOrOpts) ? { extra: extraOrOpts } : (extraOrOpts ?? {});
  const id = uid('s');
  const comps: Component[] = [
    { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: opts.rotation ?? 0, width: w, height: h, ...(opts.radius ? { cornerRadius: opts.radius } : {}) } },
    { id: `${id}_s`, type: 'Style', props: { opacity: opts.opacity ?? 100, fill } },
    ...(opts.extra ?? []),
  ];
  const node: SceneNode = { id, name, parent, children: [], visible: true, locked: false, transform: tf(x, y), components: comps } as unknown as SceneNode;
  defaultSceneGraph.addChild(parent, node);
  return id;
}

/** An editable ellipse (true circle when w === h). */
function disc(parent: string, name: string, x: number, y: number, d: number, fill: string): string {
  const id = uid('s');
  const node: SceneNode = { id, name, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: d, height: d, shapeType: 'ellipse' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
    ] } as unknown as SceneNode;
  defaultSceneGraph.addChild(parent, node);
  return id;
}

function text(parent: string, content: string, x: number, y: number, size: number, weight = 600, fill = PALETTE.ink, align = 'left'): string {
  const id = uid('t');
  const node: SceneNode = { id, name: content, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x, y, rotation: 0 } },
      { id: `${id}_c`, type: 'Text', props: { content, fontSize: size, fontWeight: weight, opacity: 100, fill, align } },
    ] } as unknown as SceneNode;
  defaultSceneGraph.addChild(parent, node);
  return id;
}

/** A thin bar between two points — the segment primitive for line charts. */
function segment(parent: string, name: string, x0: number, y0: number, x1: number, y1: number, thickness: number, fill: string): string {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const rot = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  return shape(parent, name, (x0 + x1) / 2, (y0 + y1) / 2, len, thickness, fill, { rotation: rot, radius: thickness / 2 });
}

/** macOS traffic lights (real discs, correct order + spacing). */
function trafficLights(parent: string, x: number, y: number): void {
  disc(parent, 'Close', x, y, 16, PALETTE.pink);
  disc(parent, 'Min', x + 28, y, 16, PALETTE.amber);
  disc(parent, 'Max', x + 56, y, 16, PALETTE.green);
}

/** Skeleton text line (rounded, faint). */
function skel(parent: string, name: string, x: number, y: number, w: number, h = 18, fill = PALETTE.faint): string {
  return shape(parent, name, x, y, w, h, fill, { radius: h / 2 });
}

function finish(g: string): string {
  useSelectionStore.getState().set([g]);
  bumpScene();
  return g;
}

// ── Component presets ─────────────────────────────────────────────────

export function insertBrowserMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Browser', cx, cy);
  shape(g, 'Window', 0, 0, 900, 560, PALETTE.panel, { radius: 16 });

  // Tab strip above the toolbar.
  shape(g, 'Tab Strip', 0, -262, 900, 36, '#0f0f18', { radius: 16 });
  shape(g, 'Tab Active', -270, -258, 190, 28, PALETTE.panelHi, { radius: 8 });
  disc(g, 'Tab Favicon', -348, -258, 12, PALETTE.accent);
  text(g, 'Dashboard', -330, -258, 14, 600, PALETTE.ink, 'left');
  shape(g, 'Tab Inactive', -70, -258, 180, 28, PALETTE.faint, { radius: 8 });
  text(g, 'Analytics', -140, -258, 14, 500, PALETTE.sub, 'left');
  text(g, '+', 40, -259, 18, 500, PALETTE.sub, 'center');

  // Toolbar: traffic lights, nav arrows, padlocked URL pill.
  shape(g, 'Toolbar', 0, -224, 900, 44, PALETTE.panelHi);
  trafficLights(g, -416, -224);
  text(g, '‹', -330, -226, 22, 700, PALETTE.sub, 'center');
  text(g, '›', -298, -226, 22, 700, PALETTE.sub, 'center');
  text(g, '⟳', -266, -225, 17, 600, PALETTE.sub, 'center');
  shape(g, 'URL Pill', 40, -224, 520, 30, PALETTE.faint, { radius: 15 });
  disc(g, 'Padlock', -196, -224, 12, PALETTE.green);
  text(g, 'app.example.com/dashboard', -178, -224, 15, 500, PALETTE.sub, 'left');
  disc(g, 'Profile', 424, -224, 24, PALETTE.accent);

  // Sidebar with an active nav pill + rows.
  shape(g, 'Sidebar', -336, 89, 228, 462, '#101019');
  shape(g, 'Nav Active', -336, -96, 196, 38, ACCENT_DIM, { radius: 10 });
  disc(g, 'Nav Icon 1', -412, -96, 14, PALETTE.accent);
  skel(g, 'Nav Label 1', -350, -96, 100, 12, FAINT2);
  for (let i = 0; i < 3; i++) {
    disc(g, `Nav Icon ${i + 2}`, -412, -44 + i * 52, 14, FAINT2);
    skel(g, `Nav Label ${i + 2}`, -352 + i * 8, -44 + i * 52, 96 - i * 16, 12);
  }

  // Content: hero block, heading skeleton, body lines, two cards.
  shape(g, 'Hero Block', 122, -88, 600, 150, ACCENT_DIM, { radius: 12 });
  skel(g, 'Hero Title', -56, -116, 220, 20, FAINT2);
  skel(g, 'Hero Line', -32, -80, 268, 12);
  shape(g, 'Hero CTA', -110, -38, 128, 34, PALETTE.accent, { radius: 17 });
  skel(g, 'Body Line 1', 66, 16, 488, 12);
  skel(g, 'Body Line 2', 26, 44, 408, 12);
  shape(g, 'Card A', -20, 160, 316, 150, PALETTE.panelHi, { radius: 12 });
  skel(g, 'Card A Line', -92, 128, 140, 12, FAINT2);
  shape(g, 'Card A Chart', -20, 182, 276, 70, PALETTE.faint, { radius: 8 });
  shape(g, 'Card B', 306, 160, 288, 150, PALETTE.panelHi, { radius: 12 });
  skel(g, 'Card B Line', 240, 128, 120, 12, FAINT2);
  disc(g, 'Card B Ring', 306, 186, 74, ACCENT_DIM);
  disc(g, 'Card B Core', 306, 186, 46, PALETTE.panelHi);
  return finish(g);
}

export function insertPhoneMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Phone', cx, cy);
  shape(g, 'Body', 0, 0, 380, 780, '#0c0c14', { radius: 56 });
  shape(g, 'Screen', 0, 0, 348, 748, PALETTE.panel, { radius: 44 });
  // Dynamic island + status glyphs.
  shape(g, 'Dynamic Island', 0, -334, 110, 28, '#06060c', { radius: 14 });
  text(g, '9:41', -128, -334, 17, 700, PALETTE.ink, 'center');
  shape(g, 'Signal', 92, -334, 20, 12, FAINT2, { radius: 3 });
  shape(g, 'Wifi', 118, -334, 16, 12, FAINT2, { radius: 3 });
  shape(g, 'Battery', 146, -334, 26, 13, PALETTE.green, { radius: 5 });

  // Chat layout: header, incoming/outgoing bubbles, input, home indicator.
  disc(g, 'Contact Avatar', -128, -282, 40, PALETTE.accent);
  text(g, 'Alex', -98, -290, 18, 700, PALETTE.ink, 'left');
  text(g, 'online', -98, -270, 12, 500, PALETTE.green, 'left');
  shape(g, 'In Bubble 1', -66, -204, 196, 52, PALETTE.panelHi, { radius: 18 });
  skel(g, 'In Text 1', -84, -204, 150, 11, FAINT2);
  shape(g, 'In Bubble 2', -42, -138, 244, 52, PALETTE.panelHi, { radius: 18 });
  skel(g, 'In Text 2', -62, -138, 194, 11, FAINT2);
  shape(g, 'Out Bubble 1', 62, -70, 204, 52, PALETTE.accent, { radius: 18 });
  skel(g, 'Out Text 1', 46, -70, 158, 11, 'rgba(255,255,255,0.45)');
  shape(g, 'In Bubble 3', -86, -2, 156, 52, PALETTE.panelHi, { radius: 18 });
  skel(g, 'In Text 3', -98, -2, 116, 11, FAINT2);
  shape(g, 'Out Bubble 2', 34, 66, 260, 52, PALETTE.accent, { radius: 18 });
  skel(g, 'Out Text 2', 14, 66, 208, 11, 'rgba(255,255,255,0.45)');
  text(g, 'Read 9:41', 116, 104, 11, 500, PALETTE.sub, 'right');

  shape(g, 'Input Bar', -22, 306, 252, 46, PALETTE.panelHi, { radius: 23 });
  text(g, 'Message…', -126, 306, 15, 500, PALETTE.sub, 'left');
  disc(g, 'Send', 136, 306, 46, PALETTE.accent);
  text(g, '➤', 136, 305, 18, 700, PALETTE.ink, 'center');
  shape(g, 'Home Indicator', 0, 358, 130, 5, FAINT2, { radius: 2.5 });
  return finish(g);
}

export function insertCardMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Card', cx, cy);
  shape(g, 'Panel', 0, 0, 400, 420, PALETTE.panel, { radius: 20 });
  // Header: avatar + name/handle + menu dots.
  disc(g, 'Avatar Ring', -152, -164, 56, PALETTE.accent);
  disc(g, 'Avatar', -152, -164, 46, PALETTE.panelHi);
  text(g, 'AL', -152, -164, 17, 700, PALETTE.ink, 'center');
  text(g, 'Alex Lane', -112, -174, 19, 700, PALETTE.ink, 'left');
  text(g, '@alexlane · 2h', -112, -152, 14, 500, PALETTE.sub, 'left');
  for (let i = 0; i < 3; i++) disc(g, `Menu Dot ${i + 1}`, 150 + i * 12, -166, 5, PALETTE.sub);
  // Body copy + image block.
  skel(g, 'Copy 1', -14, -114, 344, 12, FAINT2);
  skel(g, 'Copy 2', -48, -88, 276, 12, FAINT2);
  shape(g, 'Image', 0, 40, 360, 200, ACCENT_DIM, { radius: 14 });
  disc(g, 'Image Sun', -108, -6, 52, 'rgba(255,255,255,0.14)');
  shape(g, 'Image Hill', 40, 96, 300, 70, 'rgba(255,255,255,0.10)', { radius: 35, rotation: -6 });
  // Action row: like / comment / share with counts.
  disc(g, 'Like', -132, 176, 26, 'rgba(244,114,182,0.22)');
  text(g, '♥', -132, 175, 15, 700, PALETTE.pink, 'center');
  text(g, '1.2k', -104, 176, 14, 600, PALETTE.sub, 'left');
  disc(g, 'Comment', -18, 176, 26, 'rgba(34,211,238,0.18)');
  text(g, '◧', -18, 175, 14, 700, PALETTE.cyan, 'center');
  text(g, '86', 10, 176, 14, 600, PALETTE.sub, 'left');
  disc(g, 'Share', 92, 176, 26, PALETTE.faint);
  text(g, '↗', 92, 175, 15, 700, PALETTE.sub, 'center');
  return finish(g);
}

export function insertButtonMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Button', cx, cy);
  shape(g, 'Glow', 0, 6, 300, 84, 'rgba(99,91,255,0.35)', { radius: 42 });
  shape(g, 'Fill', 0, 0, 300, 84, PALETTE.accent, { radius: 42 });
  shape(g, 'Top Sheen', 0, -18, 268, 30, 'rgba(255,255,255,0.14)', { radius: 15 });
  text(g, 'Get started', -14, 0, 30, 700, PALETTE.ink, 'center');
  text(g, '→', 106, -1, 28, 700, PALETTE.ink, 'center');
  return finish(g);
}

export function insertChatBubble(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Chat Bubble', cx, cy);
  shape(g, 'Bubble', 0, 0, 380, 96, PALETTE.accent, { radius: 24 });
  shape(g, 'Tail', -168, 48, 26, 26, PALETTE.accent, { rotation: 45, radius: 6 });
  text(g, 'Hey! The new build is live 🎉', -160, -10, 20, 600, PALETTE.ink, 'left');
  text(g, '9:41', 128, 26, 13, 500, 'rgba(255,255,255,0.7)', 'left');
  text(g, '✓✓', 158, 26, 13, 700, PALETTE.cyan, 'left');
  return finish(g);
}

export function insertNotification(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Notification', cx, cy);
  shape(g, 'Card', 0, 0, 380, 96, PALETTE.panelHi, { radius: 20 });
  shape(g, 'App Icon', -146, 0, 52, 52, PALETTE.accent, { radius: 14 });
  text(g, '✦', -146, -1, 24, 700, PALETTE.ink, 'center');
  text(g, 'Deployment complete', -106, -18, 17, 700, PALETTE.ink, 'left');
  text(g, 'production • all checks passed', -106, 6, 14, 500, PALETTE.sub, 'left');
  skel(g, 'Detail', -46, 28, 120, 8);
  text(g, 'now', 148, -22, 12, 500, PALETTE.sub, 'left');
  disc(g, 'Unread', 168, 8, 10, PALETTE.cyan);
  return finish(g);
}

export function insertChartMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Chart', cx, cy);
  shape(g, 'Panel', 0, 0, 700, 460, PALETTE.panel, { radius: 18 });
  text(g, 'Revenue', -310, -186, 28, 800, PALETTE.ink, 'left');
  text(g, '$48.2k', -310, -150, 20, 700, PALETTE.green, 'left');
  // Legend.
  disc(g, 'Legend A', 170, -184, 12, PALETTE.accent);
  text(g, '2025', 184, -184, 14, 600, PALETTE.sub, 'left');
  disc(g, 'Legend B', 250, -184, 12, PALETTE.cyan);
  text(g, '2026', 264, -184, 14, 600, PALETTE.sub, 'left');

  // Plot frame: axes + gridlines.
  const x0 = -280, x1 = 310, yBase = 156, yTop = -96;
  shape(g, 'Axis Y', x0 - 12, (yBase + yTop) / 2, 2, yBase - yTop, FAINT2);
  shape(g, 'Axis X', (x0 + x1) / 2 - 12, yBase, x1 - x0 + 4, 2, FAINT2);
  for (let i = 1; i <= 3; i++) {
    shape(g, `Gridline ${i}`, (x0 + x1) / 2 - 12, yBase - i * 63, x1 - x0 + 4, 1, PALETTE.faint);
  }

  // Two bar series (5 groups) + a line series with point dots.
  const a = [0.42, 0.6, 0.5, 0.76, 0.92];
  const b = [0.3, 0.45, 0.62, 0.55, 0.8];
  const line = [0.5, 0.42, 0.68, 0.62, 0.88];
  const span = yBase - yTop - 12;
  const step = (x1 - x0) / 5;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 5; i++) {
    const gx = x0 + step * (i + 0.5);
    const ha = Math.max(20, a[i]! * span);
    const hb = Math.max(20, b[i]! * span);
    shape(g, `Bar A${i + 1}`, gx - 17, yBase - ha / 2, 28, ha, PALETTE.accent, { radius: 6 });
    shape(g, `Bar B${i + 1}`, gx + 17, yBase - hb / 2, 28, hb, 'rgba(34,211,238,0.55)', { radius: 6 });
    pts.push([gx, yBase - line[i]! * span - 16]);
    skel(g, `Tick ${i + 1}`, gx, yBase + 18, 34, 8);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    segment(g, `Line Seg ${i + 1}`, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1], 4, PALETTE.amber);
  }
  pts.forEach(([px, py], i) => {
    disc(g, `Point ${i + 1}`, px, py, 12, PALETTE.panel);
    disc(g, `Point Core ${i + 1}`, px, py, 8, PALETTE.amber);
  });
  return finish(g);
}

export function insertAvatar(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Avatar', cx, cy);
  disc(g, 'Ring', 0, 0, 124, PALETTE.accent);
  disc(g, 'Gap', 0, 0, 112, PALETTE.panel);
  disc(g, 'Photo', 0, 0, 100, PALETTE.panelHi);
  text(g, 'AL', 0, 0, 36, 700, PALETTE.ink, 'center');
  disc(g, 'Status Border', 42, 42, 32, PALETTE.panel);
  disc(g, 'Status', 42, 42, 24, PALETTE.green);
  return finish(g);
}

export function insertToggle(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Toggle', cx, cy);
  shape(g, 'Track', 0, 0, 96, 52, PALETTE.accent, { radius: 26 });
  disc(g, 'Knob Shadow', 24, 3, 42, 'rgba(0,0,0,0.25)');
  disc(g, 'Knob', 24, 0, 42, PALETTE.ink);
  text(g, '✓', 24, -1, 18, 800, PALETTE.accent, 'center');
  return finish(g);
}

export function insertInputField(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Input Field', cx, cy);
  text(g, 'EMAIL', -222, -46, 13, 700, PALETTE.sub, 'left');
  shape(g, 'Focus Ring', 0, 4, 472, 72, 'rgba(99,91,255,0.35)', { radius: 18 });
  shape(g, 'Field', 0, 4, 460, 62, PALETTE.panelHi, { radius: 14 });
  disc(g, 'Field Icon', -196, 4, 22, PALETTE.faint);
  text(g, 'you@company.com', -168, 4, 20, 500, PALETTE.sub, 'left');
  shape(g, 'Caret', 20, 4, 2.5, 28, PALETTE.accent);
  return finish(g);
}

export function insertProgressBar(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Progress', cx, cy);
  text(g, 'Uploading assets…', -230, -26, 15, 600, PALETTE.sub, 'left');
  shape(g, 'Track', 0, 0, 460, 16, PALETTE.panelHi, { radius: 8 });
  shape(g, 'Fill', -69, 0, 322, 16, PALETTE.accent, { radius: 8 });
  disc(g, 'Head', 92, 0, 24, PALETTE.ink);
  text(g, '70%', 210, 0, 22, 700, PALETTE.ink, 'left');
  return finish(g);
}

export function insertStatTile(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Stat Tile', cx, cy);
  shape(g, 'Panel', 0, 0, 320, 200, PALETTE.panel, { radius: 16 });
  text(g, 'ACTIVE USERS', -128, -66, 14, 700, PALETTE.sub, 'left');
  disc(g, 'Icon', 116, -62, 34, ACCENT_DIM);
  text(g, '◉', 116, -63, 16, 700, PALETTE.accent, 'center');
  text(g, '12,480', -128, -14, 46, 800, PALETTE.ink, 'left');
  shape(g, 'Delta Pill', -92, 42, 84, 30, 'rgba(52,211,153,0.18)', { radius: 15 });
  text(g, '▲ 18%', -92, 42, 15, 700, PALETTE.green, 'center');
  // Mini sparkline.
  const sp = [0.3, 0.5, 0.4, 0.65, 0.55, 0.85];
  sp.forEach((v, i) => {
    shape(g, `Spark ${i + 1}`, 34 + i * 18, 58 - (v * 44) / 2, 10, v * 44, i === sp.length - 1 ? PALETTE.green : FAINT2, { radius: 4 });
  });
  return finish(g);
}

export function insertTabs(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Tabs', cx, cy);
  shape(g, 'Bar', 0, 0, 480, 56, PALETTE.panelHi, { radius: 28 });
  shape(g, 'Active Pill', -150, 0, 148, 42, PALETTE.accent, { radius: 21 });
  text(g, 'Overview', -150, 0, 19, 700, PALETTE.ink, 'center');
  text(g, 'Activity', 0, 0, 19, 500, PALETTE.sub, 'center');
  disc(g, 'Badge', 46, -12, 16, PALETTE.pink);
  text(g, '3', 46, -13, 11, 800, PALETTE.ink, 'center');
  text(g, 'Settings', 152, 0, 19, 500, PALETTE.sub, 'center');
  return finish(g);
}

export function insertTableRow(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Table Row', cx, cy);
  shape(g, 'Row', 0, 0, 640, 72, PALETTE.panel, { radius: 14 });
  disc(g, 'Avatar', -272, 0, 44, PALETTE.accent);
  text(g, 'AL', -272, -1, 15, 700, PALETTE.ink, 'center');
  text(g, 'Alex Lane', -232, -12, 18, 700, PALETTE.ink, 'left');
  text(g, 'alex@company.com', -232, 12, 13, 500, PALETTE.sub, 'left');
  shape(g, 'Status Pill', 44, 0, 96, 30, 'rgba(52,211,153,0.16)', { radius: 15 });
  disc(g, 'Status Dot', 10, 0, 8, PALETTE.green);
  text(g, 'Active', 52, 0, 14, 700, PALETTE.green, 'center');
  text(g, '$1,284', 220, 0, 18, 700, PALETTE.ink, 'left');
  for (let i = 0; i < 3; i++) disc(g, `Row Menu ${i + 1}`, 292, -8 + i * 8, 4, PALETTE.sub);
  return finish(g);
}

export function insertCursor(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Cursor', cx, cy);
  disc(g, 'Click Ripple', 0, 6, 60, 'rgba(99,91,255,0.35)');
  shape(g, 'Pointer', 0, 0, 26, 26, PALETTE.ink, [
    { id: uid('cg'), type: 'Geometry', props: { points: [
      { x: -13, y: -13, inX: -13, inY: -13, outX: -13, outY: -13 },
      { x: 13, y: 2, inX: 13, inY: 2, outX: 13, outY: 2 },
      { x: 0, y: 4, inX: 0, inY: 4, outX: 0, outY: 4 },
      { x: 6, y: 15, inX: 6, inY: 15, outX: 6, outY: 15 },
      { x: -2, y: 15, inX: -2, inY: 15, outX: -2, outY: 15 },
      { x: -9, y: 6, inX: -9, inY: 6, outX: -9, outY: 6 },
    ] } },
  ]);
  return finish(g);
}

export function insertCodeEditorMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'AI Code Editor', cx, cy);
  // Editor window frame
  shape(g, 'Editor Window', 0, 0, 900, 560, PALETTE.panel, { radius: 16 });
  shape(g, 'Title Bar', 0, -248, 900, 64, PALETTE.panelHi, { radius: 16 });
  trafficLights(g, -410, -248);

  // File Tabs
  shape(g, 'Tab Active', -220, -240, 160, 32, PALETTE.panel, { radius: 8 });
  text(g, 'App.tsx', -200, -242, 16, 600, PALETTE.ink, 'left');
  shape(g, 'Tab Inactive', -50, -240, 160, 32, PALETTE.panelHi, { radius: 8 });
  text(g, 'styles.css', -30, -242, 16, 500, PALETTE.sub, 'left');

  // File Explorer Sidebar
  shape(g, 'File Sidebar', -330, 32, 240, 496, PALETTE.panelHi);
  text(g, 'EXPLORER', -310, -180, 14, 700, PALETTE.sub, 'left');
  text(g, '📁 src', -300, -140, 16, 600, PALETTE.ink, 'left');
  text(g, '  📄 App.tsx', -290, -100, 16, 500, PALETTE.accent, 'left');
  text(g, '  📄 styles.css', -290, -70, 16, 500, PALETTE.sub, 'left');

  // Main coding textarea text layer
  const codeText = "import React from 'react';\n\nfunction App() {\n  return (\n    <div className=\"app\">\n      <h1>AI Code Editor</h1>\n    </div>\n  );\n}";
  text(g, codeText, -180, -160, 18, 400, PALETTE.ink, 'left');
  // Caret (Blinking cursor) at the end of the text
  shape(g, 'Cursor', 60, -20, 2, 22, PALETTE.accent);

  // AI Chat panel
  shape(g, 'AI Panel', 310, 32, 280, 496, PALETTE.panelHi);
  shape(g, 'AI Header', 310, -180, 280, 40, PALETTE.panel);
  text(g, 'AI Assistant', 220, -180, 16, 700, PALETTE.ink, 'left');
  shape(g, 'AI Input', 310, 230, 260, 48, PALETTE.panel, { radius: 12 });
  text(g, 'Ask AI...', 200, 230, 16, 400, PALETTE.sub, 'left');
  shape(g, 'AI Sparkle Button', 420, 230, 32, 32, PALETTE.accent, { radius: 8 });

  return finish(g);
}

/** All presets, for wiring into the Libraries panel. */
export const UI_COMPONENT_PRESETS: ReadonlyArray<{ id: string; label: string; insert: () => string }> = [
  { id: 'code-editor', label: 'AI Code Editor', insert: insertCodeEditorMock },
  { id: 'browser', label: 'Browser', insert: insertBrowserMock },
  { id: 'phone', label: 'Phone', insert: insertPhoneMock },
  { id: 'card', label: 'Card', insert: insertCardMock },
  { id: 'button', label: 'Button', insert: insertButtonMock },
  { id: 'chat', label: 'Chat Bubble', insert: insertChatBubble },
  { id: 'notification', label: 'Notification', insert: insertNotification },
  { id: 'chart', label: 'Chart', insert: insertChartMock },
  { id: 'stat', label: 'Stat Tile', insert: insertStatTile },
  { id: 'avatar', label: 'Avatar', insert: insertAvatar },
  { id: 'toggle', label: 'Toggle', insert: insertToggle },
  { id: 'input', label: 'Input Field', insert: insertInputField },
  { id: 'progress', label: 'Progress', insert: insertProgressBar },
  { id: 'tabs', label: 'Tabs', insert: insertTabs },
  { id: 'tablerow', label: 'Table Row', insert: insertTableRow },
  { id: 'cursor', label: 'Cursor', insert: insertCursor },
];
