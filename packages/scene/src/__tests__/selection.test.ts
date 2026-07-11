import { Scene, createRectangleNode } from '../index';

describe('Selection', () => {
  it('supports single and multi selection', () => {
    const scene = new Scene();
    const a = scene.add(createRectangleNode());
    const b = scene.add(createRectangleNode());
    scene.selection.set([a.id]);
    expect(scene.selection.get()).toEqual([a.id]);
    expect(scene.selection.primary()).toBe(a.id);
    scene.selection.add(b.id);
    expect(scene.selection.count()).toBe(2);
    expect(scene.selection.has(b.id)).toBe(true);
  });

  it('syncs node.selected flags and emits SelectionChanged', () => {
    const scene = new Scene();
    const a = scene.add(createRectangleNode());
    const b = scene.add(createRectangleNode());
    const events: number[] = [];
    scene.on('SelectionChanged', (e) => events.push(e.selected.length));
    scene.selection.set([a.id, b.id]);
    expect(a.selected).toBe(true);
    expect(b.selected).toBe(true);
    scene.selection.remove(a.id);
    expect(a.selected).toBe(false);
    expect(b.selected).toBe(true);
    expect(events).toEqual([2, 1]);
  });

  it('toggles selection', () => {
    const scene = new Scene();
    const a = scene.add(createRectangleNode());
    scene.selection.toggle(a.id);
    expect(scene.selection.has(a.id)).toBe(true);
    scene.selection.toggle(a.id);
    expect(scene.selection.has(a.id)).toBe(false);
  });

  it('saves and loads named selection groups', () => {
    const scene = new Scene();
    const a = scene.add(createRectangleNode());
    const b = scene.add(createRectangleNode());
    scene.selection.set([a.id, b.id]);
    scene.selection.saveGroup('pair');
    scene.selection.clear();
    expect(scene.selection.isEmpty()).toBe(true);
    expect(scene.selection.loadGroup('pair')).toBe(true);
    expect(scene.selection.count()).toBe(2);
  });

  it('drops removed nodes from the selection', () => {
    const scene = new Scene();
    const a = scene.add(createRectangleNode());
    scene.selection.set([a.id]);
    scene.remove(a);
    expect(scene.selection.has(a.id)).toBe(false);
    expect(scene.selection.isEmpty()).toBe(true);
  });
});
