/**
 * SceneNode — the universal object in the graph. Everything in the editor is a
 * SceneNode: compositions, groups, shapes, media, cameras, lights, particles.
 *
 * A node is composed of components (Transform is mandatory; the rest are
 * optional data components). Structural mutation of `children` is performed by
 * the owning {@link Scene} so the id index, validation, and events stay
 * consistent — the `_`-prefixed methods here are engine-internal.
 */

import type { BlendMode, Metadata, NodeId, Timestamp } from '../types';
import type { Component } from '../components/Component';
import { deepCloneData } from '../components/Component';
import { TransformComponent } from '../components/TransformComponent';
import { newNodeId } from '../utils/id';
import { bumpSceneMutationEpoch } from '../core/mutationEpoch';

export type NodeChangeListener = (node: SceneNode, changed: string) => void;

export interface SceneNodeOptions {
  id?: NodeId;
  name?: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  metadata?: Metadata;
  /** Restored timestamps (deserialization). Default to "now". */
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export class SceneNode {
  readonly id: NodeId;
  readonly type: string;
  readonly createdAt: Timestamp;
  updatedAt: Timestamp;

  parent: SceneNode | null = null;
  readonly children: SceneNode[] = [];
  metadata: Metadata = {};
  /** User-defined custom properties (free-form, serialized with the node). */
  readonly custom: Record<string, unknown> = {};

  /** Notified by the Scene on any state change, to bridge to the event bus. */
  onChange: NodeChangeListener | null = null;

  private _name: string;
  private _visible: boolean;
  private _locked: boolean;
  private _selected = false;
  private _opacity: number;
  private _blendMode: BlendMode;

  private readonly components = new Map<string, Component>();

  constructor(type: string, opts: SceneNodeOptions = {}) {
    this.id = opts.id ?? newNodeId();
    this.type = type;
    this._name = opts.name ?? type;
    this._visible = opts.visible ?? true;
    this._locked = opts.locked ?? false;
    this._opacity = opts.opacity ?? 1;
    this._blendMode = opts.blendMode ?? 'normal';
    if (opts.metadata) this.metadata = deepCloneData(opts.metadata);
    const now = Date.now();
    this.createdAt = opts.createdAt ?? now;
    this.updatedAt = opts.updatedAt ?? now;
    this.components.set('transform', new TransformComponent());
  }

  /** Globally unique identifier (alias of `id`). */
  get uuid(): string { return this.id; }

  /** The mandatory transform component. */
  get transform(): TransformComponent {
    return this.components.get('transform') as TransformComponent;
  }

  // ── Observable state (setters bump updatedAt + notify) ──────────
  get name(): string { return this._name; }
  set name(v: string) { if (v !== this._name) { this._name = v; this.touch('name'); } }

  get visible(): boolean { return this._visible; }
  set visible(v: boolean) { if (v !== this._visible) { this._visible = v; this.touch('visible'); } }

  get locked(): boolean { return this._locked; }
  set locked(v: boolean) { if (v !== this._locked) { this._locked = v; this.touch('locked'); } }

  get selected(): boolean { return this._selected; }
  set selected(v: boolean) { if (v !== this._selected) { this._selected = v; this.touch('selected'); } }

  get opacity(): number { return this._opacity; }
  set opacity(v: number) {
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    if (clamped !== this._opacity) { this._opacity = clamped; this.touch('opacity'); }
  }

  get blendMode(): BlendMode { return this._blendMode; }
  set blendMode(v: BlendMode) { if (v !== this._blendMode) { this._blendMode = v; this.touch('blendMode'); } }

  /**
   * Update the modified timestamp and notify the owning scene.
   *
   * Also bumps the global mutation epoch. Note this covers only what routes
   * through `touch` — the node's own fields (name/visible/locked/opacity/blend)
   * and component add/remove. Component DATA writes do NOT reliably reach here
   * (see `core/mutationEpoch.ts`), so `DataComponent.set` bumps the epoch
   * itself; between the two, every mutation that can change what a node renders
   * as is covered.
   */
  touch(changed: string): void {
    this.updatedAt = Date.now();
    bumpSceneMutationEpoch();
    this.onChange?.(this, changed);
  }

  // ── Components ──────────────────────────────────────────────────
  addComponent(component: Component): this {
    this.components.set(component.type, component);
    this.touch(`component:${component.type}`);
    return this;
  }

  getComponent<T extends Component = Component>(type: string): T | undefined {
    return this.components.get(type) as T | undefined;
  }

  requireComponent<T extends Component = Component>(type: string): T {
    const c = this.components.get(type);
    if (!c) throw new Error(`Node ${this.id} has no "${type}" component`);
    return c as T;
  }

  hasComponent(type: string): boolean {
    return this.components.has(type);
  }

  removeComponent(type: string): boolean {
    if (type === 'transform') return false; // transform is mandatory
    const ok = this.components.delete(type);
    if (ok) this.touch(`component:-${type}`);
    return ok;
  }

  componentList(): Component[] {
    return [...this.components.values()];
  }

  // ── Read-only hierarchy helpers ─────────────────────────────────
  get childCount(): number { return this.children.length; }
  get isLeaf(): boolean { return this.children.length === 0; }
  get isRoot(): boolean { return this.parent === null; }

  indexInParent(): number {
    return this.parent ? this.parent.children.indexOf(this) : -1;
  }

  depth(): number {
    let d = 0;
    let n: SceneNode | null = this.parent;
    while (n) { d++; n = n.parent; }
    return d;
  }

  /** Path from the root down to (and including) this node. */
  path(): SceneNode[] {
    // Seeded with `this` and walked from the PARENT, rather than aliasing
    // `this` into the cursor. Same array, and it keeps the cursor's type
    // honest — it is the nullable one, `this` never is.
    const out: SceneNode[] = [this];
    let n = this.parent;
    while (n) { out.push(n); n = n.parent; }
    return out.reverse();
  }

  isAncestorOf(node: SceneNode): boolean {
    let n: SceneNode | null = node.parent;
    while (n) { if (n === this) return true; n = n.parent; }
    return false;
  }

  isDescendantOf(node: SceneNode): boolean {
    return node.isAncestorOf(this);
  }

  // ── Engine-internal structural mutation (owned by Scene) ────────
  _insertChildInternal(child: SceneNode, index: number): void {
    const i = Math.max(0, Math.min(index, this.children.length));
    this.children.splice(i, 0, child);
    child.parent = this;
    child.transform.worldDirty = true;
  }

  _removeChildInternal(child: SceneNode): boolean {
    const i = this.children.indexOf(child);
    if (i < 0) return false;
    this.children.splice(i, 1);
    child.parent = null;
    return true;
  }

  /**
   * Deep clone with fresh ids — a fully detached subtree. Components (incl.
   * transform) and custom data are deep-copied; children are cloned recursively.
   */
  clone(): SceneNode {
    const copy = new SceneNode(this.type, {
      name: this._name,
      visible: this._visible,
      locked: this._locked,
      opacity: this._opacity,
      blendMode: this._blendMode,
    });
    copy.metadata = deepCloneData(this.metadata);
    Object.assign(copy.custom, deepCloneData(this.custom));
    copy.components.clear();
    for (const c of this.components.values()) copy.components.set(c.type, c.clone());
    for (const child of this.children) copy._insertChildInternal(child.clone(), copy.children.length);
    return copy;
  }
}
