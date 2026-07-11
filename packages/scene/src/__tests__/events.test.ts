import { Scene, createRectangleNode, createGroupNode, TypedEmitter } from '../index';

describe('Event system', () => {
  it('emits NodeCreated / NodeDeleted / ParentChanged', () => {
    const scene = new Scene();
    const log: string[] = [];
    scene.on('NodeCreated', (e) => log.push(`created:${e.node.name}`));
    scene.on('NodeDeleted', () => log.push('deleted'));
    scene.on('ParentChanged', () => log.push('reparented'));

    const g = scene.add(createGroupNode({ name: 'G' }));
    const r = scene.add(createRectangleNode({ name: 'R' }));
    scene.move(r, g);
    scene.remove(r);

    expect(log).toEqual(['created:G', 'created:R', 'reparented', 'deleted']);
  });

  it('emits NodeUpdated + VisibilityChanged on state change', () => {
    const scene = new Scene();
    const r = scene.add(createRectangleNode());
    let updated = 0;
    let visibility = 0;
    scene.on('NodeUpdated', () => updated++);
    scene.on('VisibilityChanged', (e) => { if (!e.visible) visibility++; });
    r.name = 'Renamed';
    r.visible = false;
    expect(updated).toBeGreaterThanOrEqual(2);
    expect(visibility).toBe(1);
  });

  it('TypedEmitter: on/once/off and disposer', () => {
    const em = new TypedEmitter<{ ping: number }>();
    let sum = 0;
    const sub = em.on('ping', (n) => { sum += n; });
    em.emit('ping', 1);
    em.once('ping', (n) => { sum += n * 100; });
    em.emit('ping', 2); // on:+2, once:+200
    sub.dispose();
    em.emit('ping', 5); // no listeners now
    expect(sum).toBe(1 + 2 + 200);
  });

  it('a throwing handler does not break emit', () => {
    const em = new TypedEmitter<{ e: void }>();
    let reached = false;
    em.on('e', () => { throw new Error('boom'); });
    em.on('e', () => { reached = true; });
    expect(() => em.emit('e', undefined)).not.toThrow();
    expect(reached).toBe(true);
  });
});
