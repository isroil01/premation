import { Scene, createGroupNode, createRectangleNode, dfs } from '../index';

/**
 * Scale test: the engine must handle 100k+ nodes with fast O(1) lookup and
 * O(n) traversal, and no recursion-depth failures on deep chains.
 */
describe('Performance / scale', () => {
  it('builds, indexes, traverses, and finds across 100k nodes', () => {
    const N = 100_000;
    const scene = new Scene();

    // 200 groups × 500 rects = 100,000 nodes.
    const ids: string[] = [];
    const groups = 200;
    const per = N / groups;
    for (let g = 0; g < groups; g++) {
      const group = scene.add(createGroupNode({ name: `g${g}` }));
      for (let i = 0; i < per - 1; i++) {
        const rect = scene.add(createRectangleNode({ name: `r${g}_${i}` }), group);
        if ((g * per + i) % 9999 === 0) ids.push(rect.id);
      }
    }

    expect(scene.size).toBe(N + 1); // + root

    // O(1) lookups.
    for (const id of ids) expect(scene.find(id as never)).toBeTruthy();

    // O(n) full traversal completes.
    let count = 0;
    for (const _ of dfs(scene.root)) count++;
    expect(count).toBe(N + 1);
  });

  it('does not overflow the stack on a very deep chain (50k deep)', () => {
    const scene = new Scene();
    let parent = scene.root;
    for (let i = 0; i < 50_000; i++) {
      parent = scene.add(createGroupNode({ name: `d${i}` }), parent);
    }
    // Iterative traversal must handle this without a RangeError.
    expect(() => {
      let n = 0;
      for (const _ of dfs(scene.root)) n++;
      expect(n).toBe(50_001);
    }).not.toThrow();
    // Deep world-transform pass is also iterative.
    expect(() => scene.updateTransforms()).not.toThrow();
  });
});
