/**
 * Tree traversal — DFS, BFS, an iterator API, and an enter/leave visitor. All
 * iterative (explicit stacks/queues) so they stay O(n) with no recursion-depth
 * limits, even for very deep or very large (100k+) graphs.
 */

import type { SceneNode } from '../nodes/SceneNode';

/** Depth-first pre-order traversal (parent before children, left→right). */
export function* dfs(root: SceneNode): Generator<SceneNode> {
  const stack: SceneNode[] = [root];
  while (stack.length) {
    const node = stack.pop() as SceneNode;
    yield node;
    const kids = node.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as SceneNode);
  }
}

/** Breadth-first traversal (level by level). */
export function* bfs(root: SceneNode): Generator<SceneNode> {
  const queue: SceneNode[] = [root];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++] as SceneNode;
    yield node;
    for (const child of node.children) queue.push(child);
  }
}

/** DFS over descendants only (excludes `root`). */
export function* descendants(root: SceneNode): Generator<SceneNode> {
  for (const node of dfs(root)) {
    if (node !== root) yield node;
  }
}

export interface Visitor {
  /** Called before visiting children. Return `false` to skip this subtree. */
  enter?(node: SceneNode, depth: number): void | boolean;
  /** Called after all children have been visited. */
  leave?(node: SceneNode, depth: number): void;
}

interface Frame {
  node: SceneNode;
  depth: number;
  phase: 'enter' | 'leave';
}

/** Visitor-pattern traversal with paired enter/leave, iterative. */
export function visit(root: SceneNode, visitor: Visitor): void {
  const stack: Frame[] = [{ node: root, depth: 0, phase: 'enter' }];
  while (stack.length) {
    const frame = stack.pop() as Frame;
    if (frame.phase === 'leave') {
      visitor.leave?.(frame.node, frame.depth);
      continue;
    }
    const skip = visitor.enter?.(frame.node, frame.depth) === false;
    if (visitor.leave) stack.push({ node: frame.node, depth: frame.depth, phase: 'leave' });
    if (!skip) {
      const kids = frame.node.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ node: kids[i] as SceneNode, depth: frame.depth + 1, phase: 'enter' });
      }
    }
  }
}

/** Count nodes in a subtree (including the root). */
export function countNodes(root: SceneNode): number {
  let n = 0;
  for (const _ of dfs(root)) n++;
  return n;
}
