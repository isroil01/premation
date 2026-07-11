import { SceneNode, Transform, Component, ID } from '../types';
import {
  Scene,
  createNode,
  DataComponent,
  type SceneNode as EngineNode,
  type NodeId,
} from '@motion/scene';

/**
 * The app's scene graph — backed by the framework-independent `@motion/scene`
 * engine, which is the single source of truth (stage 2).
 *
 * Each app node is an engine node, and each app component lives in the engine's
 * generic component bag as a `DataComponent` (`type` + `data` = the component's
 * `props`, with the original component id preserved under `__cid`). There is no
 * duplicated plain-node copy. The rest of the app still speaks the loose
 * `SceneNode`/`Component` shape, so `getNode` returns a cached **live view**
 * (`AppNodeView`) that reconstructs that shape from the engine's components on
 * demand; field writes proxy back to the engine. Writes flow through
 * `writeProp` / `setEffects` (InspectorAPI + the effects engine).
 */

const KIND_PROP = '__kind';
const CID = '__cid'; // reserved DataComponent.data key: the original app component id
const ENGINE_TRANSFORM = 'transform'; // the engine's mandatory (lowercase) TransformComponent

const KIND_TO_ENGINE_TYPE: Record<string, string> = {
  group: 'group',
  shape: 'rectangle',
  text: 'text',
  image: 'image',
  video: 'video',
};

function kindOfPlain(node: SceneNode): string {
  for (const c of node.components) {
    const k = (c.props as Record<string, unknown> | undefined)?.[KIND_PROP];
    if (typeof k === 'string') return k;
  }
  return 'group';
}

/** The app components stored on an engine node (its data components, minus the
 *  engine's mandatory transform), in insertion order. */
function appComponents(e: EngineNode): DataComponent[] {
  const out: DataComponent[] = [];
  for (const c of e.componentList()) {
    if (c.type !== ENGINE_TRANSFORM) out.push(c as DataComponent);
  }
  return out;
}

/** Reconstruct the loose `Component[]` view from the engine's data components. */
function buildComponents(e: EngineNode): Component[] {
  return appComponents(e).map((dc) => {
    const { [CID]: cid, ...props } = dc.data;
    return { id: (cid as ID) ?? `${e.id as string}::${dc.type}`, type: dc.type, props: { ...props } };
  });
}

/** A live view onto an engine node that satisfies the app's `SceneNode` shape. */
class AppNodeView implements SceneNode {
  constructor(private readonly e: EngineNode) {}

  get id(): ID {
    return this.e.id as ID;
  }
  get name(): string | undefined {
    return this.e.name;
  }
  set name(v: string | undefined) {
    if (v !== undefined) this.e.name = v;
  }
  get children(): ID[] {
    return (this.e.custom.childIds as ID[]) ?? [];
  }
  set children(v: ID[]) {
    this.e.custom.childIds = v;
  }
  get parent(): ID | null {
    return (this.e.custom.parentId as ID | null) ?? null;
  }
  set parent(v: ID | null | undefined) {
    this.e.custom.parentId = v ?? null;
  }
  get visible(): boolean {
    return this.e.visible;
  }
  set visible(v: boolean | undefined) {
    this.e.visible = v !== false;
  }
  get locked(): boolean {
    return this.e.locked;
  }
  set locked(v: boolean | undefined) {
    this.e.locked = !!v;
  }
  get solo(): boolean {
    return this.e.custom.solo === true;
  }
  set solo(v: boolean | undefined) {
    this.e.custom.solo = !!v;
  }
  get transform(): Transform {
    // Derived from whichever component carries x/y/rotation (app convention).
    let x = 0;
    let y = 0;
    let rotation = 0;
    for (const dc of appComponents(this.e)) {
      const d = dc.data;
      if (typeof d.x === 'number') x = d.x;
      if (typeof d.y === 'number') y = d.y;
      if (typeof d.rotation === 'number') rotation = d.rotation;
    }
    return { position: { x, y }, rotation, scale: { x: 1, y: 1 } };
  }
  get components(): Component[] {
    return buildComponents(this.e);
  }
}

export class SceneGraph {
  private scene = new Scene();

  /** Import a plain app node into the engine as data components + register it. */
  private wrap(node: SceneNode): void {
    const kind = kindOfPlain(node);
    const type = KIND_TO_ENGINE_TYPE[kind] ?? 'null';
    const e = createNode(type, { id: node.id as NodeId });
    if (node.name) e.name = node.name;
    e.visible = node.visible !== false;
    e.locked = !!node.locked;
    if (node.solo) e.custom.solo = true;
    e.custom.kind = kind;
    e.custom.childIds = [...(node.children ?? [])];
    e.custom.parentId = node.parent ?? null;
    // Start from a clean bag (drop any per-type default data components so the
    // view shows exactly the app's components).
    for (const c of appComponents(e)) e.removeComponent(c.type);
    for (const c of node.components) {
      e.addComponent(new DataComponent(c.type, { ...((c.props ?? {}) as Record<string, unknown>), [CID]: c.id }));
    }
    this.scene.add(e, this.scene.root);
  }

  private viewOf(e: EngineNode): SceneNode {
    let v = e.custom.__view as AppNodeView | undefined;
    if (!v) {
      v = new AppNodeView(e);
      e.custom.__view = v;
    }
    return v;
  }

  private engine(id: ID): EngineNode | undefined {
    return this.scene.find(id as NodeId) ?? undefined;
  }

  addNode(node: SceneNode): void {
    if (this.engine(node.id)) return;
    this.wrap(node);
  }

  /** Add a node and link it as a child of `parentId` (keeps the tree consistent). */
  addChild(parentId: ID, node: SceneNode): void {
    node.parent = parentId;
    if (!this.engine(node.id)) this.wrap(node);
    const pe = this.engine(parentId);
    if (pe) {
      const kids = (pe.custom.childIds as ID[]) ?? (pe.custom.childIds = []);
      if (!kids.includes(node.id)) kids.push(node.id);
    }
    const ce = this.engine(node.id);
    if (ce) ce.custom.parentId = parentId;
  }

  removeNode(id: ID): void {
    const e = this.engine(id);
    if (!e) return;
    const parentId = e.custom.parentId as ID | null;
    if (parentId) {
      const pe = this.engine(parentId);
      if (pe && Array.isArray(pe.custom.childIds)) {
        pe.custom.childIds = (pe.custom.childIds as ID[]).filter((c) => c !== id);
      }
    }
    for (const c of [...((e.custom.childIds as ID[]) ?? [])]) this.removeNode(c);
    this.scene.remove(id as NodeId);
  }

  getNode(id: ID): SceneNode | undefined {
    const e = this.engine(id);
    return e ? this.viewOf(e) : undefined;
  }

  /** Root nodes (no parent), in insertion order. */
  getRoots(): SceneNode[] {
    const roots: SceneNode[] = [];
    for (const e of this.scene.root.children) {
      if (!e.custom.parentId) roots.push(this.viewOf(e));
    }
    return roots;
  }

  /** Direct children of a node, in the order listed on `childIds`. */
  getChildren(id: ID): SceneNode[] {
    const e = this.engine(id);
    if (!e) return [];
    const out: SceneNode[] = [];
    for (const cid of (e.custom.childIds as ID[]) ?? []) {
      const child = this.getNode(cid);
      if (child) out.push(child);
    }
    return out;
  }

  /** Number of nodes in the graph. */
  get size(): number {
    return this.scene.size - 1; // exclude the engine root
  }

  // Pre-order traversal over the registered nodes.
  traverse(cb: (n: SceneNode) => void): void {
    for (const e of this.scene.root.children) cb(this.viewOf(e));
  }

  /** Write a prop into the app component identified by `componentId`. */
  writeProp(nodeId: ID, componentId: ID, propName: string, value: unknown): boolean {
    const e = this.engine(nodeId);
    if (!e) return false;
    for (const dc of appComponents(e)) {
      if (dc.data[CID] === componentId) {
        dc.set(propName, value);
        e.touch(`prop:${propName}`);
        return true;
      }
    }
    return false;
  }

  /** Store the effect stack (fx) on the node's `fx` component (created on demand). */
  setEffects(nodeId: ID, effects: unknown[]): void {
    this.setFx(nodeId, 'effects', effects);
  }

  /** Store the layer's blend mode on its `fx` component. */
  setBlendMode(nodeId: ID, mode: string): void {
    this.setFx(nodeId, 'blendMode', mode);
  }

  /** Store the layer's vector mask on its `fx` component (undefined clears it). */
  setMask(nodeId: ID, mask: unknown): void {
    this.setFx(nodeId, 'mask', mask);
  }

  /** Store the layer's track-matte type on its `fx` component (undefined clears). */
  setMatte(nodeId: ID, matte: unknown): void {
    this.setFx(nodeId, 'matte', matte);
  }

  /** Mark the layer as an adjustment layer on its `fx` component. */
  setAdjustment(nodeId: ID, on: unknown): void {
    this.setFx(nodeId, 'isAdjustment', on);
  }

  /** Toggle per-layer motion blur on its `fx` component. */
  setMotionBlur(nodeId: ID, on: unknown): void {
    this.setFx(nodeId, 'motionBlur', on);
  }

  /** Write a single key onto the node's `fx` component (created on demand). */
  private setFx(nodeId: ID, key: string, value: unknown): void {
    const e = this.engine(nodeId);
    if (!e) return;
    let fx = e.getComponent<DataComponent>('fx');
    if (!fx) {
      fx = new DataComponent('fx', { [CID]: `${nodeId}_fx` });
      e.addComponent(fx);
    }
    fx.set(key, value);
  }

  // Compute world transforms (naive additive; retained for API parity).
  computeWorldTransforms(rootId?: ID): Map<ID, Transform> {
    const out = new Map<ID, Transform>();
    const compute = (node: SceneNode, parentTransform?: Transform) => {
      const world: Transform = {
        position: {
          x: (parentTransform?.position.x ?? 0) + node.transform.position.x,
          y: (parentTransform?.position.y ?? 0) + node.transform.position.y,
        },
        rotation: (parentTransform?.rotation ?? 0) + node.transform.rotation,
        scale: {
          x: (parentTransform?.scale.x ?? 1) * node.transform.scale.x,
          y: (parentTransform?.scale.y ?? 1) * node.transform.scale.y,
        },
      };
      out.set(node.id, world);
      for (const child of this.getChildren(node.id)) compute(child, world);
    };
    if (rootId) {
      const r = this.getNode(rootId);
      if (r) compute(r, undefined);
    } else {
      for (const r of this.getRoots()) compute(r, undefined);
    }
    return out;
  }
}

export default SceneGraph;
