/**
 * Structurally shared scene + animation snapshots for undo history.
 *
 * ## What this replaces
 *
 * Every history record used to take `structuredClone(sceneProjectIO.capture())`
 * — itself a JSON round trip of every node — and decide "did anything change?"
 * by `JSON.stringify`-ing the whole previous state AND the whole new one. The
 * booted app then captured a SECOND full copy from the `UndoStackChanged`
 * baseline sync. On a 2000-layer document that was ~15 MB retained per entry:
 * the 500-entry history ran a 4 GB heap out of memory.
 *
 * ## The design, and why it is the low-risk one
 *
 * A snapshot is still a plain, complete `{ scene, anim }` value — nothing that
 * reads one (restore, the AI transaction's rollback, the bake commit) sees a
 * diff, a patch or a lazy view. What changed is only that two snapshots now
 * SHARE the node objects and animation tracks whose content is identical:
 *
 *   • a node is serialised once per capture (the same JSON the old capture's
 *     round trip produced) and compared, as a string, with the last captured
 *     version of that node id. Equal ⇒ the previous immutable object is reused;
 *     different ⇒ it is parsed into a fresh one. No revision counter is trusted
 *     to say "unchanged": the scene has write paths that bump none of them
 *     (`setLocalTransform`, `custom.childIds`, a nested `props` array written in
 *     place), and a missed change here is a lost undo step. The comparison is
 *     against real content, so the cache can only ever cost sharing, never
 *     correctness.
 *   • an animation track / expression / data track is reused when it is
 *     structurally identical to the previous capture's (strict: `Object.is`
 *     leaves, same keys in the same order), and deep-copied otherwise, so a
 *     stored track never aliases the live engine's nested arrays.
 *   • `statesEqual` keeps the old `JSON.stringify(a) === JSON.stringify(b)`
 *     semantics EXACTLY — same answers for NaN, -0, undefined, key order,
 *     `toJSON` — but short-circuits on shared objects, so it walks only what
 *     changed. History granularity therefore cannot move.
 *
 * ## The invariant this relies on
 *
 * Snapshot objects are IMMUTABLE once captured. Nothing may write into a
 * snapshot, and nothing may hand a snapshot's objects to a live store: every
 * restore goes through {@link cloneStateForRestore} (or clones itself, as
 * `compositeEdit` does). That was already true of the old full copies — a
 * restore that handed its snapshot to the scene graph would have let the next
 * edit rewrite history — it simply matters for more entries at once now.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import type { ProjectFile, SceneNode } from '@core/types';

export interface DocState {
  scene: ProjectFile;
  anim: AnimSnapshot;
}

// ── JSON-equality without building the strings ───────────────────────────

/** A primitive's JSON token (tagged so `"null"` ≠ `null`), or null for objects. */
function primToken(v: unknown): string | null {
  if (v === null) return 'n';
  switch (typeof v) {
    case 'string': return `s${v}`;
    case 'number': return Number.isFinite(v) ? `d${v}` : 'n';
    case 'boolean': return v ? 't' : 'f';
    case 'undefined':
    case 'function':
    case 'symbol': return 'u';
    case 'bigint': throw new TypeError('BigInt value can not be serialized in JSON');
    default: return null;
  }
}

/** What `JSON.stringify` actually serialises for `v` under `key`: `toJSON`, then unboxing. */
function jsonView(v: unknown, key: string): unknown {
  if (v !== null && typeof v === 'object') {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') v = (toJSON as (k: string) => unknown).call(v, key);
    if (v instanceof Number) return Number(v);
    if (v instanceof String) return String(v);
    if (v instanceof Boolean) return v.valueOf();
  } else if (typeof v === 'bigint') {
    const toJSON = (BigInt.prototype as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return (toJSON as (k: string) => unknown).call(v, key);
  }
  return v;
}

function hasToJSON(v: object): boolean {
  return typeof (v as { toJSON?: unknown }).toJSON === 'function';
}

function jeq(a: unknown, b: unknown, key: string, inArray: boolean): boolean {
  // Identity: the same object serialises to the same string. This is what makes
  // the comparison proportional to what CHANGED between two shared snapshots.
  if (a === b && a !== null && typeof a === 'object' && !hasToJSON(a)) return true;
  a = jsonView(a, key);
  b = jsonView(b, key);
  let ta = primToken(a);
  let tb = primToken(b);
  if (inArray) {
    if (ta === 'u') ta = 'n';
    if (tb === 'u') tb = 'n';
  }
  if (ta !== null || tb !== null) return ta === tb;
  if (a === b) return true;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (!jeq(x[i], y[i], String(i), true)) return false;
    }
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const kx = serialisedKeys(x);
  const ky = serialisedKeys(y);
  if (kx.length !== ky.length) return false;
  for (let i = 0; i < kx.length; i++) {
    const k = kx[i]!;
    if (k !== ky[i]) return false;
    if (!jeq(x[k], y[k], k, false)) return false;
  }
  return true;
}

/** The keys `JSON.stringify` writes for an object, in its order. */
function serialisedKeys(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(o)) {
    if (primToken(jsonView(o[k], k)) !== 'u') out.push(k);
  }
  return out;
}

/**
 * `JSON.stringify(a) === JSON.stringify(b)`, computed without either string.
 *
 * Throws where `JSON.stringify` would (BigInt; a cycle surfaces as a
 * RangeError), so callers that caught before keep catching.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return jeq(a, b, '', false);
}

/**
 * The old history equality — whole-state JSON equality — with the same answer
 * for every input, including a state that cannot be serialised (not equal).
 */
export function statesEqual(a: DocState | null, b: DocState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return jsonEqual(a, b);
  } catch {
    return false;
  }
}

// ── Strict structural identity (decides REUSE, never equality) ────────────

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const pa = Object.getPrototypeOf(a) as unknown;
  if ((pa !== Object.prototype && pa !== null) || Object.getPrototypeOf(b) !== pa) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i]!;
    if (k !== kb[i]) return false;
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** A deep copy that keeps undefined / NaN / -0 exactly; falls back to the value itself. */
function deepCopy<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
}

// ── Scene ─────────────────────────────────────────────────────────────────

/** Invariant: `json === JSON.stringify(node)` (computed lazily for seeded entries). */
interface CachedNode {
  node: SceneNode;
  json: string | null;
}

/** The last captured / restored version of each node id. */
let nodeCache = new Map<string, CachedNode>();
let animCache: AnimSnapshot | null = null;
/** States whose parts already went through this module. */
const sharedStates = new WeakSet<object>();

function cachedJson(c: CachedNode): string {
  if (c.json === null) c.json = JSON.stringify(c.node);
  return c.json;
}

/**
 * The node row `sceneProjectIO.capture` writes, field for field and in its key
 * order — `snapshotSharing.test.ts` pins the two against each other so a field
 * added there and not here fails a test rather than silently dropping out of
 * undo.
 */
function rowOf(n: SceneNode): Record<string, unknown> {
  return {
    id: n.id,
    name: n.name,
    children: n.children,
    parent: n.parent,
    transform: n.transform,
    components: n.components,
    visible: n.visible,
    locked: n.locked,
    solo: n.solo,
    ...(n.shy ? { shy: true } : {}),
    ...(n.color !== undefined ? { color: n.color } : {}),
  };
}

/**
 * The captured node for a live view whose row serialised to `json`: objects
 * from the parse (the old capture's JSON round trip), primitives read directly
 * (as the old capture copied them).
 */
function materialize(live: SceneNode, json: string): SceneNode {
  const p = JSON.parse(json) as { transform: SceneNode['transform']; components: SceneNode['components'] };
  return {
    id: live.id,
    name: live.name,
    children: [...live.children],
    parent: live.parent,
    transform: p.transform,
    components: p.components,
    visible: live.visible,
    locked: live.locked,
    solo: live.solo,
    ...(live.shy ? { shy: true } : {}),
    ...(live.color !== undefined ? { color: live.color } : {}),
  };
}

/**
 * `structuredClone(sceneProjectIO.capture())`, sharing every node whose content
 * is unchanged since the last capture.
 */
export function captureSharedScene(): ProjectFile {
  const next = new Map<string, CachedNode>();
  const nodes: SceneNode[] = [];
  defaultSceneGraph.traverse((n) => {
    const json = JSON.stringify(rowOf(n));
    const prev = nodeCache.get(n.id);
    const node = prev && cachedJson(prev) === json ? prev.node : materialize(n, json);
    next.set(n.id, { node, json });
    nodes.push(node);
  });
  // Only live ids survive, so a deleted layer's last version is held by the
  // history entries that need it and by nothing else.
  nodeCache = next;
  return { version: '1.0.0', nodes };
}

function internNode(node: SceneNode): SceneNode {
  if (!node || typeof node !== 'object' || typeof node.id !== 'string') return node;
  const json = JSON.stringify(node);
  const prev = nodeCache.get(node.id);
  if (prev && cachedJson(prev) === json) return prev.node;
  // Our own copy: the caller keeps its object and may do anything with it.
  const own = deepCopy(node);
  nodeCache.set(node.id, { node: own, json });
  return own;
}

function internScene(scene: ProjectFile): ProjectFile {
  if (!scene || !Array.isArray(scene.nodes)) return scene;
  return { ...scene, nodes: scene.nodes.map(internNode) };
}

// ── Animation ─────────────────────────────────────────────────────────────

const ANIM_SECTIONS = new Set(['tracks', 'expressions', 'data']);

type Section = Record<string, Record<string, unknown> | undefined>;

function shareSection(cur: Section | undefined, prev: Section | undefined): Section | undefined {
  if (!cur || typeof cur !== 'object') return cur;
  const out: Section = {};
  for (const nodeId of Object.keys(cur)) {
    const byProp = cur[nodeId];
    if (!byProp || typeof byProp !== 'object') {
      out[nodeId] = byProp;
      continue;
    }
    const prevByProp = prev?.[nodeId];
    const o: Record<string, unknown> = {};
    for (const prop of Object.keys(byProp)) {
      const c = byProp[prop];
      const p = prevByProp?.[prop];
      o[prop] = p !== undefined && sameValue(p, c) ? p : deepCopy(c);
    }
    out[nodeId] = o;
  }
  return out;
}

/** `anim`, rebuilt so every track identical to the last capture's IS that track. */
function shareAnim(anim: AnimSnapshot): AnimSnapshot {
  if (!anim || typeof anim !== 'object') return anim;
  const prev = animCache as unknown as Record<string, Section | undefined> | null;
  const src = anim as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    out[k] = ANIM_SECTIONS.has(k) ? shareSection(src[k] as Section | undefined, prev?.[k]) : src[k];
  }
  const shared = out as unknown as AnimSnapshot;
  animCache = shared;
  return shared;
}

// ── Public surface ────────────────────────────────────────────────────────

/** Capture the editable state (scene + animation) with structural sharing. */
export function captureSharedState(): DocState {
  const state = { scene: captureSharedScene(), anim: shareAnim(defaultAnimation.snapshot()) };
  sharedStates.add(state);
  return state;
}

/**
 * Re-express a state built elsewhere (the AI transaction, the dynamics bake —
 * both still take their own full copy) in shared form. Content is unchanged;
 * the returned object is new and the argument is never written.
 */
export function internState(state: DocState): DocState {
  if (!state || sharedStates.has(state)) return state;
  const shared = { scene: internScene(state.scene), anim: shareAnim(state.anim) };
  sharedStates.add(shared);
  return shared;
}

/** {@link internState} for a whole editor document: its scene and animation parts. */
export function internDocumentParts<T extends { scene: ProjectFile; animation: AnimSnapshot }>(doc: T): T {
  if (!doc || typeof doc !== 'object') return doc;
  return {
    ...doc,
    ...(doc.scene ? { scene: internScene(doc.scene) } : {}),
    ...(doc.animation ? { animation: shareAnim(doc.animation) } : {}),
  };
}

/**
 * A private deep copy to hand to the live stores. `sceneProjectIO.restore` and
 * `AnimationEngine.restore` both keep nested objects they are given (and the
 * scene restore rewrites legacy mattes in place), so a snapshot must never be
 * passed to them directly.
 */
export function cloneStateForRestore(state: DocState): DocState {
  return { scene: structuredClone(state.scene), anim: deepCopy(state.anim) };
}

/**
 * Tell the cache the live document now matches `state` (after an undo, redo or
 * jump), so the next capture shares with it instead of re-parsing every node.
 * Purely an optimisation: the next capture still compares real content.
 */
export function noteRestoredState(scene: ProjectFile | undefined, anim: AnimSnapshot | undefined): void {
  if (scene && Array.isArray(scene.nodes)) {
    const next = new Map<string, CachedNode>();
    for (const node of scene.nodes) {
      if (node && typeof node.id === 'string') next.set(node.id, { node, json: null });
    }
    nodeCache = next;
  }
  if (anim) animCache = anim;
}

/** Drop the sharing caches. Tests only — correctness never depends on them. */
export function resetSnapshotSharing(): void {
  nodeCache = new Map();
  animCache = null;
}
