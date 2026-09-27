/**
 * Routing the viewport's pointer to a plugin.
 *
 * The rule this pins is the one that decides whether plugin gizmos are usable
 * at all: DRAWING is not a claim on the canvas. A plugin that has put handles
 * on screen owns a press on one of them and nothing else, so the user keeps
 * Select, marquee and layer dragging while its gizmo is visible. A plugin that
 * wants the whole viewport contributes a TOOL, and while that tool is active it
 * gets every press whether it has drawn anything or not.
 *
 * The other half is the undo bracket. A drag is one act to the user and is made
 * of many `scene.setProperty` calls; the claim opens a history bracket and the
 * release closes it, so the drag is one Ctrl-Z.
 */

import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import {
  configurePluginCanvas,
  resetPluginCanvasForTests,
  setPluginDrawList,
  type PluginCanvasEvent,
} from '@core/plugins/uiCanvas';
import {
  pluginToolId,
  registerPluginTools,
  resetPluginToolsForTests,
  setActivePluginTool,
} from '@core/plugins/uiTools';
import {
  cancelPluginGesture,
  pluginKeyDown,
  pluginPointerDown,
  pluginPointerMove,
  pluginPointerUp,
  resetPluginOverlayForTests,
} from './pluginDrawOverlay';
import type { WorkspaceController } from '@core/workspace/WorkspaceController';

const PLUGIN = 'studio.acme.lab';
const NO_MODS = { alt: false, ctrl: false, meta: false, shift: false };

/** A 1:1 camera — comp units are screen pixels, so the arithmetic is readable. */
const controller = {
  ws: {
    camera: {
      worldToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      screenToWorld: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
    },
  },
} as unknown as WorkspaceController;

let seen: PluginCanvasEvent[] = [];

/** Composition space, so the test needs no scene node to resolve a transform. */
const gizmo = (items: unknown[]): unknown => ({ layerId: null, space: 'comp', items });

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  resetPluginCanvasForTests();
  resetPluginToolsForTests();
  resetPluginOverlayForTests();
  seen = [];
  configurePluginCanvas({ deliver: (_id, e) => seen.push(e) });
});

describe('a plugin that has only DRAWN something', () => {
  beforeEach(() => {
    setPluginDrawList(PLUGIN, gizmo([
      { k: 'handle', id: 'p0', x: 100, y: 100, radius: 5 },
      { k: 'line', from: { x: 0, y: 0 }, to: { x: 100, y: 100 } },
    ]));
  });

  it('claims a press on its handle, and says which handle', () => {
    expect(pluginPointerDown(controller, { x: 101, y: 100 }, NO_MODS, 0)).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ type: 'down', handleId: 'p0', x: 101, y: 100 })]);
  });

  it('does NOT claim a press anywhere else', () => {
    // The whole reason a gizmo can coexist with Select. A drawing that
    // swallowed every click would make the layer under it unselectable.
    expect(pluginPointerDown(controller, { x: 400, y: 400 }, NO_MODS, 0)).toBe(false);
    expect(seen).toEqual([]);
  });

  it('owns every move until the release', () => {
    pluginPointerDown(controller, { x: 100, y: 100 }, NO_MODS, 0);
    expect(pluginPointerMove(controller, { x: 140, y: 120 }, NO_MODS, 0)).toBe(true);
    expect(pluginPointerUp(controller, { x: 140, y: 120 }, NO_MODS, 0)).toBe(true);
    // And nothing after it.
    expect(pluginPointerMove(controller, { x: 150, y: 120 }, NO_MODS, 0)).toBe(false);
    // No hover on the trailing move either: it is nowhere near the handle.
    expect(seen.map((e) => e.type)).toEqual(['down', 'move', 'up']);
  });

  it('reports hover without claiming the move', () => {
    // Hover is information, not a claim: swallowing the move would break every
    // built-in hover in the viewport.
    expect(pluginPointerMove(controller, { x: 100, y: 100 }, NO_MODS, 0)).toBe(false);
    expect(seen).toEqual([expect.objectContaining({ type: 'hover', handleId: 'p0' })]);
  });

  it('does not take the keyboard', () => {
    expect(pluginKeyDown('Escape')).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe('a plugin whose TOOL is active', () => {
  beforeEach(() => {
    registerPluginTools(PLUGIN, 'Acme Lab', [
      { id: 'place', label: 'Place pin', icon: 'crosshair', cursor: 'crosshair' },
    ]);
    setActivePluginTool(pluginToolId(PLUGIN, 'place'));
  });

  it('claims a press on empty canvas, with nothing drawn at all', () => {
    // The first thing a placement tool does is receive a click on nothing.
    expect(pluginPointerDown(controller, { x: 400, y: 400 }, NO_MODS, 0)).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ type: 'down', x: 400, y: 400 })]);
    expect(seen[0]!.handleId).toBeUndefined();
  });

  it('still names the handle when the press lands on one', () => {
    setPluginDrawList(PLUGIN, gizmo([{ k: 'handle', id: 'p0', x: 10, y: 10, radius: 5 }]));
    pluginPointerDown(controller, { x: 11, y: 10 }, NO_MODS, 0);
    expect(seen[0]!.handleId).toBe('p0');
  });

  it('receives keys, which a plugin that has only drawn does not', () => {
    expect(pluginKeyDown('Escape', NO_MODS)).toBe(true);
    expect(seen).toEqual([expect.objectContaining({ type: 'key', key: 'Escape' })]);
  });

  it('carries the modifiers', () => {
    pluginPointerDown(controller, { x: 1, y: 1 }, { ...NO_MODS, alt: true, shift: true }, 0);
    expect(seen[0]!.modifiers).toEqual({ alt: true, ctrl: false, meta: false, shift: true });
  });
});

describe('the gesture bracket', () => {
  beforeEach(() => {
    setPluginDrawList(PLUGIN, gizmo([{ k: 'handle', id: 'p0', x: 0, y: 0, radius: 5 }]));
  });

  it('suspends history from the press to the release', () => {
    const history = getCommandSystem().getHistory();
    pluginPointerDown(controller, { x: 0, y: 0 }, NO_MODS, 0);
    // Counted, so each inner an edit's history entry suspends and resumes inside
    // ours and pushes nothing of its own.
    history.suspend();
    history.resume();
    expect(pluginPointerUp(controller, { x: 3, y: 3 }, NO_MODS, 0)).toBe(true);
    // Closed: an ordinary edit after the drag is undoable again.
    expect(pluginPointerUp(controller, { x: 3, y: 3 }, NO_MODS, 0)).toBe(false);
  });

  it('cancels cleanly when the viewport goes away mid-drag', () => {
    // A bracket left open suppresses every undo entry for the rest of the
    // session, which is the quietest failure in this file.
    pluginPointerDown(controller, { x: 0, y: 0 }, NO_MODS, 0);
    cancelPluginGesture();
    expect(pluginPointerMove(controller, { x: 9, y: 9 }, NO_MODS, 0)).toBe(false);
  });
});
