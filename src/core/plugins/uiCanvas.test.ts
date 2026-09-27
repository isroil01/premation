/**
 * The retained draw list: what survives the boundary, and what does not.
 *
 * This data crossed a `postMessage` from third-party code and then goes
 * straight into a 2D context, so the sanitiser is the security boundary rather
 * than a convenience. Three failures it exists to stop, none of which would
 * throw:
 *
 *   • an unbounded item count — a frame-rate attack from a plugin that never
 *     has to be malicious, only careless;
 *   • a colour that is not a hex literal, which is a plugin-supplied string
 *     going into `ctx.fillStyle`, a property that parses more grammars than
 *     anyone wants to audit;
 *   • `NaN` coordinates, which propagate silently through a transform and blank
 *     the whole overlay.
 *
 * And the one behaviour that is not about safety at all: a drag on a plugin
 * handle has to be ONE undo entry, however many writes the plugin makes.
 */

import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import {
  MAX_DRAW_ITEMS,
  beginPluginGesture,
  configurePluginCanvas,
  dispatchPluginCanvasEvent,
  endPluginGesture,
  findHandleAt,
  pluginDrawLists,
  pluginGestureActive,
  resetPluginCanvasForTests,
  sanitiseDrawList,
  setPluginDrawList,
  type PluginCanvasEvent,
  type PluginDrawList,
} from './uiCanvas';

const PLUGIN = 'studio.acme.lab';

const list = (items: unknown[]): unknown => ({ layerId: 'n1', space: 'layer', items });

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  resetPluginCanvasForTests();
});

describe('sanitising a draw list', () => {
  it('accepts one of every primitive and hands back a NEW object', () => {
    const raw = list([
      { k: 'line', from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      { k: 'rect', x: 0, y: 0, w: 4, h: 4, fill: '#112233' },
      { k: 'circle', x: 1, y: 1, r: 3 },
      { k: 'path', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], close: true },
      { k: 'text', x: 2, y: 2, text: 'hello' },
      { k: 'handle', id: 'p0', x: 5, y: 5 },
    ]);
    const clean = sanitiseDrawList(raw)!;
    expect(clean.items.map((i) => i.k)).toEqual(['line', 'rect', 'circle', 'path', 'text', 'handle']);
    // Never the plugin's own object: it is retained across frames, and keeping
    // the structured-clone result alive keeps whatever else rode on it alive too.
    expect(clean.items[0]).not.toBe((raw as { items: unknown[] }).items[0]);
  });

  it('refuses a layer-space list with no layer', () => {
    expect(sanitiseDrawList({ space: 'layer', items: [] })).toBeNull();
    // Composition space needs none — that is what it is for.
    expect(sanitiseDrawList({ space: 'comp', items: [] })).not.toBeNull();
  });

  it('drops a primitive whose numbers are not numbers', () => {
    const clean = sanitiseDrawList(list([
      { k: 'line', from: { x: NaN, y: 0 }, to: { x: 1, y: 1 } },
      { k: 'circle', x: 0, y: 0, r: 1 },
    ]))!;
    expect(clean.items).toHaveLength(1);
    expect(clean.items[0]!.k).toBe('circle');
  });

  it('replaces a colour that is not a hex literal', () => {
    const clean = sanitiseDrawList(list([
      { k: 'circle', x: 0, y: 0, r: 1, color: 'url(#evil)', fill: 'rgba(0,0,0,0.5)' },
    ]))!;
    const circle = clean.items[0] as { color?: string; fill?: string };
    expect(circle.color).toBe('#4da3ff');
    // A fill that could not be validated is dropped rather than defaulted:
    // an unasked-for fill would paint over the composition.
    expect(circle.fill).toBeUndefined();
  });

  it('caps the item count rather than trusting it', () => {
    const many = Array.from({ length: MAX_DRAW_ITEMS + 50 }, () => ({ k: 'circle', x: 0, y: 0, r: 1 }));
    expect(sanitiseDrawList(list(many))!.items).toHaveLength(MAX_DRAW_ITEMS);
  });

  it('drops an item kind this build does not know', () => {
    // A plugin written against a newer vocabulary. Drawing something that is
    // not what the author asked for is worse than drawing nothing.
    expect(sanitiseDrawList(list([{ k: 'hologram', x: 0, y: 0 }]))!.items).toHaveLength(0);
  });
});

describe('the registry', () => {
  it('replaces a plugin s whole drawing, and clears it on null', () => {
    expect(setPluginDrawList(PLUGIN, list([{ k: 'circle', x: 0, y: 0, r: 1 }]))).toBe(true);
    expect(pluginDrawLists()).toHaveLength(1);
    setPluginDrawList(PLUGIN, null);
    expect(pluginDrawLists()).toHaveLength(0);
  });

  it('refuses a malformed list instead of drawing half of it', () => {
    // Silently drawing the half that parsed leaves the author debugging a gizmo
    // with a line missing and no error anywhere.
    expect(setPluginDrawList(PLUGIN, { space: 'layer', items: [] })).toBe(false);
    expect(pluginDrawLists()).toHaveLength(0);
  });
});

describe('hit-testing handles', () => {
  const withHandles: PluginDrawList = sanitiseDrawList(list([
    { k: 'handle', id: 'a', x: 0, y: 0, radius: 4 },
    { k: 'handle', id: 'b', x: 2, y: 0, radius: 4 },
  ]))!;

  it('picks the NEAREST handle, not the first declared', () => {
    // Overlapping handles are normal (a tangent on its vertex); first-wins
    // would make which one you grab depend on the plugin's emit order.
    expect(findHandleAt(withHandles, { x: 1.8, y: 0 }, 1)!.id).toBe('b');
    expect(findHandleAt(withHandles, { x: 0.1, y: 0 }, 1)!.id).toBe('a');
  });

  it('measures the grab radius in SCREEN pixels, so zoom does not shrink it', () => {
    // At 25% zoom the same layer-space distance is a quarter of the pixels, and
    // the handle must still be grabbable — that is the whole point of the unit.
    expect(findHandleAt(withHandles, { x: 20, y: 0 }, 1)).toBeNull();
    expect(findHandleAt(withHandles, { x: 20, y: 0 }, 0.25)).not.toBeNull();
  });
});

describe('events back to the plugin', () => {
  it('goes nowhere when nothing is wired up, and does not throw', () => {
    expect(() => dispatchPluginCanvasEvent(PLUGIN, {
      type: 'down', x: 0, y: 0, layerId: 'n1', modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    })).not.toThrow();
  });

  it('delivers to the configured sink', () => {
    const seen: Array<[string, PluginCanvasEvent]> = [];
    configurePluginCanvas({ deliver: (id, e) => seen.push([id, e]) });
    dispatchPluginCanvasEvent(PLUGIN, {
      type: 'move', x: 3, y: 4, handleId: 'a', layerId: 'n1',
      modifiers: { alt: true, ctrl: false, meta: false, shift: false },
    });
    expect(seen).toEqual([[PLUGIN, expect.objectContaining({ type: 'move', x: 3, handleId: 'a' })]]);
  });
});

describe('one gesture, one undo entry', () => {
  it('suspends history for the duration and pushes once', () => {
    const history = getCommandSystem().getHistory();
    const before = history.canUndo();

    beginPluginGesture('Drag plugin handle');
    expect(pluginGestureActive()).toBe(true);
    // Whatever the plugin writes during the drag, every inner an edit's history entry
    // suspends and resumes INSIDE ours (the suspension is counted) and pushes
    // nothing of its own.
    endPluginGesture();
    expect(pluginGestureActive()).toBe(false);
    // Nothing changed, so nothing was pushed — a no-op drag must not litter the
    // undo stack either.
    expect(history.canUndo()).toBe(before);
  });

  it('a second begin closes the first, rather than leaking it', () => {
    // A leaked bracket suppresses undo for the rest of the session, which is
    // the worst failure in this file and the quietest.
    beginPluginGesture('one');
    beginPluginGesture('two');
    expect(pluginGestureActive()).toBe(true);
    endPluginGesture();
    expect(pluginGestureActive()).toBe(false);
  });
});
