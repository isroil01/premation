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
