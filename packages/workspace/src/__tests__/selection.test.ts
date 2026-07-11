import { SelectionController } from '../selection/SelectionController';
import { Marquee } from '../selection/Marquee';
import { computeHandles, pickHandle } from '../selection/handles';
import { HitTester } from '../hit/HitTester';
import { MemoryScene, MemorySelection } from '../adapters/memory';
import { NO_MODIFIERS, type Modifiers } from '../input/events';
import * as R from '../math/Rect';

function mods(patch: Partial<Modifiers> = {}): Modifiers {
  return { ...NO_MODIFIERS, ...patch };
}

function setup() {
  const scene = new MemoryScene([
    { id: 'a', bounds: R.rect(0, 0, 100, 100), zIndex: 0 },
    { id: 'b', bounds: R.rect(200, 0, 100, 100), zIndex: 1 },
    { id: 'c', bounds: R.rect(0, 200, 100, 100), zIndex: 2 },
  ]);
  const selection = new MemorySelection();
  const hit = new HitTester(scene);
  const controller = new SelectionController(scene, selection, hit);
  return { scene, selection, hit, controller };
}

describe('Marquee', () => {
  it('normalizes the rect and reports mode by direction', () => {
    const m = new Marquee();
    m.begin({ x: 100, y: 100 });
    m.update({ x: 50, y: 50 });
    expect(m.rect()).toEqual({ x: 50, y: 50, width: 50, height: 50 });
    expect(m.mode()).toBe('intersect'); // dragged left
    m.update({ x: 200, y: 200 });
    expect(m.mode()).toBe('contain'); // dragged right
  });
});

describe('handles', () => {
  it('produces 8 resize + 1 rotate handle', () => {
    const handles = computeHandles(R.rect(0, 0, 100, 100), { rotateOffset: 20 });
    expect(handles).toHaveLength(9);
    expect(handles.filter((h) => h.kind === 'resize')).toHaveLength(8);
    expect(handles.find((h) => h.id === 'rotate')?.position).toEqual({ x: 50, y: -20 });
    expect(handles.find((h) => h.id === 'se')?.position).toEqual({ x: 100, y: 100 });
  });

  it('picks the handle under a point within radius', () => {
    const handles = computeHandles(R.rect(0, 0, 100, 100));
    expect(pickHandle(handles, { x: 101, y: 1 }, 5)?.id).toBe('ne');
    expect(pickHandle(handles, { x: 50, y: 50 }, 5)).toBeNull();
  });
});

describe('SelectionController', () => {
  it('single-selects on plain click, clears on empty', () => {
    const { controller, selection } = setup();
    controller.clickAt({ x: 50, y: 50 }, mods());
    expect(selection.get()).toEqual(['a']);
    controller.clickAt({ x: 500, y: 500 }, mods());
    expect(selection.get()).toEqual([]);
  });

  it('toggles with shift', () => {
    const { controller, selection } = setup();
    controller.clickAt({ x: 50, y: 50 }, mods());
    controller.clickAt({ x: 250, y: 50 }, mods({ shift: true }));
    expect(selection.get().sort()).toEqual(['a', 'b']);
    controller.clickAt({ x: 50, y: 50 }, mods({ shift: true }));
    expect(selection.get()).toEqual(['b']);
  });

  it('selects a region with the marquee (contain)', () => {
    const { controller, selection } = setup();
    controller.beginMarquee({ x: -10, y: -10 });
    controller.updateMarquee({ x: 320, y: 120 }); // covers a and b fully
    const ids = controller.endMarquee(mods());
    expect(ids.sort()).toEqual(['a', 'b']);
    expect(selection.get().sort()).toEqual(['a', 'b']);
  });

  it('adds to selection with shift-marquee', () => {
    const { controller, selection } = setup();
    selection.set(['c']);
    controller.beginMarquee({ x: -10, y: -10 });
    controller.updateMarquee({ x: 120, y: 120 }); // covers a
    controller.endMarquee(mods({ shift: true }));
    expect(selection.get().sort()).toEqual(['a', 'c']);
  });

  it('computes the union bounds and handles of the selection', () => {
    const { controller, selection } = setup();
    selection.set(['a', 'b']);
    const bounds = controller.selectionBounds();
    expect(bounds).toEqual({ x: 0, y: 0, width: 300, height: 100 });
    expect(controller.handles()).toHaveLength(9);
  });

  it('selectAll picks visible unlocked nodes', () => {
    const { controller, selection } = setup();
    controller.selectAll();
    expect(selection.get().sort()).toEqual(['a', 'b', 'c']);
  });
});
