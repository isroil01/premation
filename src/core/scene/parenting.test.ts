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

/**
 * Parenting is bounded by the composition.
 *
 * `parent` IS the tree structure here, so a cross-composition parent did not
 * merely behave oddly — it physically relocated the layer into the other
 * composition. It disappeared from the comp being edited and started rendering
 * in one the user wasn't looking at, and the dropdown offered every layer in the
 * project with nothing to tell them apart.
 */
describe('parenting is scoped to the composition', () => {
  const A = 'pc-rootA';
  const B = 'pc-rootB';

  function twoComps(): void {
    for (const [root, kid] of [[A, 'pc-a1'], [B, 'pc-b1']] as const) {
      defaultSceneGraph.addNode({
        id: root, name: root, parent: null, children: [], visible: true, locked: false,
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [{ id: `${root}_t`, type: 'Transform', props: {} }],
      } as never);
      defaultSceneGraph.addChild(root, {
        id: kid, name: kid, parent: root, children: [], visible: true, locked: false,
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [{ id: `${kid}_t`, type: 'Transform', props: {} }],
      } as never);
    }
  }

  afterEach(() => {
    for (const id of ['pc-a1', 'pc-b1', A, B]) {
      try { defaultSceneGraph.removeNode(id); } catch { /* not added */ }
    }
  });

  it('offers only same-composition layers as parents', () => {
    twoComps();
    const ids = eligibleParents('pc-a1').map((o) => o.id);
    expect(ids).not.toContain('pc-b1');
    expect(ids).not.toContain(B);
    // …and does not offer its own composition root either.
    expect(ids).not.toContain(A);
  });

  it('refuses a cross-composition reparent at the API, not just the dropdown', () => {
    // The AI tools call reparentNode directly; a UI-only rule gets bypassed.
    twoComps();
    expect(canReparent('pc-a1', 'pc-b1')).toBe(false);
    expect(reparentNode('pc-a1', 'pc-b1')).toBe(false);
    expect(defaultSceneGraph.getNode('pc-a1')!.parent).toBe(A);
  });

  it('still allows parenting within one composition', () => {
    twoComps();
    defaultSceneGraph.addChild(A, {
      id: 'pc-a2', name: 'pc-a2', parent: A, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'pc-a2_t', type: 'Transform', props: {} }],
    } as never);
    try {
      expect(canReparent('pc-a1', 'pc-a2')).toBe(true);
      expect(eligibleParents('pc-a1').map((o) => o.id)).toContain('pc-a2');
    } finally {
      try { defaultSceneGraph.removeNode('pc-a2'); } catch { /* ignore */ }
    }
  });
});
