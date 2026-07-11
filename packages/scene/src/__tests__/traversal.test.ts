import { Scene, createGroupNode, createRectangleNode, dfs, bfs, visit, countNodes } from '../index';

/**
 * Build:
 *   root
 *    ├ A
 *    │  ├ A1
 *    │  └ A2
 *    └ B
 */
function tree(): Scene {
  const scene = new Scene();
  const a = scene.add(createGroupNode({ name: 'A' }));
  scene.add(createRectangleNode({ name: 'A1' }), a);
  scene.add(createRectangleNode({ name: 'A2' }), a);
  scene.add(createGroupNode({ name: 'B' }));
  return scene;
}

describe('Traversal', () => {
  it('DFS is pre-order left→right', () => {
    const scene = tree();
    const names = [...dfs(scene.root)].map((n) => n.name);
    expect(names).toEqual(['Root', 'A', 'A1', 'A2', 'B']);
  });

  it('BFS is level order', () => {
    const scene = tree();
    const names = [...bfs(scene.root)].map((n) => n.name);
    expect(names).toEqual(['Root', 'A', 'B', 'A1', 'A2']);
  });

  it('visitor calls enter/leave in the right order', () => {
    const scene = tree();
    const log: string[] = [];
    visit(scene.root, {
      enter: (n) => { log.push(`>${n.name}`); },
      leave: (n) => { log.push(`<${n.name}`); },
    });
    expect(log).toEqual(['>Root', '>A', '>A1', '<A1', '>A2', '<A2', '<A', '>B', '<B', '<Root']);
  });

  it('visitor can skip a subtree by returning false', () => {
    const scene = tree();
    const visited: string[] = [];
    visit(scene.root, {
      enter: (n) => {
        visited.push(n.name);
        return n.name === 'A' ? false : undefined; // skip A's children
      },
    });
    expect(visited).toEqual(['Root', 'A', 'B']);
  });

  it('countNodes counts the whole subtree', () => {
    const scene = tree();
    expect(countNodes(scene.root)).toBe(5);
  });
});
