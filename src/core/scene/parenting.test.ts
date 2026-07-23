import defaultSceneGraph from './DefaultSceneGraph';
import { canReparent, reparentNode, eligibleParents, parentOfNode, insertNull } from './parenting';
import { readNodeKind } from './sceneDerive';
import type { SceneNode } from '@core/types';

function transformNode(id: string, parent: string, x: number, y: number, rot = 0): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation: rot, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: 'shape', x, y, rotation: rot } }],
  } as unknown as SceneNode;
}

/** Reset the shared graph to comp_root + a couple of layers before each test. */
function reset(): void {
  for (const r of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(r.id);
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Composition', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', transformNode('P', 'comp_root', 100, 50));
  defaultSceneGraph.addChild('comp_root', transformNode('C', 'comp_root', 200, 50));
}

describe('canReparent — cycle + self guards', () => {
  beforeEach(reset);

  test('allows parenting to an unrelated layer', () => {
    expect(canReparent('C', 'P')).toBe(true);
  });
  test('rejects self-parenting', () => {
    expect(canReparent('C', 'C')).toBe(false);
  });
  test('rejects re-parenting the comp root', () => {
    expect(canReparent('comp_root', 'P')).toBe(false);
  });
  test('rejects a descendant becoming the parent (cycle)', () => {
    reparentNode('C', 'P'); // C is now a child of P
    expect(canReparent('P', 'C')).toBe(false);
  });
  test('null parent (→ comp root) is always allowed', () => {
    expect(canReparent('C', null)).toBe(true);
  });
});

describe('reparentNode — does not move the layer on screen', () => {
  beforeEach(reset);

  test('child keeps its world position; local is compensated', () => {
    // C at world (200,50); parent P at (100,50). After parenting, C's local must
    // become (100,0) so its world stays (200,50).
    expect(reparentNode('C', 'P')).toBe(true);
    const c = defaultSceneGraph.getNode('C')!;
    expect(c.parent).toBe('P');
    expect(c.transform.position.x).toBeCloseTo(100, 4);
    expect(c.transform.position.y).toBeCloseTo(0, 4);
  });

  test('reparenting to None returns the layer to comp space, still in place', () => {
    reparentNode('C', 'P');
    expect(reparentNode('C', null)).toBe(true);
    const c = defaultSceneGraph.getNode('C')!;
    expect(c.parent).toBe('comp_root');
    expect(c.transform.position.x).toBeCloseTo(200, 4);
    expect(c.transform.position.y).toBeCloseTo(50, 4);
  });

  test('a cycle-creating reparent is refused', () => {
    reparentNode('C', 'P');
    expect(reparentNode('P', 'C')).toBe(false);
    expect(defaultSceneGraph.getNode('P')!.parent).toBe('comp_root');
  });

  test('reparentNode with preserveWorld: false keeps the LOCAL transform (importer path)', () => {
    expect(reparentNode('C', 'P', { preserveWorld: false })).toBe(true);
    const c = defaultSceneGraph.getNode('C')!;
    expect(c.parent).toBe('P');
    // Local stays (200,50) — world becomes parent + local, i.e. the layer moves.
    expect(c.transform.position.x).toBeCloseTo(200, 4);
    expect(c.transform.position.y).toBeCloseTo(50, 4);
  });

  test('defaultSceneGraph.setParent compensates transform by default (preserveWorld: true)', () => {
    defaultSceneGraph.setParent('C', 'P');
    const c = defaultSceneGraph.getNode('C')!;
    expect(c.parent).toBe('P');
    expect(c.transform.position.x).toBeCloseTo(100, 4);
    expect(c.transform.position.y).toBeCloseTo(0, 4);
  });

  test('defaultSceneGraph.setParent allows preserveWorld: false to skip transform compensation', () => {
    defaultSceneGraph.setParent('C', 'P', { preserveWorld: false });
    const c = defaultSceneGraph.getNode('C')!;
    expect(c.parent).toBe('P');
    expect(c.transform.position.x).toBeCloseTo(200, 4);
    expect(c.transform.position.y).toBeCloseTo(50, 4);
  });
});

describe('eligibleParents + parentOfNode', () => {
  beforeEach(reset);

  test('excludes self, descendants, and the comp root', () => {
    reparentNode('C', 'P'); // C under P
    const ids = eligibleParents('P').map((o) => o.id);
    expect(ids).not.toContain('P'); // self
    expect(ids).not.toContain('C'); // descendant
    expect(ids).not.toContain('comp_root');
  });

  test('parentOfNode reports null for a direct child of comp root', () => {
    expect(parentOfNode('C')).toBeNull();
    reparentNode('C', 'P');
    expect(parentOfNode('C')).toBe('P');
  });
});

describe('insertNull', () => {
  beforeEach(reset);

  test('creates a null-kind controller under the comp root', () => {
    insertNull();
    const nulls = defaultSceneGraph.getChildren('comp_root').filter((n) => readNodeKind(n) === 'null');
    expect(nulls.length).toBe(1);
    expect(nulls[0]!.name).toBe('Null');
  });
});
