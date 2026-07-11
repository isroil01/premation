/**
 * Scene — the Scene Graph. The single source of truth for the object
 * hierarchy: every object lives here as a {@link SceneNode}. Owns the id index
 * (O(1) lookup + duplicate prevention), validation, the event bus, and the
 * selection model. All structural mutation goes through this class so those
 * invariants always hold.
 */

import type { NodeId } from '../types';
import { SceneNode } from '../nodes/SceneNode';
import { createRootNode } from '../nodes/nodeTypes';
import { TypedEmitter } from '../events/EventEmitter';
import type { SceneEventMap } from '../events/SceneEvents';
import { SelectionModel } from './SelectionModel';
import { SceneValidationError, wouldCreateCycle, collectSubtreeIds, auditGraph } from './Validation';
import { dfs, descendants } from '../systems/traversal';
import { updateWorldTransforms } from '../systems/TransformSystem';

export type NodePredicate = (node: SceneNode) => boolean;

export class Scene {
  readonly root: SceneNode;
  readonly events = new TypedEmitter<SceneEventMap>();
  readonly selection = new SelectionModel();

  private readonly index = new Map<NodeId, SceneNode>();

  constructor(root?: SceneNode) {
    this.root = root ?? createRootNode();
    this.indexSubtree(this.root);

    this.selection.onChange = (selected, previous): void => {
      const now = new Set(selected);
      for (const id of new Set([...previous, ...selected])) {
        const n = this.index.get(id);
        if (n) n.selected = now.has(id);
      }
      this.events.emit('SelectionChanged', { selected, previous });
    };
  }

  /** Number of nodes in the scene (including the root). */
  get size(): number { return this.index.size; }

  /** Convenience event subscription. */
  on<K extends keyof SceneEventMap>(event: K, handler: (payload: SceneEventMap[K]) => void) {
    return this.events.on(event, handler);
  }

  // ── Structural operations ───────────────────────────────────────

  /** Add a detached node (or subtree) under `parent` (defaults to root). */
  add(node: SceneNode, parent: SceneNode = this.root, index = parent.children.length): SceneNode {
    if (node.parent) {
      throw new SceneValidationError('ALREADY_ATTACHED', `Node "${node.id}" is already attached; use move()`);
    }
    if (wouldCreateCycle(parent, node)) {
      throw new SceneValidationError('CYCLE', `Adding "${node.id}" under "${parent.id}" would create a cycle`);
    }
    // Internal dup check + collision with existing ids.
    const incoming = collectSubtreeIds(node);
    for (const id of incoming) {
      if (this.index.has(id)) {
        throw new SceneValidationError('DUPLICATE_ID', `A node with id "${id}" already exists in the scene`);
      }
    }
    parent._insertChildInternal(node, index);
    this.indexSubtree(node);
    this.events.emit('NodeCreated', { node, parentId: parent.id });
    return node;
  }

  /** Insert a node at a specific index (alias of add with index). */
  insert(node: SceneNode, parent: SceneNode, index: number): SceneNode {
    return this.add(node, parent, index);
  }

  /** Remove a node (and its subtree) from the scene. */
  remove(target: SceneNode | NodeId): boolean {
    const node = this.resolve(target);
    if (!node || node === this.root) return false;
    const parent = node.parent;
    const parentId = parent?.id ?? null;
    parent?._removeChildInternal(node);
    this.deindexSubtree(node);
    this.events.emit('NodeDeleted', { nodeId: node.id, parentId });
    return true;
  }

  /** Delete — alias of remove. */
  delete(target: SceneNode | NodeId): boolean {
    return this.remove(target);
  }

  /** Reparent a node under `newParent` at `index` (defaults to the end). */
  move(target: SceneNode | NodeId, newParent: SceneNode, index?: number): SceneNode {
    const node = this.resolve(target);
    if (!node) throw new SceneValidationError('NOT_FOUND', `Node not found`);
    if (node === this.root) throw new SceneValidationError('CYCLE', 'Cannot move the root');
    if (wouldCreateCycle(newParent, node)) {
      throw new SceneValidationError('CYCLE', `Moving "${node.id}" under "${newParent.id}" would create a cycle`);
    }
    const fromParent = node.parent;
    const fromParentId = fromParent?.id ?? null;
    fromParent?._removeChildInternal(node);
    const at = index ?? newParent.children.length;
    newParent._insertChildInternal(node, at);
    node.transform.worldDirty = true;
    this.events.emit('ParentChanged', { node, fromParentId, toParentId: newParent.id });
    this.events.emit('NodeMoved', { node, fromParentId, toParentId: newParent.id, index: node.indexInParent() });
    return node;
  }

  /** Deep-clone a node (fresh ids) and insert it as a following sibling. */
  duplicate(target: SceneNode | NodeId): SceneNode | null {
    const node = this.resolve(target);
    if (!node || node === this.root) return null;
    const copy = node.clone();
    copy.name = `${node.name} copy`;
    return this.add(copy, node.parent ?? this.root, node.indexInParent() + 1);
  }

  // ── Lookup / query ──────────────────────────────────────────────

  find(id: NodeId): SceneNode | null { return this.index.get(id) ?? null; }
  contains(id: NodeId): boolean { return this.index.has(id); }

  /** All non-root nodes matching a predicate. */
  query(predicate: NodePredicate): SceneNode[] {
    const out: SceneNode[] = [];
    for (const node of descendants(this.root)) if (predicate(node)) out.push(node);
    return out;
  }

  getByType(type: string): SceneNode[] { return this.query((n) => n.type === type); }
  getByName(name: string): SceneNode[] { return this.query((n) => n.name === name); }

  /** First non-root node matching a predicate (short-circuits). */
  first(predicate: NodePredicate): SceneNode | null {
    for (const node of descendants(this.root)) if (predicate(node)) return node;
    return null;
  }

  // ── Traversal ───────────────────────────────────────────────────

  /** Depth-first walk over every non-root node. */
  walk(cb: (node: SceneNode) => void): void {
    for (const node of descendants(this.root)) cb(node);
  }

  /** Iterate all nodes (including the root), depth-first. */
  [Symbol.iterator](): Iterator<SceneNode> { return dfs(this.root); }

  /** Flatten the scene to an array of all non-root nodes (layer order). */
  flatten(): SceneNode[] { return [...descendants(this.root)]; }

  /** A detached deep clone of a subtree (does not attach). */
  clone(node: SceneNode): SceneNode { return node.clone(); }

  // ── Transforms ──────────────────────────────────────────────────

  /** Recompute all world matrices (dirty-aware). */
  updateTransforms(): void { updateWorldTransforms(this.root); }

  // ── Integrity ───────────────────────────────────────────────────

  /** Audit for structural problems (empty array = healthy). */
  audit(): string[] { return auditGraph(this.root); }

  // ── Internals ───────────────────────────────────────────────────

  private resolve(target: SceneNode | NodeId): SceneNode | null {
    return typeof target === 'string' ? this.find(target as NodeId) : target;
  }

  private indexSubtree(root: SceneNode): void {
    for (const node of dfs(root)) {
      if (this.index.has(node.id) && this.index.get(node.id) !== node) {
        throw new SceneValidationError('DUPLICATE_ID', `Duplicate node id "${node.id}"`);
      }
      this.index.set(node.id, node);
      node.onChange = (n, changed) => this.onNodeChanged(n, changed);
      node.transform.onChange = () => {
        this.events.emit('TransformChanged', { node });
        this.events.emit('NodeUpdated', { node, changed: 'transform' });
      };
    }
  }

  private deindexSubtree(root: SceneNode): void {
    const removed = new Set<NodeId>();
    for (const node of dfs(root)) {
      removed.add(node.id);
      this.index.delete(node.id);
      node.onChange = null;
      node.transform.onChange = null;
    }
    const keep = this.selection.get().filter((id) => !removed.has(id));
    if (keep.length !== this.selection.count()) this.selection.set(keep);
  }

  private onNodeChanged(node: SceneNode, changed: string): void {
    this.events.emit('NodeUpdated', { node, changed });
    if (changed === 'visible') this.events.emit('VisibilityChanged', { node, visible: node.visible });
  }
}
