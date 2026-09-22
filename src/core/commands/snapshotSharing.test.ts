/**
 * Structurally shared history snapshots — equivalence against the old
 * implementation, used as the oracle.
 *
 * The old history took `structuredClone(sceneProjectIO.capture())` +
 * `defaultAnimation.snapshot()` per record and compared whole states with
 * `JSON.stringify`. Both are reproduced VERBATIM below (`legacyCapture`,
 * `legacyEqual`), and every claim the new mechanism makes is checked against
 * them rather than against itself:
 *
 *   • `jsonEqual` answers exactly what the two strings would, on thousands of
 *     random values built to hit the edge cases (NaN, -0, undefined in objects
 *     and arrays, `toJSON`, key order, shared sub-objects);
 *   • a shared capture is deep-equal to the old capture, field for field;
 *   • random edit sequences through the REAL store (record / undo / redo /
 *     jump, `runDocumentEdit`) push an entry exactly when the old equality says
 *     they should, every undo and redo lands on the state the oracle recorded,
 *     undo-all returns the opening document and redo-all the final one;
 *   • nothing restored aliases a snapshot: editing the live document after an
 *     undo — including writes into nested arrays in place — never changes what
 *     a later undo or redo restores.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { CommandSystem, getCommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { EventBus, setEventBus } from '@core/events/EventBus';
import {
  attachHistoryRecording,
  baselineHistory,
  performJumpTo,
  performRedo,
  performUndo,
  StoreSnapshotCommand,
  useHistoryStore,
} from '@stores/historyStore';
import { runDocumentEdit } from './documentEdit';
import {
  captureSharedScene,
  captureSharedState,
  cloneStateForRestore,
  internState,
  jsonEqual,
  noteRestoredState,
  registerClipGeometryProvider,
  resetSnapshotSharing,
  statesEqual,
  type ClipGeometry,
  type ClipGeometryProvider,
  type ClipsByComp,
} from './snapshotSharing';
import { setUnifiedHistory } from '@core/config/flags';
import type { SceneNode } from '@core/types';

jest.useFakeTimers();

// ── The oracle: the pre-sharing implementation, verbatim ──────────────────

function legacyCapture(): { scene: ReturnType<typeof sceneProjectIO.capture>; anim: ReturnType<typeof defaultAnimation.snapshot> } {
  return { scene: structuredClone(sceneProjectIO.capture()), anim: defaultAnimation.snapshot() };
}

function legacyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

const docJson = (): string => JSON.stringify(legacyCapture());

// ── Deterministic randomness ──────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, n: number): number => Math.floor(r() * n);
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[int(r, xs.length)]!;

// ── jsonEqual vs the strings ──────────────────────────────────────────────

const FIXED_DATE = new Date(Date.UTC(2026, 0, 2));

function randValue(r: () => number, depth: number): unknown {
  const k = int(r, depth > 3 ? 11 : 14);
  switch (k) {
    case 0: return null;
    case 1: return undefined;
    case 2: return NaN;
    case 3: return pick(r, [Infinity, -Infinity]);
    case 4: return pick(r, [0, -0]);
    case 5: return int(r, 5);
    case 6: return pick(r, [0.1 + 0.2, 1e21, 1 / 3]);
    case 7: return pick(r, ['', 'a', 'null', '0', 'b"c']);
    case 8: return r() < 0.5;
    case 9: return pick(r, [FIXED_DATE, () => 1, Symbol.iterator]);
    case 10: return pick(r, [{ toJSON: () => 'x' }, { toJSON: () => undefined }]);
    case 11: return Array.from({ length: int(r, 4) }, () => randValue(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = int(r, 4); i > 0; i--) o[pick(r, ['a', 'b', 'c', 'd'])] = randValue(r, depth + 1);
      return o;
    }
  }
}

function copy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(copy);
  if (v instanceof Date) return new Date(v.getTime());
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && !('toJSON' in v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = copy((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

/** A copy with one random change: a leaf, a key order, a key's presence — or none. */
function perturb(r: () => number, v: unknown): unknown {
  const c = copy(v);
  const holders: Array<Record<string, unknown> | unknown[]> = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { holders.push(x); x.forEach(walk); }
    else if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      holders.push(x as Record<string, unknown>);
      Object.values(x).forEach(walk);
    }
  };
  walk(c);
  if (holders.length === 0 || r() < 0.2) return r() < 0.5 ? c : randValue(r, 0);
  const h = pick(r, holders);
  if (Array.isArray(h)) {
    if (h.length && r() < 0.7) h[int(r, h.length)] = randValue(r, 3);
    else h.push(randValue(r, 3));
  } else {
    const keys = Object.keys(h);
    const op = int(r, 3);
    if (op === 0 && keys.length > 1) {
      // Same content, different key order.
      const entries = keys.map((key) => [key, h[key]] as const).reverse();
      for (const key of keys) delete h[key];
      for (const [key, val] of entries) h[key] = val;
    } else if (op === 1 && keys.length) {
      delete h[pick(r, keys)];
    } else {
      h[pick(r, ['a', 'b', 'e'])] = randValue(r, 3);
    }
  }
  return c;
}

describe('jsonEqual', () => {
  it('agrees with JSON.stringify string equality on random values', () => {
    const r = rng(7);
    let equalPairs = 0;
    for (let i = 0; i < 6000; i++) {
      const a = randValue(r, 0);
      const b = perturb(r, a);
      const want = JSON.stringify(a) === JSON.stringify(b);
      if (want) equalPairs++;
      expect({ i, a: JSON.stringify(a), b: JSON.stringify(b), eq: jsonEqual(a, b) })
        .toEqual({ i, a: JSON.stringify(a), b: JSON.stringify(b), eq: want });
    }
    // Both answers must be well represented, or the agreement is vacuous.
    expect(equalPairs).toBeGreaterThan(600);
    expect(equalPairs).toBeLessThan(5400);
  });

  it('treats a shared sub-object as equal without walking it, and still sees siblings', () => {
    const shared = { big: Array.from({ length: 1000 }, (_, i) => ({ i })) };
    expect(jsonEqual({ x: shared, y: 1 }, { x: shared, y: 1 })).toBe(true);
    expect(jsonEqual({ x: shared, y: 1 }, { x: shared, y: 2 })).toBe(false);
  });

  it('pins the edge cases by name', () => {
    expect(jsonEqual({ a: undefined }, {})).toBe(true);
    expect(jsonEqual([undefined], [null])).toBe(true);
    expect(jsonEqual(NaN, null)).toBe(true);
    expect(jsonEqual(-0, 0)).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false); // key order is content to the old check
    expect(jsonEqual('null', null)).toBe(false);
    expect(jsonEqual(FIXED_DATE, FIXED_DATE.toISOString())).toBe(true);
    expect(() => jsonEqual({ a: BigInt(1) }, { a: BigInt(1) })).toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(statesEqual(cyc as never, { self: {} } as never)).toBe(false);
  });
});

// ── A document with every kind of authored state history carries ─────────

function layer(id: string, parent: string, i: number): SceneNode {
  return {
    id, name: `Layer ${id}`, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: i * 10, y: i, rotation: 0, width: 50, height: 40 } },
      { id: `${id}_s`, type: 'Style', props: { fill: '#112233', opacity: 100 } },
      { id: `${id}_g`, type: 'Geometry', props: { points: [{ x: 0, y: 0 }, { x: 10, y: 5, inX: 1, outX: -1 }], open: false } },
      { id: `${id}_fx`, type: 'fx', props: { effects: [{ type: 'blur', radius: i }], paint: { strokes: [{ id: 's', points: [[1, 2], [3, 4]] }] } } },
    ],
  } as unknown as SceneNode;
}

function clearWorld(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
}

let nextId = 0;
function seedWorld(layers: number): void {
  clearWorld();
  defaultSceneGraph.addNode({
    id: 'root', name: 'Composition 1', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  for (let i = 0; i < layers; i++) {
    defaultSceneGraph.addChild('root', layer(`n${i}`, 'root', i));
    defaultAnimation.setKeyframes(`n${i}`, 'x', [
      { t: 0, value: i, easing: 'bezier', bezier: [0.2, 0, 0.8, 1] },
      { t: 1, value: i + 5 },
    ] as never);
  }
  nextId = layers;
}

const layerIds = (): string[] => defaultSceneGraph.getChildOrder('root');

function freshHistory(): void {
  setEventBus(new EventBus());
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  resetSnapshotSharing();
}

describe('captureSharedScene', () => {
  beforeEach(() => {
    freshHistory();
    seedWorld(6);
  });

  it('is deep-equal to the old capture, field for field', () => {
    const n = defaultSceneGraph.getNode('n1')!;
    n.color = '#ff00ff';
    n.solo = true;
    n.locked = true;
    const want = structuredClone(sceneProjectIO.capture());
    const got = captureSharedScene();
    expect(got).toEqual(want);
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
    // Key sets too, so an extra or missing field (even an undefined one) shows.
    expect(got.nodes.map((x) => Object.keys(x))).toEqual(want.nodes.map((x) => Object.keys(x)));
    // A second, cache-hit capture is still the same content.
    expect(captureSharedScene()).toEqual(want);
  });

  it('shares unchanged nodes and tracks by reference, and only those', () => {
    const a = captureSharedState();
    defaultSceneGraph.writeProp('n2', 'n2_s', 'fill', '#abcdef');
    defaultAnimation.setKeyframes('n3', 'x', [{ t: 0, value: 99 }] as never);
    const b = captureSharedState();
    const byId = (s: typeof a, id: string): SceneNode => s.scene.nodes.find((x) => x.id === id)!;
    expect(byId(b, 'n1')).toBe(byId(a, 'n1'));
    expect(byId(b, 'n2')).not.toBe(byId(a, 'n2'));
    expect(b.anim.tracks.n1!.x).toBe(a.anim.tracks.n1!.x);
    expect(b.anim.tracks.n3!.x).not.toBe(a.anim.tracks.n3!.x);
    expect(statesEqual(a, b)).toBe(false);
    expect(statesEqual(b, captureSharedState())).toBe(true);
  });

  it('a snapshot does not alias the live document, including nested arrays written in place', () => {
    const snap = captureSharedState();
    const frozen = JSON.stringify(snap);
    // `components` is a copy but its nested props are the engine's own objects:
    // a caller pushing into one mutates the live document with no epoch bump.
    const fx = defaultSceneGraph.getNode('n0')!.components.find((c) => c.type === 'fx')!;
    (fx.props.effects as unknown[]).push({ type: 'glow' });
    ((fx.props.paint as { strokes: Array<{ points: number[][] }> }).strokes[0]!.points[0]![0]) = 777;
    const live = defaultAnimation.getTrackKeyframes('n0', 'x')!;
    (live[0] as { bezier: number[] }).bezier[0] = 0.9;
    expect(JSON.stringify(snap)).toBe(frozen);
    // …and the in-place change IS seen as a change by the next capture.
    expect(statesEqual(snap, captureSharedState())).toBe(false);
  });
});

// ── Random edit sequences through the real store ──────────────────────────

type Edit = (r: () => number) => void;

const EDITS: Edit[] = [
  (r) => { const id = pick(r, layerIds()); if (id) defaultSceneGraph.setLocalTransform(id, { x: int(r, 4) * 10, y: 3, rotation: 0 }); },
  (r) => { const id = pick(r, layerIds()); if (id) defaultSceneGraph.writeProp(id, `${id}_s`, 'fill', pick(r, ['#112233', '#ff0000', '#00ff00'])); },
  (r) => { const id = pick(r, layerIds()); if (id) defaultSceneGraph.setMask(id, r() < 0.3 ? undefined : { mode: 'add', path: [{ x: int(r, 3), y: 1 }] }); },
  (r) => { const id = pick(r, layerIds()); if (id) defaultSceneGraph.setPaint(id, { strokes: [{ id: 'p', points: [[int(r, 3), 1]] }] }); },
  (r) => { const id = pick(r, layerIds()); if (id) defaultSceneGraph.setPathOps(id, [{ kind: pick(r, ['offset', 'merge']), amount: int(r, 3) }]); },
  (r) => {
    // In-place nested write, the path no revision counter sees.
    const id = pick(r, layerIds());
    const fx = id ? defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'fx') : undefined;
    const effects = fx?.props.effects as unknown[] | undefined;
    if (effects) effects.push({ type: 'blur', radius: int(r, 4) });
  },
  () => { const id = `n${nextId++}`; defaultSceneGraph.addChild('root', layer(id, 'root', nextId)); },
  (r) => { const ids = layerIds(); if (ids.length > 2) { const id = pick(r, ids); defaultSceneGraph.removeNode(id); defaultAnimation.clearNode(id); } },
  (r) => { const ids = layerIds(); defaultSceneGraph.setChildOrder('root', [...ids].sort(() => r() - 0.5)); },
  (r) => { const n = defaultSceneGraph.getNode(pick(r, layerIds())); if (n) n.name = pick(r, ['A', 'B', 'Layer']); },
  (r) => { const n = defaultSceneGraph.getNode(pick(r, layerIds())); if (n) n.color = r() < 0.5 ? undefined : '#123456'; },
  (r) => { const n = defaultSceneGraph.getNode(pick(r, layerIds())); if (n) { n.solo = r() < 0.5; n.visible = r() < 0.7; } },
  (r) => {
    // Same props, different key order — a change to the old JSON check.
    const id = pick(r, layerIds());
    if (id) defaultSceneGraph.addComponent(id, { id: `${id}_s`, type: 'Style', props: r() < 0.5 ? { opacity: 100, fill: '#112233' } : { fill: '#112233', opacity: 100 } });
  },
  (r) => {
    const id = pick(r, layerIds());
    if (id) defaultAnimation.setKeyframes(id, pick(r, ['x', 'opacity']), [
      { t: 0, value: int(r, 3), easing: pick(r, ['linear', 'bezier']), bezier: [0.3, 0, 0.7, 1] },
      { t: 2, value: int(r, 3) },
    ] as never);
  },
  (r) => { const id = pick(r, layerIds()); if (id) defaultAnimation.removeTrack(id, 'x'); },
  (r) => { const id = pick(r, layerIds()); if (id) defaultAnimation.setExpression(id, 'rotation', pick(r, ['time * 10', 'wiggle(1, 2)'])); },
  (r) => { const id = pick(r, layerIds()); if (id && defaultAnimation.hasExpression(id, 'rotation')) defaultAnimation.setExpressionEnabled(id, 'rotation', r() < 0.5); },
  (r) => {
    const id = pick(r, layerIds());
    if (id) defaultAnimation.setDataTrack(id, 'text', r() < 0.2 ? null : {
      nodeId: id, prop: 'text', kind: 'points',
      keyframes: [{ t: 0, value: [{ x: int(r, 3), y: 1 }] }, { t: 1, value: [{ x: 5, y: 5 }] }],
    } as never);
  },
  // No-ops: must never produce an entry.
  (r) => { const id = pick(r, layerIds()); if (id) defaultSceneGraph.writeProp(id, `${id}_t`, 'width', 50); },
  () => { /* nothing */ },
];

interface Model {
  /** Oracle JSON of every state the history can reach, oldest first. */
  states: string[];
  /** Structured oracle captures, for the undefined-sensitive final comparison. */
  structured: unknown[];
  index: number;
  last: ReturnType<typeof legacyCapture>;
}

function entries(): number {
  return getCommandSystem().getHistory().getEntries().length;
}

/** Undo-stack depth. "Entries added" is measured here, not on `entries()`:
 *  a push after an undo also discards the redo tail. */
function undoDepth(): number {
  return getCommandSystem().getHistory().getIndex() + 1;
}

function runSequence(seed: number, steps: number): void {
  freshHistory();
  const rec = attachHistoryRecording();
  seedWorld(5);
  baselineHistory('Open');
  const r = rng(seed);
  const m: Model = { states: [docJson()], structured: [legacyCapture()], index: 0, last: legacyCapture() };

  const pushState = (): void => {
    m.states = [...m.states.slice(0, m.index + 1), docJson()];
    m.structured = [...m.structured.slice(0, m.index + 1), legacyCapture()];
    m.index += 1;
  };

  try {
    for (let s = 0; s < steps; s++) {
      const roll = r();
      const ctx = `seed ${seed} step ${s}`;
      if (roll < 0.62) {
        pick(r, EDITS)(r);
        const cur = legacyCapture();
        const shouldPush = !legacyEqual(m.last, cur);
        const before = undoDepth();
        useHistoryStore.getState().record();
        expect({ ctx, added: undoDepth() - before }).toEqual({ ctx, added: shouldPush ? 1 : 0 });
        m.last = cur;
        if (shouldPush) pushState();
      } else if (roll < 0.72) {
        // One structural edit, one entry — the documentEdit path.
        const before = undoDepth();
        const pre = legacyCapture();
        let post: ReturnType<typeof legacyCapture> | null = null;
        runDocumentEdit('Doc edit', () => { pick(r, EDITS)(r); post = legacyCapture(); });
        const pushed = !legacyEqual(pre, post);
        expect({ ctx, added: undoDepth() - before }).toEqual({ ctx, added: pushed ? 1 : 0 });
        if (pushed) pushState();
        // Any pending debounce is flushed by the next undo; the baseline sync
        // has already moved to the post-edit state, so it records nothing.
        m.last = legacyCapture();
      } else if (roll < 0.86) {
        if (m.index > 0) {
          performUndo();
          m.index -= 1;
          expect({ ctx, op: 'undo', doc: docJson() }).toEqual({ ctx, op: 'undo', doc: m.states[m.index] });
          m.last = legacyCapture();
        }
      } else if (roll < 0.96) {
        if (m.index < m.states.length - 1) {
          performRedo();
          m.index += 1;
          expect({ ctx, op: 'redo', doc: docJson() }).toEqual({ ctx, op: 'redo', doc: m.states[m.index] });
          m.last = legacyCapture();
        }
      } else if (m.states.length > 1) {
        const to = int(r, m.states.length);
        performJumpTo(to);
        m.index = to;
        expect({ ctx, op: 'jump', doc: docJson() }).toEqual({ ctx, op: 'jump', doc: m.states[to] });
        m.last = legacyCapture();
      }
      expect(entries()).toBe(m.states.length);
    }

    // Undo everything → the opening document; redo everything → the final one.
    while (getCommandSystem().getHistory().canUndo() && getCommandSystem().getHistory().getIndex() > 0) performUndo();
    expect({ seed, doc: docJson() }).toEqual({ seed, doc: m.states[0] });
    expect(legacyCapture()).toEqual(m.structured[0]);
    while (getCommandSystem().getHistory().canRedo()) performRedo();
    expect({ seed, doc: docJson() }).toEqual({ seed, doc: m.states[m.states.length - 1] });
    expect(legacyCapture()).toEqual(m.structured[m.structured.length - 1]);
  } finally {
    rec.dispose();
  }
}

describe('random edit sequences match the old history exactly', () => {
  it.each(Array.from({ length: 24 }, (_, i) => i + 1))('seed %i', (seed) => {
    runSequence(seed * 101, 60);
  });

  it('POSITIVE CONTROL: the sequences exercise pushes, no-ops, undo and redo', () => {
    // Guard against a generator that decayed into all no-ops (every expectation
    // above would then hold trivially).
    freshHistory();
    seedWorld(5);
    baselineHistory('Open');
    const r = rng(4242);
    let pushed = 0;
    let skipped = 0;
    for (let i = 0; i < 80; i++) {
      pick(r, EDITS)(r);
      const before = undoDepth();
      useHistoryStore.getState().record();
      if (undoDepth() > before) pushed++;
      else skipped++;
    }
    expect(pushed).toBeGreaterThan(30);
    expect(skipped).toBeGreaterThan(3);
  });
});

describe('restored state never aliases history', () => {
  beforeEach(() => {
    freshHistory();
    seedWorld(4);
    baselineHistory('Open');
  });

  it('editing the live document after an undo does not change what redo and undo restore', () => {
    const open = docJson();
    defaultSceneGraph.writeProp('n1', 'n1_s', 'fill', '#ff0000');
    defaultAnimation.setKeyframes('n1', 'x', [{ t: 0, value: 5, easing: 'bezier', bezier: [0.1, 0.2, 0.3, 0.4] }] as never);
    useHistoryStore.getState().record('edit');
    const edited = docJson();

    performUndo();
    expect(docJson()).toBe(open);
    // Scribble over everything reachable from the restored live state, in place.
    const fx = defaultSceneGraph.getNode('n2')!.components.find((c) => c.type === 'fx')!;
    (fx.props.effects as unknown[]).push({ type: 'vandal' });
    const geo = defaultSceneGraph.getNode('n2')!.components.find((c) => c.type === 'Geometry')!;
    (geo.props.points as Array<{ x: number }>)[0]!.x = 12345;
    const kf = defaultAnimation.getTrackKeyframes('n2', 'x')!;
    (kf[0] as { bezier: number[] }).bezier[1] = 0.99;

    performRedo();
    expect(docJson()).toBe(edited);
    performUndo();
    expect(docJson()).toBe(open);
  });

  it('a command built from foreign full copies restores exactly and does not keep the caller objects live', () => {
    const before = legacyCapture();
    const beforeJson = JSON.stringify(before);
    defaultSceneGraph.setMask('n0', { mode: 'subtract', path: [{ x: 1, y: 2 }] });
    defaultAnimation.setExpression('n0', 'x', 'value * 2');
    const after = legacyCapture();
    const afterJson = JSON.stringify(after);
    const cmd = new StoreSnapshotCommand('AI', before, after);
    getCommandSystem().getHistory().push(cmd);

    // The caller mutating its own objects afterwards cannot reach the command's —
    // neither an unchanged node nor the one that changed (n0, not shareable).
    (before.scene.nodes[0]!.components as unknown[]).length = 0;
    const changed = after.scene.nodes.find((x) => x.id === 'n0')!;
    (changed.components as Array<{ props: Record<string, unknown> }>).forEach((c) => { c.props.poisoned = true; });
    (after.anim.expressions.n0!.x as { src: string }).src = 'poisoned';
    (after.anim as { tracks: Record<string, unknown> }).tracks = {};

    performUndo();
    expect(docJson()).toBe(beforeJson);
    performRedo();
    expect(docJson()).toBe(afterJson);
  });

  it('interning shares a foreign copy with the live capture without changing its content', () => {
    const live = captureSharedState();
    const foreign = legacyCapture();
    const interned = internState(foreign);
    expect(JSON.stringify(interned)).toBe(JSON.stringify(foreign));
    expect(interned.scene.nodes[1]).toBe(live.scene.nodes[1]);
    expect(interned.anim.tracks.n1!.x).toBe(live.anim.tracks.n1!.x);
  });
});

// ── Clip geometry (unified history) ───────────────────────────────────────

describe('clip geometry in the snapshot (unified history)', () => {
  const bar = (start: number, duration: number, sourceIn = 0, sourceDuration: number | null = null): ClipGeometry =>
    ({ start, duration, sourceIn, sourceDuration });

  /** What a fake timeline reports; each capture returns FRESH objects, as the real one does. */
  let live: ClipsByComp;
  let applied: ClipsByComp[];
  let previous: ClipGeometryProvider | null;
  const fresh = (): ClipsByComp => JSON.parse(JSON.stringify(live)) as ClipsByComp;

  beforeEach(() => {
    freshHistory();
    seedWorld(2);
    live = {
      main: { n0: [bar(0, 300)], n1: [bar(30, 170, 10, 500), bar(200, 100, 180, 500)] },
      pre: { n2: [bar(0, 60)] },
    };
    applied = [];
    previous = registerClipGeometryProvider({ capture: fresh, apply: (c) => { applied.push(c); } });
    setUnifiedHistory(true);
  });

  afterEach(() => {
    setUnifiedHistory(false);
    registerClipGeometryProvider(previous);
  });

  it('flag off: the snapshot has no clips key at all', () => {
    setUnifiedHistory(false);
    const s = captureSharedState();
    expect('clips' in s).toBe(false);
    expect(Object.keys(s)).toEqual(['scene', 'anim']);
  });

  it('flag on: the snapshot carries every comp, equal in content to the provider', () => {
    const s = captureSharedState();
    expect(s.clips).toEqual(live);
    expect(s.clips).not.toBe(live);
  });

  it('shares per node: an unchanged node keeps its array, a changed one gets a new one', () => {
    const a = captureSharedState();
    live.main!.n1 = [bar(40, 160, 20, 500), bar(200, 100, 180, 500)];
    const b = captureSharedState();
    expect(b.clips!.main!.n0).toBe(a.clips!.main!.n0);
    expect(b.clips!.main!.n1).not.toBe(a.clips!.main!.n1);
    expect(b.clips!.main!.n1).toEqual(live.main!.n1);
    // An untouched comp keeps its whole record.
    expect(b.clips!.pre).toBe(a.clips!.pre);
    // A touched comp gets a new record; the document gets a new clips object.
    expect(b.clips!.main).not.toBe(a.clips!.main);
    expect(b.clips).not.toBe(a.clips);
  });

  it('shares the whole clips object when nothing moved', () => {
    const a = captureSharedState();
    const b = captureSharedState();
    expect(b.clips).toBe(a.clips);
    expect(statesEqual(a, b)).toBe(true);
  });

  it('a removed or added bar, node or comp is a change', () => {
    const a = captureSharedState();
    live.main!.n1 = [live.main!.n1![0]!];
    const b = captureSharedState();
    expect(b.clips!.main!.n1).not.toBe(a.clips!.main!.n1);
    expect(statesEqual(a, b)).toBe(false);

    delete live.pre;
    const c = captureSharedState();
    expect(c.clips!.pre).toBeUndefined();
    expect(statesEqual(b, c)).toBe(false);

    live.main!.n9 = [bar(1, 1)];
    const d = captureSharedState();
    expect(statesEqual(c, d)).toBe(false);
    expect(d.clips!.main!.n0).toBe(a.clips!.main!.n0);
  });

  it('statesEqual: a pure clip change (scene and animation untouched) is a different state', () => {
    const a = captureSharedState();
    live.main!.n0 = [bar(12, 288)];
    const b = captureSharedState();
    expect(b.scene.nodes).toEqual(a.scene.nodes);
    expect(statesEqual(a, b)).toBe(false);
    // …and the same geometry on a later capture compares equal again.
    live.main!.n0 = [bar(0, 300)];
    expect(statesEqual(a, captureSharedState())).toBe(true);
  });

  it('a pure clip change records its own entry through the store', () => {
    baselineHistory('Open');
    const n = getCommandSystem().getHistory().getEntries().length;
    live.main!.n0 = [bar(12, 288)];
    useHistoryStore.getState().record();
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(n + 1);
    // Undo hands the entry's clips to the provider.
    performUndo();
    expect(applied.at(-1)!.main!.n0).toEqual([bar(0, 300)]);
    performRedo();
    expect(applied.at(-1)!.main!.n0).toEqual([bar(12, 288)]);
  });

  it('cloneStateForRestore deep-copies clips, so a restore never hands the snapshot to a live store', () => {
    const s = captureSharedState();
    const copy = cloneStateForRestore(s);
    expect(copy.clips).toEqual(s.clips);
    expect(copy.clips).not.toBe(s.clips);
    expect(copy.clips!.main).not.toBe(s.clips!.main);
    expect(copy.clips!.main!.n1).not.toBe(s.clips!.main!.n1);
    expect(copy.clips!.main!.n1![0]).not.toBe(s.clips!.main!.n1![0]);
    // Flag off, no clips: no key is invented.
    expect('clips' in cloneStateForRestore({ scene: s.scene, anim: s.anim })).toBe(false);
  });

  it('internState carries clips and shares them with the live capture', () => {
    const liveState = captureSharedState();
    const foreign = { scene: legacyCapture().scene, anim: legacyCapture().anim, clips: fresh() };
    const interned = internState(foreign);
    expect(interned.clips).toEqual(foreign.clips);
    expect(interned.clips!.main!.n1).toBe(liveState.clips!.main!.n1);
    // The caller's objects are not what the entry holds.
    foreign.clips.main!.n0![0]!.start = 999;
    expect(interned.clips!.main!.n0![0]!.start).toBe(0);
    // A foreign state without clips stays without.
    expect('clips' in internState({ scene: foreign.scene, anim: foreign.anim })).toBe(false);
  });

  it('noteRestoredState seeds the clip cache so the next capture shares with the restored entry', () => {
    const a = captureSharedState();
    live.main!.n0 = [bar(5, 5)];
    captureSharedState();
    // The live timeline is put back to `a` by a restore…
    live.main!.n0 = [bar(0, 300)];
    noteRestoredState(a.scene, a.anim, a.clips);
    // …and the next capture reuses `a`'s objects rather than building new ones.
    expect(captureSharedState().clips).toBe(a.clips);
  });

  it('without a provider the flag-on snapshot carries an empty clips record', () => {
    registerClipGeometryProvider(null);
    expect(captureSharedState().clips).toEqual({});
  });
});
