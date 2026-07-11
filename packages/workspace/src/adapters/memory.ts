/**
 * In-memory port adapters. A dependency-free `SceneGraphPort`/`SelectionPort`/
 * `CommandPort` trio that lets the Workspace run headless — for tests, for
 * server-side layout, or as a starting point before wiring the real
 * `@motion/scene`. Not the production binding; just a faithful, minimal one.
 */

import type { Vec2 } from '../math/Vec2';
import * as Mat from '../math/Mat2D';
import type { Rect } from '../math/Rect';
import type {
  NodeId,
  SceneGraphPort,
  SelectionPort,
  CommandPort,
  WorkspaceNode,
  WorkspaceCommand,
} from '../ports';

export interface MemoryNodeInit {
  id: NodeId;
  bounds: Rect;
  parentId?: NodeId | null;
  visible?: boolean;
  locked?: boolean;
  zIndex?: number;
  hitTestLocal?: (localPoint: Vec2) => boolean;
}

/** A mutable Scene Graph backed by a Map, emitting on structural change. */
export class MemoryScene implements SceneGraphPort {
  private readonly nodes = new Map<NodeId, WorkspaceNode>();
  private readonly listeners = new Set<() => void>();

  constructor(nodes: MemoryNodeInit[] = []) {
    for (const n of nodes) this.put(n, false);
  }

  put(init: MemoryNodeInit, notify = true): WorkspaceNode {
    const node: WorkspaceNode = {
      id: init.id,
      parentId: init.parentId ?? null,
      worldBounds: init.bounds,
      localBounds: { x: 0, y: 0, width: init.bounds.width, height: init.bounds.height },
      worldMatrix: Mat.translation(init.bounds.x, init.bounds.y),
      visible: init.visible ?? true,
      locked: init.locked ?? false,
      zIndex: init.zIndex ?? this.nodes.size,
      ...(init.hitTestLocal ? { hitTestLocal: init.hitTestLocal } : {}),
    };
    this.nodes.set(node.id, node);
    if (notify) this.emit();
    return node;
  }

  /** Translate a node's world bounds (used by move commands in tests). */
  moveBy(id: NodeId, delta: Vec2, notify = true): void {
    const n = this.nodes.get(id);
    if (!n) return;
    const bounds: Rect = { ...n.worldBounds, x: n.worldBounds.x + delta.x, y: n.worldBounds.y + delta.y };
    this.nodes.set(id, { ...n, worldBounds: bounds, worldMatrix: Mat.translation(bounds.x, bounds.y) });
    if (notify) this.emit();
  }

  remove(id: NodeId): void {
    if (this.nodes.delete(id)) this.emit();
  }

  getNodes(): Iterable<WorkspaceNode> {
    return this.nodes.values();
  }

  getNode(id: NodeId): WorkspaceNode | undefined {
    return this.nodes.get(id);
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** A Set-backed selection model matching the SelectionPort contract. */
export class MemorySelection implements SelectionPort {
  private ids: NodeId[] = [];
  private readonly listeners = new Set<(selected: readonly NodeId[]) => void>();

  get(): readonly NodeId[] {
    return [...this.ids];
  }
  has(id: NodeId): boolean {
    return this.ids.includes(id);
  }
  set(ids: Iterable<NodeId>): void {
    const next = [...new Set(ids)];
    if (this.sameAs(next)) return;
    this.ids = next;
    this.emit();
  }
  add(id: NodeId): void {
    if (this.ids.includes(id)) return;
    this.ids = [...this.ids, id];
    this.emit();
  }
  remove(id: NodeId): void {
    if (!this.ids.includes(id)) return;
    this.ids = this.ids.filter((x) => x !== id);
    this.emit();
  }
  toggle(id: NodeId): void {
    if (this.ids.includes(id)) this.remove(id);
    else this.add(id);
  }
  clear(): void {
    if (this.ids.length === 0) return;
    this.ids = [];
    this.emit();
  }
  onChanged(listener: (selected: readonly NodeId[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private sameAs(next: NodeId[]): boolean {
    return next.length === this.ids.length && next.every((id, i) => id === this.ids[i]);
  }
  private emit(): void {
    const snapshot = this.get();
    for (const l of [...this.listeners]) l(snapshot);
  }
}

/** A command sink that records everything for inspection. */
export class RecordingCommandPort implements CommandPort {
  readonly log: WorkspaceCommand[] = [];
  execute(command: WorkspaceCommand): void {
    this.log.push(command);
  }
  clear(): void {
    this.log.length = 0;
  }
}
