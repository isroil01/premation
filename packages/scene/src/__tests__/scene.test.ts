import {
  Scene,
  createGroupNode,
  createRectangleNode,
  createEllipseNode,
  createTextNode,
  SceneValidationError,
} from '../index';

function buildScene(): { scene: Scene; group: ReturnType<typeof createGroupNode>; rect: ReturnType<typeof createRectangleNode> } {
  const scene = new Scene();
  const group = scene.add(createGroupNode({ name: 'G' }));
  const rect = scene.add(createRectangleNode({ name: 'R' }), group);
  return { scene, group, rect };
}

describe('Scene hierarchy', () => {
  it('adds nodes and indexes them for O(1) lookup', () => {
    const { scene, group, rect } = buildScene();
    expect(scene.find(group.id)).toBe(group);
    expect(scene.find(rect.id)).toBe(rect);
    expect(rect.parent).toBe(group);
    expect(scene.size).toBe(3); // root + group + rect
  });

  it('rejects duplicate ids', () => {
    const scene = new Scene();
    const a = scene.add(createRectangleNode());
    const clash = createEllipseNode();
    (clash as unknown as { id: string }).id = a.id; // force a collision
    expect(() => scene.add(clash)).toThrow(SceneValidationError);
  });

  it('rejects re-adding an already-attached node', () => {
    const { scene, group } = buildScene();
    expect(() => scene.add(group)).toThrow(/already attached/);
  });

  it('removes a subtree and deindexes it', () => {
    const { scene, group, rect } = buildScene();
    expect(scene.remove(group)).toBe(true);
    expect(scene.find(group.id)).toBeNull();
    expect(scene.find(rect.id)).toBeNull();
    expect(scene.size).toBe(1); // just root
  });

  it('moves a node to a new parent', () => {
    const scene = new Scene();
    const a = scene.add(createGroupNode({ name: 'A' }));
    const b = scene.add(createGroupNode({ name: 'B' }));
    const child = scene.add(createRectangleNode(), a);
    scene.move(child, b, 0);
    expect(child.parent).toBe(b);
    expect(a.children).not.toContain(child);
    expect(b.children[0]).toBe(child);
  });

  it('prevents circular parenting', () => {
    const scene = new Scene();
    const a = scene.add(createGroupNode());
    const b = scene.add(createGroupNode(), a);
    // Moving A under its own descendant B must be rejected.
    expect(() => scene.move(a, b)).toThrow(/cycle/i);
  });

  it('duplicates a subtree with fresh ids', () => {
    const { scene, group, rect } = buildScene();
    const copy = scene.duplicate(group)!;
    expect(copy).not.toBe(group);
    expect(copy.id).not.toBe(group.id);
    expect(copy.children).toHaveLength(1);
    expect(copy.children[0]!.id).not.toBe(rect.id);
    expect(copy.name).toBe('G copy');
    expect(scene.find(copy.children[0]!.id)).toBeTruthy();
  });

  it('queries by type, name, and predicate', () => {
    const scene = new Scene();
    scene.add(createRectangleNode({ name: 'r1' }));
    scene.add(createRectangleNode({ name: 'r2' }));
    scene.add(createTextNode({ name: 't1' }));
    expect(scene.getByType('rectangle')).toHaveLength(2);
    expect(scene.getByName('t1')).toHaveLength(1);
    expect(scene.query((n) => n.type === 'text')).toHaveLength(1);
    expect(scene.first((n) => n.name === 'r2')?.name).toBe('r2');
  });

  it('flattens to non-root nodes in layer order', () => {
    const { scene, group, rect } = buildScene();
    const flat = scene.flatten();
    expect(flat).toEqual([group, rect]);
  });

  it('passes an integrity audit', () => {
    const { scene } = buildScene();
    expect(scene.audit()).toEqual([]);
  });
});
