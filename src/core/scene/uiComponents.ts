/**
 * uiComponents — one-click insertable UI mock-ups (browser, phone, card,
 * button, chat bubble, chart, notification). Each inserts a GROUP of ordinary
 * editable primitives (shape + text nodes) at the composition centre and
 * selects it, so the user can move it, restyle it, and keyframe it like any
 * other layer. These are the building blocks a designer needs to assemble a
 * SaaS-style ad by hand (previously only available via the code demo).
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

/** An editable rounded-rect shape with width/height + fill (relative to parent). */
function shape(parent: string, name: string, x: number, y: number, w: number, h: number, fill: string, extra?: Component[]): string {
  const id = uid('s');
  const comps: Component[] = [
    { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: w, height: h } },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
    ...(extra ?? []),
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

function finish(g: string): string {
  useSelectionStore.getState().set([g]);
  bumpScene();
  return g;
}

// ── Component presets ─────────────────────────────────────────────────

export function insertBrowserMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Browser', cx, cy);
  shape(g, 'Window', 0, 0, 900, 560, PALETTE.panel);
  shape(g, 'Title Bar', 0, -248, 900, 64, PALETTE.panelHi);
  shape(g, 'Close', -410, -248, 18, 18, PALETTE.pink);
  shape(g, 'Min', -378, -248, 18, 18, PALETTE.amber);
  shape(g, 'Max', -346, -248, 18, 18, PALETTE.green);
  shape(g, 'URL Bar', 40, -248, 540, 30, PALETTE.faint);
  text(g, 'URL', 40, -248, 20, 500, PALETTE.sub, 'center');
  shape(g, 'Sidebar', -320, 40, 220, 420, PALETTE.panelHi);
  shape(g, 'Content Line 1', 120, -80, 480, 26, PALETTE.faint);
  shape(g, 'Content Line 2', 60, -30, 360, 26, PALETTE.faint);
  shape(g, 'Accent Block', 160, 90, 560, 160, 'rgba(99,91,255,0.14)');
  return finish(g);
}

export function insertPhoneMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Phone', cx, cy);
  shape(g, 'Body', 0, 0, 380, 760, '#0c0c14');
  shape(g, 'Screen', 0, 0, 340, 720, PALETTE.panel);
  shape(g, 'Notch', 0, -330, 130, 26, '#0c0c14');
  shape(g, 'Status', 0, -300, 300, 20, PALETTE.faint);
  shape(g, 'Card', 0, -150, 300, 120, PALETTE.panelHi);
  shape(g, 'Row 1', 0, 20, 300, 60, PALETTE.panelHi);
  shape(g, 'Row 2', 0, 100, 300, 60, PALETTE.panelHi);
  shape(g, 'CTA', 0, 250, 260, 64, PALETTE.accent);
  text(g, 'Button', 0, 250, 24, 700, PALETTE.ink, 'center');
  return finish(g);
}

export function insertCardMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Card', cx, cy);
  shape(g, 'Panel', 0, 0, 380, 300, PALETTE.panel);
  shape(g, 'Icon Chip', -120, -90, 84, 84, PALETTE.accent);
  text(g, 'Title', -70, -10, 34, 700, PALETTE.ink, 'left');
  text(g, 'Body', -150, 50, 22, 400, PALETTE.sub, 'left');
  text(g, 'Body 2', -150, 84, 22, 400, PALETTE.sub, 'left');
  return finish(g);
}

export function insertButtonMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Button', cx, cy);
  shape(g, 'Fill', 0, 0, 300, 84, PALETTE.accent);
  text(g, 'Label', 0, 0, 34, 700, PALETTE.ink, 'center');
  return finish(g);
}

export function insertChatBubble(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Chat Bubble', cx, cy);
  shape(g, 'Bubble', 0, 0, 360, 90, PALETTE.accent);
  text(g, 'Message', 0, 0, 22, 500, PALETTE.ink, 'center');
  return finish(g);
}

export function insertNotification(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Notification', cx, cy);
  shape(g, 'Card', 0, 0, 340, 84, PALETTE.panelHi);
  shape(g, 'Icon', -128, 0, 48, 48, PALETTE.green);
  text(g, 'Title', 20, -12, 20, 600, PALETTE.ink, 'center');
  text(g, 'Subtitle', 20, 14, 16, 400, PALETTE.sub, 'center');
  return finish(g);
}

export function insertChartMock(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Chart', cx, cy);
  shape(g, 'Panel', 0, 0, 700, 460, PALETTE.panel);
  text(g, 'Metric', -300, -170, 34, 800, PALETTE.ink, 'left');
  const vals = [0.45, 0.68, 0.55, 0.82, 1.0];
  vals.forEach((v, i) => {
    const h = Math.max(24, v * 240);
    shape(g, `Bar ${i + 1}`, -240 + i * 120, 130 - h / 2, 64, h, i === vals.length - 1 ? PALETTE.cyan : PALETTE.accent);
  });
  shape(g, 'Baseline', 0, 132, 620, 3, PALETTE.faint);
  return finish(g);
}

export function insertAvatar(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Avatar', cx, cy);
  disc(g, 'Ring', 0, 0, 120, PALETTE.accent);
  disc(g, 'Photo', 0, 0, 104, PALETTE.panelHi);
  text(g, 'Initials', 0, 0, 40, 700, PALETTE.ink, 'center');
  disc(g, 'Status', 40, 40, 26, PALETTE.green);
  return finish(g);
}

export function insertToggle(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Toggle', cx, cy);
  shape(g, 'Track', 0, 0, 96, 48, PALETTE.accent);
  disc(g, 'Knob', 24, 0, 38, PALETTE.ink);
  return finish(g);
}

export function insertInputField(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Input Field', cx, cy);
  shape(g, 'Field', 0, 0, 460, 64, PALETTE.panelHi);
  text(g, 'Placeholder', -200, 0, 22, 400, PALETTE.sub, 'left');
  shape(g, 'Caret', -196, 0, 3, 30, PALETTE.accent);
  return finish(g);
}

export function insertProgressBar(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Progress', cx, cy);
  shape(g, 'Track', 0, 0, 460, 16, PALETTE.panelHi);
  shape(g, 'Fill', -115, 0, 230, 16, PALETTE.accent);
  text(g, '50%', 210, 0, 22, 600, PALETTE.sub, 'left');
  return finish(g);
}

export function insertStatTile(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Stat Tile', cx, cy);
  shape(g, 'Panel', 0, 0, 300, 180, PALETTE.panel);
  text(g, 'Label', -110, -50, 20, 500, PALETTE.sub, 'left');
  text(g, '12,480', -110, 0, 56, 800, PALETTE.ink, 'left');
  text(g, '+18%', -110, 50, 22, 600, PALETTE.green, 'left');
  return finish(g);
}

export function insertTabs(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Tabs', cx, cy);
  shape(g, 'Bar', 0, 0, 480, 56, PALETTE.panelHi);
  shape(g, 'Active Pill', -150, 0, 140, 40, PALETTE.accent);
  text(g, 'Overview', -150, 0, 20, 600, PALETTE.ink, 'center');
  text(g, 'Activity', 0, 0, 20, 500, PALETTE.sub, 'center');
  text(g, 'Settings', 150, 0, 20, 500, PALETTE.sub, 'center');
  return finish(g);
}

export function insertTableRow(): string {
  const { cx, cy } = compCenter();
  const g = group('__root__', 'Table Row', cx, cy);
  shape(g, 'Row', 0, 0, 600, 64, PALETTE.panel);
  disc(g, 'Avatar', -250, 0, 40, PALETTE.accent);
  text(g, 'Name', -160, 0, 22, 600, PALETTE.ink, 'left');
  text(g, 'Active', 120, 0, 20, 500, PALETTE.green, 'left');
  shape(g, 'Amount', 230, 0, 90, 30, PALETTE.faint);
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

/** All presets, for wiring into the Libraries panel. */
export const UI_COMPONENT_PRESETS: ReadonlyArray<{ id: string; label: string; insert: () => string }> = [
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
