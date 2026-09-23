import {
  localMatrix,
  matrixToLocal,
  worldMatrixOf,
  worldTransformOf,
  localUnderParent,
  type LocalTransform,
} from './worldTransform';
import { Matrix } from '@motion/scene';

const L = (x: number, y: number, rotation = 0, scaleX = 1, scaleY = 1): LocalTransform =>
  ({ x, y, rotation, scaleX, scaleY });

/** Build localOf/parentOf from a flat {id: {local, parent}} map. */
function graph(map: Record<string, { local: LocalTransform; parent: string | null }>) {
  return {
    localOf: (id: string) => map[id]?.local ?? null,
    parentOf: (id: string) => map[id]?.parent ?? null,
  };
}

describe('local matrix round-trip', () => {
  test('matrixToLocal(localMatrix(x)) ≈ x', () => {
    const l = L(120, -40, 30, 1.5, 0.75);
    const back = matrixToLocal(localMatrix(l));
    expect(back.x).toBeCloseTo(120, 6);
    expect(back.y).toBeCloseTo(-40, 6);
    expect(back.rotation).toBeCloseTo(30, 6);
    expect(back.scaleX).toBeCloseTo(1.5, 6);
    expect(back.scaleY).toBeCloseTo(0.75, 6);
  });
});

describe('worldTransformOf — parenting composition', () => {
  test('a root node with no parent = its local', () => {
    const { localOf, parentOf } = graph({ a: { local: L(10, 20, 5), parent: null } });
    const w = worldTransformOf('a', localOf, parentOf);
    expect(w.x).toBeCloseTo(10);
    expect(w.y).toBeCloseTo(20);
    expect(w.rotation).toBeCloseTo(5);
  });

  test('parent translation offsets the child position', () => {
    const { localOf, parentOf } = graph({
      p: { local: L(100, 50), parent: null },
      c: { local: L(10, 0), parent: 'p' },
    });
    const w = worldTransformOf('c', localOf, parentOf);
    expect(w.x).toBeCloseTo(110);
    expect(w.y).toBeCloseTo(50);
  });

  test('parent rotation rotates the child offset (90° → +x becomes +y)', () => {
    const { localOf, parentOf } = graph({
      p: { local: L(0, 0, 90), parent: null },
      c: { local: L(10, 0), parent: 'p' },
    });
    const w = worldTransformOf('c', localOf, parentOf);
    expect(w.x).toBeCloseTo(0, 6);
    expect(w.y).toBeCloseTo(10, 6);
    expect(w.rotation).toBeCloseTo(90, 6);
  });

  test('parent scale scales the child offset and accumulates scale', () => {
    const { localOf, parentOf } = graph({
      p: { local: L(0, 0, 0, 2, 2), parent: null },
      c: { local: L(10, 5, 0, 1.5, 1.5), parent: 'p' },
    });
    const w = worldTransformOf('c', localOf, parentOf);
    expect(w.x).toBeCloseTo(20);
    expect(w.y).toBeCloseTo(10);
    expect(w.scaleX).toBeCloseTo(3);
    expect(w.scaleY).toBeCloseTo(3);
  });

  test('three-level chain composes transitively', () => {
    const { localOf, parentOf } = graph({
      a: { local: L(100, 0), parent: null },
      b: { local: L(50, 0), parent: 'a' },
      c: { local: L(10, 0), parent: 'b' },
    });
    const w = worldTransformOf('c', localOf, parentOf);
    expect(w.x).toBeCloseTo(160);
  });
});

describe('localUnderParent — reparent without moving', () => {
  test('produces the local that reproduces the child world under a new parent', () => {
    const childWorld = localMatrix(L(200, 50));
    const parentWorld = localMatrix(L(100, 50, 90));
    const local = localUnderParent(childWorld, parentWorld);
    // Recomposing parentWorld · local must return the original child world pos.
    const recomposed = matrixToLocal(Matrix.multiply(parentWorld, localMatrix(local)));
    expect(recomposed.x).toBeCloseTo(200, 6);
    expect(recomposed.y).toBeCloseTo(50, 6);
  });
});

describe('worldMatrixOf caching', () => {
  test('reuses cached ancestor matrices', () => {
    const { localOf, parentOf } = graph({
      p: { local: L(5, 5), parent: null },
      c: { local: L(1, 1), parent: 'p' },
    });
    const cache = new Map();
    worldMatrixOf('c', localOf, parentOf, cache);
    expect(cache.has('p')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });
});

describe('worldMatrixOf parent cycles', () => {
  // a → c → b → a is a cycle; d hangs off b. Same rule as native world_matrices_2d.
  const map = {
    a: { local: L(1, 0), parent: 'c' },
    b: { local: L(2, 0), parent: 'a' },
    c: { local: L(3, 0), parent: 'b' },
    d: { local: L(4, 0), parent: 'b' },
  };

  test('nodes on a cycle are roots and are reported; descendants compose onto them', () => {
    const { localOf, parentOf } = graph(map);
    const reported: string[] = [];
    const cache = new Map();
    const d = worldMatrixOf('d', localOf, parentOf, cache, (id) => reported.push(id));
    expect(reported.sort()).toEqual(['a', 'b', 'c']);
    expect(d.e).toBe(2 + 4);
    for (const id of ['a', 'b', 'c'] as const) {
      expect(worldMatrixOf(id, localOf, parentOf, cache)).toEqual(localMatrix(map[id].local));
    }
  });

  test('the answer does not depend on which node is asked for first', () => {
    const { localOf, parentOf } = graph(map);
    const ids = ['a', 'b', 'c', 'd'];
    const first = ids.map((id) => worldMatrixOf(id, localOf, parentOf, new Map()));
    const cache = new Map();
    const shared = [...ids].reverse().map((id) => worldMatrixOf(id, localOf, parentOf, cache)).reverse();
    expect(shared).toEqual(first);
  });

  test('a node parented to itself is a root, and a very deep chain does not overflow', () => {
    const self = graph({ s: { local: L(7, 0), parent: 's' } });
    expect(worldMatrixOf('s', self.localOf, self.parentOf).e).toBe(7);
    const deep: Record<string, { local: LocalTransform; parent: string | null }> = {};
    for (let i = 0; i < 20000; i++) deep[`n${i}`] = { local: L(1, 0), parent: i === 0 ? null : `n${i - 1}` };
    const g = graph(deep);
    expect(worldMatrixOf('n19999', g.localOf, g.parentOf).e).toBe(20000);
  });
});
