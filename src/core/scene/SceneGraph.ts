import { SceneNode, Transform, Component, ID } from '../types';
import {
  Scene,
  createNode,
  DataComponent,
  Matrix,
  type Matrix2D,
  type SceneNode as EngineNode,
  type NodeId,
} from '@motion/scene';
import { worldMatrixOf, localUnderParent } from './worldTransform';

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
  null: 'group',
  shape: 'rectangle',
  text: 'text',
  image: 'image',
  video: 'video',
  // An SVG layer is a stored vector document rasterized to a texture — from the
  // engine's point of view that is an image.
  svg: 'image',
  camera: 'group',
  light: 'group',
  adjustment: 'rectangle',
  particle: 'rectangle',
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
  /** AE-style label color (hex). Stored on the engine node so it survives the
   *  view cache and serializes with the project (sceneProjectIO.capture). */
  get color(): string | undefined {
    const c = this.e.custom.labelColor;
    return typeof c === 'string' ? c : undefined;
  }
  set color(v: string | undefined) {
    if (v === undefined) delete this.e.custom.labelColor;
    else this.e.custom.labelColor = v;
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
    if (typeof node.color === 'string') e.custom.labelColor = node.color;
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

  private getLocalTransform(nodeId: ID): { x: number; y: number; rotation: number; scaleX: number; scaleY: number } | null {
    const node = this.getNode(nodeId);
    if (!node) return null;
    let scaleX = 1;
    let scaleY = 1;
    let scale: number | undefined;
    for (const c of node.components) {
      const p = c.props as Record<string, unknown>;
      if (typeof p.scaleX === 'number') scaleX = p.scaleX;
      if (typeof p.scaleY === 'number') scaleY = p.scaleY;
      if (typeof p.scale === 'number') scale = p.scale;
    }
    return {
      x: node.transform.position.x,
      y: node.transform.position.y,
      rotation: node.transform.rotation,
      scaleX: scale ?? scaleX,
      scaleY: scale ?? scaleY,
    };
  }

  /** Relink `childId` under `newParentId` (or a root when null), keeping both
   *  the old and new parents' child lists consistent. By default (`options.preserveWorld = true`),
   *  compensates the local transform so the node does not jump on screen. */
  setParent(
    childId: ID,
    newParentId: ID | null,
    options: { preserveWorld?: boolean } = { preserveWorld: true },
  ): void {
    const ce = this.engine(childId);
    if (!ce) return;
    const oldParentId = ce.custom.parentId as ID | null;
    const targetId = newParentId && newParentId !== 'comp_root' ? newParentId : null;
    if (oldParentId === targetId || oldParentId === newParentId) return;

    let childWorld: Matrix2D | null = null;
    if (options.preserveWorld !== false) {
      const localOf = (id: string) => this.getLocalTransform(id);
      const parentOf = (id: string) => {
        const p = this.engine(id)?.custom.parentId as ID | null;
        return p && p !== 'comp_root' ? p : null;
      };
      childWorld = worldMatrixOf(childId, localOf, parentOf, new Map());
    }

    if (oldParentId) {
      const oe = this.engine(oldParentId);
      if (oe && Array.isArray(oe.custom.childIds)) {
        oe.custom.childIds = (oe.custom.childIds as ID[]).filter((c) => c !== childId);
      }
    }
    ce.custom.parentId = newParentId ?? null;
    if (newParentId) {
      const pe = this.engine(newParentId);
      if (pe) {
        const kids = (pe.custom.childIds as ID[]) ?? (pe.custom.childIds = []);
        if (!kids.includes(childId)) kids.push(childId);
      }
    }

    if (options.preserveWorld !== false && childWorld) {
      const localOf = (id: string) => this.getLocalTransform(id);
      const parentOf = (id: string) => {
        const p = this.engine(id)?.custom.parentId as ID | null;
        return p && p !== 'comp_root' ? p : null;
      };
      const parentWorld = targetId
        ? worldMatrixOf(targetId, localOf, parentOf, new Map())
        : Matrix.identity();
      const compensated = localUnderParent(childWorld, Matrix.clone(parentWorld));
      this.setLocalTransform(childId, compensated);
    }
  }

  /** Write a node's local transform onto the data component carrying x/y (the
   *  Transform component); `node.transform` derives from it automatically. */
  setLocalTransform(
    nodeId: ID,
    t: { x: number; y: number; rotation: number; scaleX?: number; scaleY?: number },
  ): void {
    const e = this.engine(nodeId);
    if (!e) return;
    let target: DataComponent | undefined;
    for (const c of e.componentList()) {
      if (c.type === ENGINE_TRANSFORM) continue;
      const dc = c as DataComponent;
      if (typeof dc.data.x === 'number') { target = dc; break; }
    }
    if (!target) return;
    target.set('x', t.x);
    target.set('y', t.y);
    target.set('rotation', t.rotation);
    if (t.scaleX !== undefined) target.set('scaleX', t.scaleX);
    if (t.scaleY !== undefined) target.set('scaleY', t.scaleY);
  }

  setSeparateDimensions(nodeId: ID, separateDimensions: boolean): void {
    const e = this.engine(nodeId);
    if (!e) return;
    for (const c of e.componentList()) {
      if (c.type === ENGINE_TRANSFORM) continue;
      const dc = c as DataComponent;
      if (typeof dc.data.x === 'number') {
        dc.set('separateDimensions', separateDimensions);
        break;
      }
    }
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

  // `computeWorldTransforms` used to live here. It was dead — nothing imported
  // it (the live one of that name is the rig's, in core/rig/skeleton.ts) — and
  // it was a trap: it summed `node.transform`, whose `scale` getter returns a
  // hardcoded {1,1}, so any caller would have silently ignored every layer's
  // scale. The real world-matrix path is `worldTransform.ts:worldMatrixOf`,
  // which reads scaleX/scaleY off the components.

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

  /**
   * Attach a whole app component to an existing node.
   *
   * `getNode(id).components` is a live VIEW rebuilt from the engine on every
   * read, so `node.components.push(...)` mutates a throwaway array and is
   * silently lost. Anything that needs to add a component after a node is in
   * the graph has to come through here.
   *
   * Replaces an existing component of the same type, matching `wrap`'s
   * one-component-per-type contract.
   */
  addComponent(nodeId: ID, component: Component): boolean {
    const e = this.engine(nodeId);
    if (!e) return false;
    if (e.getComponent(component.type)) e.removeComponent(component.type);
    e.addComponent(
      new DataComponent(component.type, {
        ...((component.props ?? {}) as Record<string, unknown>),
        [CID]: component.id,
      }),
    );
    e.touch(`component:${component.type}`);
    return true;
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

  /** Store the layer's puppet rig on its `fx` component (undefined clears it). */
  setPuppet(nodeId: ID, puppet: unknown): void {
    this.setFx(nodeId, 'puppet', puppet);
  }

  /** Store the layer's skeleton rig on its `fx` component (undefined clears it). */
  setSkeleton(nodeId: ID, skeleton: unknown): void {
    this.setFx(nodeId, 'skeleton', skeleton);
  }

  /** Store animated mask keyframes on its `fx` (undefined clears them). */
  setMaskAnim(nodeId: ID, keyframes: unknown): void {
    this.setFx(nodeId, 'maskAnim', keyframes);
  }

  /** Store the layer's track-matte type on its `fx` component (undefined clears). */
  setMatte(nodeId: ID, matte: unknown): void {
    this.setFx(nodeId, 'matte', matte);
  }

  /** Store the text layer's path options on its `fx` component (undefined clears). */
  setTextPath(nodeId: ID, cfg: unknown): void {
    this.setFx(nodeId, 'textPath', cfg);
  }

  /** Mark the layer as an adjustment layer on its `fx` component. */
  setAdjustment(nodeId: ID, on: unknown): void {
    this.setFx(nodeId, 'isAdjustment', on);
  }

  /** Toggle per-layer motion blur on its `fx` component. */
  setMotionBlur(nodeId: ID, on: unknown): void {
    this.setFx(nodeId, 'motionBlur', on);
  }

  /** Toggle the layer's effect stack (After Effects' `fx` switch). */
  setFxEnabled(nodeId: ID, enabled: unknown): void {
    this.setFx(nodeId, 'fxEnabled', enabled);
  }

  /** Toggle auto-orient (rotate along the motion path) on its `fx` component. */
  setAutoOrient(nodeId: ID, on: unknown): void {
    this.setFx(nodeId, 'autoOrient', on);
  }

  /** Store the layer's shape-repeater config on its `fx` (undefined clears it). */
  setRepeater(nodeId: ID, repeater: unknown): void {
    this.setFx(nodeId, 'repeater', repeater);
  }

  /** Store the layer's trim-path config on its `fx` (undefined clears it). */
  setTrimPath(nodeId: ID, trim: unknown): void {
    this.setFx(nodeId, 'trim', trim);
  }

  /** Store the layer's path-operator config on its `fx` (undefined clears it). */
  setPathOp(nodeId: ID, op: unknown): void {
    this.setFx(nodeId, 'pathOp', op);
  }

  /** Flag a group as a precomp (composite its subtree as one unit). */
  setPrecomp(nodeId: ID, on: unknown): void {
    this.setFx(nodeId, 'precomp', on);
  }

  /** Store the layer's fill paint on its `fx` component (undefined clears it). */
  setFill(nodeId: ID, fill: unknown): void {
    this.setFx(nodeId, 'fill', fill);
  }

  /** Store the layer's FILL STACK (multi-fill) on its `fx` (undefined clears it). */
  setFills(nodeId: ID, fills: unknown): void {
    this.setFx(nodeId, 'fills', fills);
  }

  /** Store the layer's stroke on its `fx` component (undefined clears it). */
  setStroke(nodeId: ID, stroke: unknown): void {
    this.setFx(nodeId, 'stroke', stroke);
  }

  /** Store the layer's STROKE STACK (multi-stroke) on its `fx` (undefined clears it). */
  setStrokes(nodeId: ID, strokes: unknown): void {
    this.setFx(nodeId, 'strokes', strokes);
  }

  /** Flag the layer as a full-frame solid on its `fx` component. */
  setSolid(nodeId: ID, on: unknown): void {
    this.setFx(nodeId, 'solid', on);
  }

  /** Store the layer's time controls (stretch/reverse/freeze) on its `fx`. */
  setLayerTime(nodeId: ID, time: unknown): void {
    this.setFx(nodeId, 'time', time);
  }

  /** Store the layer's Photoshop-style layer styles (shadow/glow) on its `fx`. */
  setLayerStyles(nodeId: ID, styles: unknown): void {
    this.setFx(nodeId, 'layerStyles', styles);
  }

  /** Store the layer's particle-emitter config on its `fx` component. */
  setParticle(nodeId: ID, config: unknown): void {
    this.setFx(nodeId, 'particle', config);
  }

  /** Store the layer's render quality ('draft' | undefined=best) on its `fx`. */
  setLayerQuality(nodeId: ID, quality: unknown): void {
    this.setFx(nodeId, 'quality', quality);
  }

  /** Store an image-sequence config ({frames,fps}) on the layer's `fx`. */
  setImageSequence(nodeId: ID, sequence: unknown): void {
    this.setFx(nodeId, 'sequence', sequence);
  }

  /** Store the layer's paint-stroke config ({strokes}) on its `fx` component. */
  setPaint(nodeId: ID, paint: unknown): void {
    this.setFx(nodeId, 'paint', paint);
  }

  /** Store the layer's audio-waveform generator config on its `fx` (undefined clears it). */
  setAudioWaveform(nodeId: ID, config: unknown): void {
    this.setFx(nodeId, 'audioWaveform', config);
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

  clear(): void {
    this.scene = new Scene();
  }
}

export default SceneGraph;
