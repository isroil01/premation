/**
 * GraphFacade — a classic, id-addressed container API over a {@link Scene}.
 * Exposes the shape older/simpler consumers expect (getNode / getRoots /
 * getChildren / traverse / addNode / addChild / removeNode / size) while the
 * real hierarchy, validation, and events live in the Scene. This is the drop-in
 * surface a legacy `SceneGraph` singleton can be re-pointed at.
 */

import type { NodeId } from '../types';
import type { SceneNode } from '../nodes/SceneNode';
import { Scene } from '../core/Scene';
import { dfs } from '../systems/traversal';

export class GraphFacade {
  constructor(public readonly scene: Scene) {}

  getNode(id: NodeId): SceneNode | undefined {
    return this.scene.find(id) ?? undefined;
  }

  /** Top-level nodes (children of the scene root), in order. */
  getRoots(): SceneNode[] {
    return [...this.scene.root.children];
  }

  getChildren(id: NodeId): SceneNode[] {
    const node = this.scene.find(id);
    return node ? [...node.children] : [];
  }

  /** Add a detached node under a parent id (defaults to the root). */
  addNode(node: SceneNode, parentId?: NodeId): SceneNode {
    const parent = parentId ? this.scene.find(parentId) ?? this.scene.root : this.scene.root;
    return this.scene.add(node, parent);
  }

  /** Legacy-style: add `node` as a child of `parentId`. */
  addChild(parentId: NodeId, node: SceneNode): SceneNode {
    return this.addNode(node, parentId);
  }

  removeNode(id: NodeId): boolean {
    return this.scene.remove(id);
  }

  /** Number of real (non-root) nodes. */
  get size(): number {
    return this.scene.size - 1;
  }

  /** Depth-first traversal over every non-root node. */
  traverse(cb: (node: SceneNode) => void): void {
    for (const node of dfs(this.scene.root)) {
      if (node !== this.scene.root) cb(node);
    }
  }
}
