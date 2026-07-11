import {
  Scene,
  createRectangleNode,
  createGroupNode,
  createTextNode,
  GraphFacade,
  readFlat,
  writeFlat,
  listFlat,
} from '../index';

describe('flat property projection', () => {
  it('reads/writes transform and node fields by flat key', () => {
    const scene = new Scene();
    const r = scene.add(createRectangleNode());

    writeFlat(r, 'x', 120);
    writeFlat(r, 'y', 60);
    writeFlat(r, 'rotation', 45);
    writeFlat(r, 'opacity', 0.5);

    expect(readFlat(r, 'x')).toBe(120);
    expect(readFlat(r, 'y')).toBe(60);
    expect(readFlat(r, 'rotation')).toBe(45);
    expect(readFlat(r, 'opacity')).toBe(0.5);
    // Round-trips through the typed transform.
    expect(r.transform.position).toEqual({ x: 120, y: 60 });
  });

  it('reads/writes component-backed keys, creating the component on demand', () => {
    const scene = new Scene();
    const t = scene.add(createTextNode());
    writeFlat(t, 'content', 'Hello');
    writeFlat(t, 'fontSize', 72);
    expect(readFlat(t, 'content')).toBe('Hello');
    expect(readFlat(t, 'fontSize')).toBe(72);

    const r = scene.add(createRectangleNode());
    // rectangle has no text component; writing 'content' creates one.
    writeFlat(r, 'content', 'x');
    expect(readFlat(r, 'content')).toBe('x');
  });

  it('listFlat returns only resolvable keys', () => {
    const scene = new Scene();
    const r = scene.add(createRectangleNode());
    const keys = listFlat(r);
    expect(keys).toEqual(expect.arrayContaining(['x', 'y', 'rotation', 'opacity']));
  });

  it('unbound keys are ignored', () => {
    const scene = new Scene();
    const r = scene.add(createRectangleNode());
    expect(readFlat(r, 'nope')).toBeUndefined();
    expect(writeFlat(r, 'nope', 1)).toBe(false);
  });
});

describe('GraphFacade (id-addressed container)', () => {
  it('mirrors add/child/get/remove/traverse over a Scene', () => {
    const scene = new Scene();
    const graph = new GraphFacade(scene);

    const g = createGroupNode({ name: 'G' });
    graph.addNode(g);
    const r = createRectangleNode({ name: 'R' });
    graph.addChild(g.id, r);

    expect(graph.getNode(g.id)).toBe(g);
    expect(graph.getRoots().map((n) => n.name)).toEqual(['G']);
    expect(graph.getChildren(g.id).map((n) => n.name)).toEqual(['R']);
    expect(graph.size).toBe(2);

    const seen: string[] = [];
    graph.traverse((n) => seen.push(n.name));
    expect(seen).toEqual(['G', 'R']);

    graph.removeNode(g.id);
    expect(graph.getNode(g.id)).toBeUndefined();
    expect(graph.size).toBe(0);
  });
});
