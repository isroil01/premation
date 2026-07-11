/**
 * SelectionModel — single, multi, and named-group selection. Emits through an
 * `onChange` hook the Scene wires to the event bus (and to node.selected flags).
 */

import type { NodeId } from '../types';

export class SelectionModel {
  private readonly ids = new Set<NodeId>();
  private _primary: NodeId | null = null;
  private readonly groups = new Map<string, NodeId[]>();

  /** Wired by the Scene: (selected, previous) → emit + sync flags. */
  onChange: ((selected: NodeId[], previous: NodeId[]) => void) | null = null;

  get(): NodeId[] { return [...this.ids]; }
  has(id: NodeId): boolean { return this.ids.has(id); }
  count(): number { return this.ids.size; }
  primary(): NodeId | null { return this._primary; }
  isEmpty(): boolean { return this.ids.size === 0; }

  /** Replace the whole selection. */
  set(ids: Iterable<NodeId>): void {
    const prev = this.get();
    this.ids.clear();
    for (const id of ids) this.ids.add(id);
    this._primary = this.get()[0] ?? null;
    this.commit(prev);
  }

  add(id: NodeId): void {
    if (this.ids.has(id)) { this._primary = id; return; }
    const prev = this.get();
    this.ids.add(id);
    this._primary = id;
    this.commit(prev);
  }

  addMany(ids: Iterable<NodeId>): void {
    const prev = this.get();
    let changed = false;
    for (const id of ids) { if (!this.ids.has(id)) { this.ids.add(id); this._primary = id; changed = true; } }
    if (changed) this.commit(prev);
  }

  remove(id: NodeId): void {
    if (!this.ids.delete(id)) return;
    const prev = [...this.get(), id];
    if (this._primary === id) this._primary = this.get()[0] ?? null;
    this.commit(prev);
  }

  toggle(id: NodeId): void {
    if (this.ids.has(id)) this.remove(id);
    else this.add(id);
  }

  clear(): void {
    if (this.ids.size === 0) return;
    const prev = this.get();
    this.ids.clear();
    this._primary = null;
    this.commit(prev);
  }

  // ── Named selection groups ──────────────────────────────────────
  saveGroup(name: string): void { this.groups.set(name, this.get()); }
  loadGroup(name: string): boolean {
    const g = this.groups.get(name);
    if (!g) return false;
    this.set(g);
    return true;
  }
  deleteGroup(name: string): boolean { return this.groups.delete(name); }
  groupNames(): string[] { return [...this.groups.keys()]; }

  private commit(previous: NodeId[]): void {
    this.onChange?.(this.get(), previous);
  }
}
