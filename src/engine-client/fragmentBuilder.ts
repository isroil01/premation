/* eslint-disable no-restricted-syntax -- F11 targets SceneGraph copies; the rows here are this builder's own plain data, never scene-graph state. */
/**
 * Layer fragments built on the CLIENT — no document, no engine state.
 *
 * Premation's importers and authored inserts (a Lottie file, a template, an
 * SVG document layer) produce a set of NEW layers. The engine takes such a set
 * as one `pasteLayers` fragment (ENGINE_API.md §4.4 copyLayers / pasteLayers):
 * one command, one undo entry, ids minted by the engine, references between the
 * new layers (parent links, track mattes, …) following the copies. This module
 * builds that fragment directly, from plain data, so an importer needs neither
 * the TypeScript scene graph nor its animation engine nor any store — it is an
 * engine CLIENT that sends one command.
 *
 * The encoding is the one both engines read (src/core/engine/handlers/layers.ts
 * `encodeFragment` / `decodeFragment`, native/engine/src/core/handlers_layers2.cpp
 * `decode_fragment`): `{version: 1, data: utf8(canonical JSON)}` of
 *
 *   { layers: [ { row, anim, bars }, … ] }     FRONT-most first; a layer's
 *                                              children follow it, front first
 *
 *   row    the stored layer node: `{id, name, parent, children, transform,
 *          components: [{id, type, props}], visible, locked, solo, shy?, color?}`.
 *          `id` is a SCRATCH id: the engine mints a new one per layer and
 *          rewrites every in-fragment reference (`parent`, `fx.matte.sourceId`,
 *          effect layer params, …). A `parent` that is not a layer of the
 *          fragment (null here) makes the layer a top-level one. Component ids
 *          are re-derived by the engine (`<layer>_<type>`); `children` and
 *          `transform` are informational (nesting comes from `parent`, the
 *          transform from the Transform component).
 *   anim   the layer's animation `{tracks: {prop: Keyframe[]}, expressions:
 *          {prop: {src, enabled}}, data: {prop: {nodeId, prop, kind,
 *          keyframes}}}` or null. Keyframe times are LAYER seconds (a new
 *          layer starts at 0, so comp seconds), keys sorted by time; keyframe
 *          ids are re-minted by the engine.
 *   bars   timeline bars in frames of the target comp `{start, duration,
 *          sourceIn, sourceDuration}`; EMPTY = the engine's default bar (the
 *          whole comp) — what a new layer gets.
 *
 * Authoring order is SceneGraph order: every layer added (or reparented) lands
 * IN FRONT of the siblings added before it, so a builder written back to front
 * reads like the scene it makes. `build()` turns that into fragment order.
 *
 * The builder is also a minimal layout target (`addNode` / `addChild`), so code
 * that lays out node literals into a SceneGraph can lay the same literals into
 * a fragment (templates/layoutHelpers.ts): `addNode(root)` declares a ROOT —
 * a composition root or container the layers hang under — whose children
 * become the fragment's top-level layers.
 */

import type { DocumentFragment } from '@motion/engine-api';

/** The fragment format version both engines understand (layers.ts FRAGMENT_VERSION, handlers_layers2.cpp kFragmentVersion). */
export const FRAGMENT_VERSION = 1;

/** The component prop that names a layer's kind (seedDefaultScene.ts SCENE_KIND_PROP; native `__kind`). */
export const KIND_PROP = '__kind';

export interface FragmentComponent {
  id: string;
  type: string;
  props: Record<string, unknown>;
}

export interface FragmentTransform {
  position: { x: number; y: number };
  rotation: number;
  scale: { x: number; y: number };
}

/** A stored layer node (the SceneNode shape both engines keep). */
export interface FragmentRow {
  id: string;
  name: string;
  parent: string | null;
  children: string[];
  transform: FragmentTransform;
  components: FragmentComponent[];
  visible: boolean;
  locked: boolean;
  solo?: boolean;
  shy?: boolean;
  color?: string;
}

/** A scalar keyframe as the engines store it (packages/animation Keyframe; native anim_json.cpp key_to_json). */
export interface FragmentKeyframe {
  t: number;
  value: number;
  easing?: string;
  bezier?: readonly number[];
  continuous?: boolean;
  roving?: boolean;
  spatialInterp?: string;
  si?: number;
  so?: number;
  label?: number;
}

/** A data (non-scalar) keyframe — e.g. a `path.points` outline. */
export interface FragmentDataKeyframe {
  t: number;
  value: unknown;
  easing?: string;
  bezier?: readonly number[];
  label?: number;
}

export interface FragmentDataTrack {
  nodeId: string;
  prop: string;
  kind: string;
  keyframes: FragmentDataKeyframe[];
}

export interface FragmentExpression {
  src: string;
  enabled: boolean;
  authoredBy?: string;
}

/** One layer's animation (AnimationEngine.snapshotNode's shape). */
export interface FragmentAnim {
  tracks: Record<string, FragmentKeyframe[]>;
  expressions: Record<string, FragmentExpression>;
  data: Record<string, FragmentDataTrack>;
}

/** A timeline bar, in frames of the target composition. */
export interface FragmentBar {
  start: number;
  duration: number;
  sourceIn: number;
  sourceDuration: number | null;
}

export interface FragmentLayer {
  row: FragmentRow;
  anim: FragmentAnim | null;
  bars: FragmentBar[];
}

export interface BuiltFragment {
  /** What `pasteLayers` takes. */
  fragment: DocumentFragment;
  /** The decoded content, in fragment order (for previews and tests). */
  layers: FragmentLayer[];
  /** Scratch ids in FRAGMENT order — `pasteLayers` returns the new ids in this order. */
  scratchIds: string[];
  /** The top-level scratch ids, front-most first. */
  tops: string[];
}

/** A keyframe setter over (layer, prop, seconds, value, easing) — templates' SetKf. */
export type KeyframeSetter = (id: string, prop: string, timeSec: number, value: number, ease?: string) => void;

interface AnimState {
  tracks: Map<string, FragmentKeyframe[]>;
  expressions: Map<string, FragmentExpression>;
  data: Map<string, FragmentDataTrack>;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The informational row `transform`, derived the way the stored node's is
 * (SceneGraph's node view): the last `x` / `y` / `rotation` across the
 * components, scale 1 — never the literal's own `transform` field, which
 * builders leave at a placeholder once they have written the component.
 */
function derivedTransform(components: readonly FragmentComponent[]): FragmentTransform {
  let x = 0;
  let y = 0;
  let rotation = 0;
  for (const c of components) {
    const p = c.props;
    if (finite(p.x)) x = p.x;
    if (finite(p.y)) y = p.y;
    if (finite(p.rotation)) rotation = p.rotation;
  }
  return { position: { x, y }, rotation, scale: { x: 1, y: 1 } };
}

/** Deep copy of plain JSON data (the fragment's own copy of what callers hand in). */
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * Canonical JSON: object keys sorted, undefined members dropped, arrays kept
 * in order (canonical.ts `canonicalStringify` — the bytes the C++ engine
 * writes for a fragment).
 */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function canonicalFragmentJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

/** Encode fragment layers (fragment order) as the `DocumentFragment` both engines decode. */
export function encodeFragmentLayers(layers: readonly FragmentLayer[]): DocumentFragment {
  const json = canonicalFragmentJson({ layers });
  return { version: FRAGMENT_VERSION, data: new TextEncoder().encode(json) };
}

/** Decode a `DocumentFragment` (tests, previews). Throws on a payload that is not a fragment. */
export function decodeFragmentLayers(f: DocumentFragment): FragmentLayer[] {
  if (f.version !== FRAGMENT_VERSION) throw new Error(`fragment version ${f.version} is not understood`);
  const data = JSON.parse(new TextDecoder().decode(f.data)) as { layers?: FragmentLayer[] };
  if (!Array.isArray(data.layers)) throw new Error('the fragment is not a copyLayers payload');
  return data.layers;
}

/** A node literal `addChild` takes (SceneGraph's SceneNode shape; `parent` / `children` are ignored). */
export type FragmentNodeInput = Omit<FragmentRow, 'name' | 'parent' | 'children' | 'transform' | 'visible' | 'locked'> & {
  /** Absent = the id (SceneGraph's rule). */
  name?: string;
  transform?: FragmentTransform;
  visible?: boolean;
  locked?: boolean;
  parent?: unknown;
  children?: unknown;
};

export interface LayerInit {
  /** Scratch id (default: minted). Must be unique in the builder. */
  id?: string;
  name: string;
  /** A layer of THIS builder to nest under; absent / null / a declared root = top level. */
  parent?: string | null;
  components: FragmentComponent[];
  visible?: boolean;
  locked?: boolean;
  /** The informational `transform` position (default: the Transform component's x/y). */
  x?: number;
  y?: number;
}

export class FragmentBuilder {
  private readonly prefix: string;
  private seq = 0;
  private readonly rows = new Map<string, FragmentRow>();
  /** Declared roots (addNode): a layer added under one of these is top level. */
  private readonly roots = new Set<string>();
  /** Top-level layers, back to front (authoring order). */
  private tops: string[] = [];
  private readonly anims = new Map<string, AnimState>();
  private readonly bars = new Map<string, FragmentBar[]>();

  /** `idPrefix` namespaces minted scratch ids (they only need to be unique inside the fragment). */
  constructor(opts: { idPrefix?: string } = {}) {
    this.prefix = (opts.idPrefix ?? 'frag').replace(/[^\w-]/g, '_');
  }

  // ── ids ─────────────────────────────────────────────────────────────

  /** A fresh scratch layer id. */
  newId(kind = 'layer'): string {
    let id: string;
    do {
      this.seq += 1;
      id = `${this.prefix}_${kind}_${this.seq}`;
    } while (this.rows.has(id) || this.roots.has(id));
    return id;
  }

  /** A fresh id for something inside a layer (a gradient stop, a path operator): no '.' or '/'. */
  uid(tag: string): string {
    this.seq += 1;
    return `${tag}${this.seq}_${this.prefix}`;
  }

  // ── layers ──────────────────────────────────────────────────────────

  /** True when `id` is a layer of this fragment. */
  has(id: string): boolean {
    return this.rows.has(id);
  }

  /** The (mutable) row of a built layer. Throws for an unknown id. */
  row(id: string): FragmentRow {
    const r = this.rows.get(id);
    if (!r) throw new Error(`fragment: no layer '${id}'`);
    return r;
  }

  /** Every built layer id, in the order they were added. */
  layerIds(): string[] {
    return [...this.rows.keys()];
  }

  get size(): number {
    return this.rows.size;
  }

  /**
   * Declare a ROOT (SceneGraph `addNode` for a composition root): nothing is
   * added to the fragment; layers added under `node.id` are top-level ones.
   */
  addNode(node: { id: string }): void {
    if (this.rows.has(node.id)) throw new Error(`fragment: '${node.id}' is already a layer`);
    this.roots.add(node.id);
  }

  /**
   * Add a node literal as a layer IN FRONT of the siblings added before it
   * (SceneGraph `addChild`). `parent` is a layer of this builder (nested) or
   * anything else — a declared root, the composition — for a top-level layer.
   * The literal is copied; its `children` are ignored (children are added
   * with their own `addChild`).
   */
  addChild(parent: string | null, node: FragmentNodeInput): string {
    if (!node || typeof node.id !== 'string' || node.id === '') throw new Error('fragment: a layer needs an id');
    if (this.rows.has(node.id) || this.roots.has(node.id)) throw new Error(`fragment: duplicate layer id '${node.id}'`);
    const nested = parent !== null && this.rows.has(parent);
    const components = clone(node.components ?? []).map((c) => ({ id: c.id, type: c.type, props: c.props ?? {} }));
    const row: FragmentRow = {
      id: node.id,
      name: typeof node.name === 'string' ? node.name : node.id,
      parent: nested ? parent : null,
      children: [],
      transform: derivedTransform(components),
      components,
      visible: node.visible !== false,
      locked: node.locked === true,
      ...(node.solo ? { solo: true } : {}),
      ...(node.shy ? { shy: true } : {}),
      ...(node.color ? { color: node.color } : {}),
    };
    this.rows.set(row.id, row);
    if (nested) this.rows.get(parent)!.children.push(row.id);
    else this.tops.push(row.id);
    return row.id;
  }

  /** Add a layer from its parts (components get `<id>_<n>` ids when theirs are empty). Returns its id. */
  layer(init: LayerInit): string {
    const id = init.id ?? this.newId();
    const components = init.components.map((c, i) => ({ id: c.id || `${id}_c${i}`, type: c.type, props: c.props }));
    const t = components.find((c) => c.type === 'Transform')?.props;
    const x = init.x ?? (finite(t?.x) ? t.x : 0);
    const y = init.y ?? (finite(t?.y) ? t.y : 0);
    return this.addChild(init.parent ?? null, {
      id,
      name: init.name,
      transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
      components,
      visible: init.visible !== false,
      locked: init.locked === true,
    });
  }

  /**
   * Move `id` under `parent` (a layer of this builder; null = top level), IN
   * FRONT of that parent's current children (SceneGraph `setParent` appends).
   * Local transforms are kept as they are (no world compensation).
   */
  reparent(id: string, parent: string | null): void {
    const row = this.row(id);
    if (parent !== null && !this.rows.has(parent)) throw new Error(`fragment: no layer '${parent}' to parent under`);
    for (let p: string | null = parent; p !== null; p = this.rows.get(p)?.parent ?? null) {
      if (p === id) throw new Error(`fragment: parenting '${id}' under '${parent}' would make a cycle`);
    }
    if (row.parent !== null) {
      const old = this.rows.get(row.parent)!;
      old.children = old.children.filter((c) => c !== id);
    } else {
      this.tops = this.tops.filter((c) => c !== id);
    }
    row.parent = parent;
    if (parent !== null) this.rows.get(parent)!.children.push(id);
    else this.tops.push(id);
  }

  // ── components ──────────────────────────────────────────────────────

  /** The first component of `type` on a layer, or undefined. */
  component(id: string, type: string): FragmentComponent | undefined {
    return this.row(id).components.find((c) => c.type === type);
  }

  /** Write `key` on the layer's first component of `type`; false when it has none. `undefined` deletes. */
  setProp(id: string, type: string, key: string, value: unknown): boolean {
    const c = this.component(id, type);
    if (!c) return false;
    if (value === undefined) delete c.props[key];
    else c.props[key] = clone(value);
    return true;
  }

  /** SceneGraph's `writeProp`: `key` on the layer's component with id `componentId`; false when there is none. */
  writeProp(id: string, componentId: string, key: string, value: unknown): boolean {
    const c = this.row(id).components.find((x) => x.id === componentId);
    if (!c) return false;
    c.props[key] = clone(value);
    return true;
  }

  /**
   * Write `key` on the layer's `fx` component, created on demand (id
   * `<layer>_fx`, appended) — SceneGraph `setFx`: fill, fills, stroke, strokes,
   * matte, pathOps, continuousRasterize, … `undefined` deletes the key.
   */
  setFx(id: string, key: string, value: unknown): void {
    let fx = this.component(id, 'fx');
    if (!fx) {
      if (value === undefined) return;
      fx = { id: `${id}_fx`, type: 'fx', props: {} };
      this.row(id).components.push(fx);
    }
    if (value === undefined) delete fx.props[key];
    else fx.props[key] = clone(value);
  }

  /** SceneGraph's spelling of {@link setFx} (`setFxKey`), so a builder written against a {@link LayerSink} lays into either. */
  setFxKey(id: string, key: string, value: unknown): void {
    this.setFx(id, key, value);
  }

  // ── animation ───────────────────────────────────────────────────────

  private anim(id: string): AnimState {
    this.row(id);
    let a = this.anims.get(id);
    if (!a) {
      a = { tracks: new Map(), expressions: new Map(), data: new Map() };
      this.anims.set(id, a);
    }
    return a;
  }

  /**
   * One keyframe (AnimationEngine.setKeyframe): a key already at `t` keeps its
   * other fields and takes the new value (and easing, when given). Keys stay
   * sorted by time. Non-finite times / values are ignored.
   */
  setKeyframe(id: string, prop: string, t: number, value: number, easing?: string): void {
    if (!finite(t) || !finite(value)) return;
    const a = this.anim(id);
    const list = a.tracks.get(prop) ?? [];
    const at = list.findIndex((k) => k.t === t);
    if (at >= 0) {
      const prev = list[at]!;
      list[at] = { ...prev, value, ...(easing !== undefined ? { easing } : {}) };
    } else {
      list.push(easing !== undefined ? { t, value, easing } : { t, value });
      list.sort((x, y) => x.t - y.t);
    }
    a.tracks.set(prop, list);
  }

  /**
   * A whole track (AnimationEngine.setKeyframes): de-duplicated by time (last
   * wins), sorted. An empty list removes the track. Keys with a non-finite
   * time or value are dropped.
   */
  setKeyframes(id: string, prop: string, keyframes: readonly FragmentKeyframe[]): void {
    const a = this.anim(id);
    const byTime = new Map<number, FragmentKeyframe>();
    for (const k of keyframes) if (finite(k.t) && finite(k.value)) byTime.set(k.t, clone(k));
    const sorted = [...byTime.values()].sort((x, y) => x.t - y.t);
    if (sorted.length === 0) a.tracks.delete(prop);
    else a.tracks.set(prop, sorted);
  }

  /** A data track (AnimationEngine.setDataTrack), e.g. `path.points` of kind `points`. Empty removes it. */
  setDataTrack(id: string, prop: string, kind: string, keyframes: readonly FragmentDataKeyframe[]): void {
    const a = this.anim(id);
    const keys = clone(keyframes.filter((k) => finite(k.t))).sort((x, y) => x.t - y.t);
    if (keys.length === 0) a.data.delete(prop);
    else a.data.set(prop, { nodeId: id, prop, kind, keyframes: keys });
  }

  /**
   * One data keyframe (AnimationEngine.setDataKeyframe): appended to the
   * layer's `prop` track of `kind` (created on demand); a key already at `t`
   * is replaced. Keys stay sorted by time.
   */
  setDataKeyframe(id: string, prop: string, kind: string, t: number, value: unknown, easing?: string): void {
    if (!finite(t)) return;
    const a = this.anim(id);
    const track = a.data.get(prop) ?? { nodeId: id, prop, kind, keyframes: [] };
    const key: FragmentDataKeyframe = { t, value: clone(value), ...(easing ? { easing } : {}) };
    const at = track.keyframes.findIndex((k) => k.t === t);
    if (at >= 0) track.keyframes[at] = key;
    else {
      track.keyframes.push(key);
      track.keyframes.sort((x, y) => x.t - y.t);
    }
    a.data.set(prop, track);
  }

  /** An expression on a property (empty source removes it). */
  setExpression(id: string, prop: string, src: string, enabled = true): void {
    const a = this.anim(id);
    if (src.trim() === '') a.expressions.delete(prop);
    else a.expressions.set(prop, { src, enabled });
  }

  /** A keyframe setter for choreographies written against (id, prop, seconds, value, ease). */
  keyframeSetter(defaultEase = 'easeInOut'): KeyframeSetter {
    return (id, prop, timeSec, value, ease) => this.setKeyframe(id, prop, timeSec, value, ease ?? defaultEase);
  }

  // ── timeline ────────────────────────────────────────────────────────

  /** The layer's timeline bars, in frames of the target comp (none = the engine's default bar). */
  setBars(id: string, bars: readonly FragmentBar[]): void {
    this.row(id);
    const ok = bars.filter((b) => finite(b.start) && finite(b.duration) && finite(b.sourceIn));
    if (ok.length === 0) this.bars.delete(id);
    else this.bars.set(id, ok.map((b) => ({ start: b.start, duration: Math.max(0, b.duration), sourceIn: b.sourceIn, sourceDuration: finite(b.sourceDuration) ? b.sourceDuration : null })));
  }

  // ── output ──────────────────────────────────────────────────────────

  private snapshot(id: string): FragmentAnim | null {
    const a = this.anims.get(id);
    if (!a || (a.tracks.size === 0 && a.expressions.size === 0 && a.data.size === 0)) return null;
    const tracks: Record<string, FragmentKeyframe[]> = {};
    for (const [prop, keys] of a.tracks) tracks[prop] = clone(keys);
    const expressions: Record<string, FragmentExpression> = {};
    for (const [prop, e] of a.expressions) expressions[prop] = { ...e };
    const data: Record<string, FragmentDataTrack> = {};
    for (const [prop, t] of a.data) data[prop] = clone(t);
    return { tracks, expressions, data };
  }

  /** The fragment, or null when nothing was built. */
  build(): BuiltFragment | null {
    if (this.rows.size === 0) return null;
    const layers: FragmentLayer[] = [];
    const visit = (id: string): void => {
      const row = this.rows.get(id)!;
      layers.push({ row: clone(row), anim: this.snapshot(id), bars: clone(this.bars.get(id) ?? []) });
      for (let i = row.children.length - 1; i >= 0; i--) visit(row.children[i]!);
    };
    const tops = [...this.tops].reverse();
    for (const id of tops) visit(id);
    return {
      fragment: encodeFragmentLayers(layers),
      layers,
      scratchIds: layers.map((l) => l.row.id),
      tops,
    };
  }
}
