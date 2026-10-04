/**
 * Autosave storage — append-only, crash-safe, off the main thread.
 *
 * What these pin, and the failure each one guards against:
 *
 *   • a snapshot round-trips (doc, scene, animation, playhead, stamp);
 *   • a write adds ONE body and rewrites only the small index — the older
 *     bodies are never touched (the old ring rewrote every kept snapshot, and
 *     every unrelated settings write re-serialised them all);
 *   • dying between the body and the index, or leaving a truncated body,
 *     still offers the previous snapshot, and the stray body is swept later;
 *   • running out of quota gives the oldest snapshots' space to the newest and
 *     never deletes the one on offer;
 *   • an unchanged document is not written again — but it IS after the offer
 *     was cleared, after a failed write, and when a newer write from the other
 *     serializer means the worker's memory no longer matches storage;
 *   • the worker path copies the document when it is handed over, so an edit
 *     made right after `persistRecovery` returns cannot leak into the snapshot;
 *   • snapshots written by the settings-store builds are still offered, and
 *     retired by the first new write;
 *   • the controller's interval tick runs through the idle queue and the window
 *     closing writes synchronously.
 */


import {
  clearRecovery,
  configureRecoveryForTests,
  persistRecovery,
  readRecovery,
  readRecoveryRing,
  
  whenRecoveryWritesSettled,
  type RecoverySnapshot,
  type RecoveryWorkerLike,
} from './recovery';
import { RecoverySerializer, type RecoveryJob } from './recoverySerializer';
import {
  RECOVERY_BODY_KEY_PREFIX,
  RECOVERY_INDEX_KEY,
  readRecoveryIndex,
  recoveryBodyKey,
  type RecoveryKV,
} from './recoveryStore';
import { setCoreServiceRefs } from '@core/services/coreServices';
import { SettingsManager } from '@core/settings/SettingsManager';
import { usePreferenceStore } from '@stores/preferenceStore';

import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';

class MemKV implements RecoveryKV {
  readonly map = new Map<string, string>();
  sets: string[] = [];
  /** Return true to make that `setItem` throw (a crash or a quota error). */
  failSet: ((key: string) => boolean) | null = null;
  budget = Infinity;

  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.failSet?.(k)) throw new Error('simulated failure');
    let used = 0;
    for (const [kk, vv] of this.map) if (kk !== k) used += kk.length + vv.length;
    if (used + k.length + v.length > this.budget) throw new Error('QuotaExceededError');
    this.map.set(k, v);
    this.sets.push(k);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
  bodies(): string[] {
    return this.keys().filter((k) => k.startsWith(RECOVERY_BODY_KEY_PREFIX));
  }
}

function layerNode(x: number): SceneNode {
  return {
    id: 'layer_a', name: 'A', parent: null, children: [], visible: true, locked: false, solo: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'a_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x } }],
  } as unknown as SceneNode;
}

function snap(savedAt: number, x: number, projectId = 'proj_1'): RecoverySnapshot {
  const scene = { version: '1.0.0', nodes: [layerNode(x)] };
  const animation = {
    tracks: { layer_a: { x: { nodeId: 'layer_a', prop: 'x', keyframes: [{ t: 0, value: x }, { t: 2, value: x + 10 }] } } },
    expressions: {},
  };
  const doc = { version: '1.6.0', scene, animation };
  return { projectId, savedAt, time: 1.5, doc, scene, anim: animation } as unknown as RecoverySnapshot;
}

const xOf = (s: RecoverySnapshot | null | undefined): number | undefined =>
  (s?.doc?.scene.nodes[0]?.components[0]?.props as { x?: number } | undefined)?.x;

const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let kv: MemKV;
let settings: SettingsManager;

beforeEach(() => {
  kv = new MemKV();
  settings = new SettingsManager({ read: () => null, write: () => {} });
  setCoreServiceRefs({ settings } as never);
  usePreferenceStore.setState({ autosaveKeep: 5, autosaveLocation: null } as never);
  configureRecoveryForTests({ storage: kv, workerFactory: null });
});

afterAll(() => {
  configureRecoveryForTests({});
});

describe('the ring', () => {
  it('round-trips the newest snapshot', () => {
    const s = snap(100, 7);
    persistRecovery(s);
    const got = readRecovery();
    expect(got).toMatchObject({ projectId: 'proj_1', savedAt: 100, time: 1.5 });
    expect(got!.doc).toEqual(s.doc);
    expect(got!.scene).toEqual(s.scene);
    expect(got!.anim).toEqual(s.anim);
  });

  it('is append-only: one new body plus the index, older bodies untouched', () => {
    persistRecovery(snap(1, 1));
    const [firstKey] = kv.bodies();
    const firstBody = kv.getItem(firstKey!);
    kv.sets = [];

    persistRecovery(snap(2, 2));

    expect(kv.sets).toHaveLength(2);
    expect(kv.sets[0]!.startsWith(RECOVERY_BODY_KEY_PREFIX)).toBe(true);
    expect(kv.sets[0]).not.toBe(firstKey);
    expect(kv.sets[1]).toBe(RECOVERY_INDEX_KEY);
    expect(kv.getItem(firstKey!)).toBe(firstBody);
    expect(readRecoveryRing().map(xOf)).toEqual([2, 1]);
    // Nothing of it lands in the settings store any more.
    expect(settings.keys()).toEqual([]);
  });

  it('keeps N (Preferences ▸ Files) and deletes the rest', () => {
    usePreferenceStore.setState({ autosaveKeep: 3 } as never);
    for (let i = 1; i <= 5; i++) persistRecovery(snap(i, i));
    expect(readRecoveryRing().map(xOf)).toEqual([5, 4, 3]);
    expect(kv.bodies()).toHaveLength(3);
  });
});

describe('crash safety', () => {
  it('a write that dies before the index leaves the previous snapshot on offer', () => {
    persistRecovery(snap(1, 1));
    kv.failSet = (k) => k === RECOVERY_INDEX_KEY;
    persistRecovery(snap(2, 2));
    kv.failSet = null;
    expect(xOf(readRecovery())).toBe(1);

    // A process that died after the body landed runs no cleanup at all.
    kv.map.set(recoveryBodyKey('died-mid-write'), 'gz1:');
    expect(xOf(readRecovery())).toBe(1);

    // The content that failed is written by the next attempt, not skipped as
    // "unchanged" — the serializer saw it, storage never did.
    persistRecovery(snap(3, 2));
    expect(xOf(readRecovery())).toBe(2);
    // …and the stray body is swept.
    expect(kv.bodies()).not.toContain(recoveryBodyKey('died-mid-write'));
    expect(kv.bodies()).toHaveLength(2);
  });

  it('a body that fails to write changes nothing', () => {
    persistRecovery(snap(1, 1));
    const index = kv.getItem(RECOVERY_INDEX_KEY);
    kv.failSet = (k) => k.startsWith(RECOVERY_BODY_KEY_PREFIX);
    persistRecovery(snap(2, 2));
    kv.failSet = null;
    expect(kv.getItem(RECOVERY_INDEX_KEY)).toBe(index);
    expect(xOf(readRecovery())).toBe(1);
  });

  it('a truncated latest body falls back to the snapshot before it', () => {
    persistRecovery(snap(1, 1));
    persistRecovery(snap(2, 2));
    const latest = readRecoveryIndex(kv)!.latest!;
    const body = kv.getItem(recoveryBodyKey(latest))!;
    kv.map.set(recoveryBodyKey(latest), body.slice(0, Math.floor(body.length / 2)));
    configureRecoveryForTests({ storage: kv, workerFactory: null }); // a fresh launch: no decode memo
    expect(xOf(readRecovery())).toBe(1);
  });

  it('out of quota: evicts the oldest to fit the newest, never the one on offer', () => {
    const probe = new MemKV();
    configureRecoveryForTests({ storage: probe, workerFactory: null });
    persistRecovery(snap(1, 1));
    const bodyBytes = probe.getItem(probe.bodies()[0]!)!.length + probe.bodies()[0]!.length;
    configureRecoveryForTests({ storage: kv, workerFactory: null });
    usePreferenceStore.setState({ autosaveKeep: 10 } as never);

    // Three bodies plus a three-entry index (~260 chars) fit; a fourth does not.
    kv.budget = Math.floor(bodyBytes * 3) + 300;
    for (let i = 1; i <= 7; i++) persistRecovery(snap(i, i));
    expect(xOf(readRecovery())).toBe(7);
    const ring = readRecoveryRing().map(xOf);
    expect(ring[0]).toBe(7);
    expect(ring.length).toBeLessThanOrEqual(3);

    // Room for one body only: the new one cannot displace the offered one.
    kv.map.clear();
    configureRecoveryForTests({ storage: kv, workerFactory: null });
    kv.budget = Math.floor(bodyBytes * 1.5) + 150;
    persistRecovery(snap(10, 1));
    persistRecovery(snap(11, 2));
    expect(xOf(readRecovery())).toBe(1);
  });
});

describe('skipping an unchanged document', () => {
  it('re-stamps the index instead of writing the same body again', () => {
    persistRecovery(snap(1, 5));
    kv.sets = [];
    persistRecovery(snap(2, 5));
    expect(kv.sets).toEqual([RECOVERY_INDEX_KEY]);
    expect(kv.bodies()).toHaveLength(1);
    expect(readRecovery()!.savedAt).toBe(2);
  });

  it('writes again once the offer was cleared', () => {
    persistRecovery(snap(1, 5));
    clearRecovery();
    expect(readRecovery()).toBeNull();
    persistRecovery(snap(2, 5));
    expect(readRecovery()?.savedAt).toBe(2);
  });

  it('writes when forced (Autosave now)', () => {
    persistRecovery(snap(1, 5));
    kv.sets = [];
    persistRecovery(snap(2, 5), { force: true });
    expect(kv.sets.filter((k) => k.startsWith(RECOVERY_BODY_KEY_PREFIX))).toHaveLength(1);
  });
});

/** An in-process stand-in for the worker: structured-clones what it is posted, like the real one. */
function fakeWorker(opts: { hold?: boolean } = {}): { factory: () => RecoveryWorkerLike; release: () => void; posted: () => number } {
  const serializer = new RecoverySerializer();
  const held: Array<() => void> = [];
  let posted = 0;
  const factory = (): RecoveryWorkerLike => {
    const w: RecoveryWorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => {},
      postMessage: (msg) => {
        posted++;
        const data = structuredClone(msg) as RecoveryJob;
        const deliver = (): void => w.onmessage?.({ data: serializer.run(data) });
        if (opts.hold) held.push(deliver);
        else setTimeout(deliver, 0);
      },
    };
    return w;
  };
  return { factory, release: () => { for (const f of held.splice(0)) f(); }, posted: () => posted };
}

describe('the worker path', () => {
  it('writes nothing on the calling task, and an edit right after hand-off does not leak in', async () => {
    const fw = fakeWorker();
    configureRecoveryForTests({ storage: kv, workerFactory: fw.factory });
    const s = snap(1, 1);
    persistRecovery(s);
    expect(readRecovery()).toBeNull();
    (s.doc!.scene.nodes[0]!.components[0]!.props as { x: number }).x = 999;
    await whenRecoveryWritesSettled();
    expect(xOf(readRecovery())).toBe(1);

    // The worker answers "unchanged" for the same document: index only.
    kv.sets = [];
    persistRecovery(snap(2, 1));
    const edited = snap(3, 1);
    persistRecovery(edited);
    (edited.doc!.scene.nodes[0]!.components[0]!.props as { x: number }).x = 555;
    await whenRecoveryWritesSettled();
    expect(kv.sets).toEqual([RECOVERY_INDEX_KEY, RECOVERY_INDEX_KEY]);
    expect(readRecovery()).toMatchObject({ savedAt: 3 });
    expect(xOf(readRecovery())).toBe(1);
    expect(fw.posted()).toBe(3);
  });

  it('a stale worker result never overwrites the window-close write, and the worker is forced afterwards', async () => {
    const fw = fakeWorker({ hold: true });
    configureRecoveryForTests({ storage: kv, workerFactory: fw.factory });
    persistRecovery(snap(1, 1));
    await nextTask();
    fw.release();
    await whenRecoveryWritesSettled();
    expect(xOf(readRecovery())).toBe(1);

    persistRecovery(snap(2, 2)); // posted, still in the worker
    persistRecovery(snap(3, 3), { sync: true }); // the window closing
    fw.release();
    await whenRecoveryWritesSettled();
    expect(xOf(readRecovery())).toBe(3);

    // The worker last produced "2" but storage holds "3". Unforced, it would
    // answer "unchanged" to a 2 and leave the 3 on offer.
    persistRecovery(snap(4, 2));
    await nextTask();
    fw.release();
    await whenRecoveryWritesSettled();
    expect(xOf(readRecovery())).toBe(2);
  });

  it('a worker that fails to load falls back to writing inline', async () => {
    configureRecoveryForTests({ storage: kv, workerFactory: () => { throw new Error('no worker'); } });
    persistRecovery(snap(1, 8));
    await whenRecoveryWritesSettled();
    expect(xOf(readRecovery())).toBe(8);
    persistRecovery(snap(2, 9));
    expect(xOf(readRecovery())).toBe(9); // now inline, same task
  });
});

describe('compatibility', () => {
  it('offers a snapshot a settings-store build wrote, and the first new write retires it', () => {
    const legacy = snap(50, 42);
    settings.set('recovery', legacy);
    settings.set('recovery.ring', [legacy]);
    expect(xOf(readRecovery())).toBe(42);
    expect(readRecoveryRing().map(xOf)).toEqual([42]);

    persistRecovery(snap(60, 43));
    expect(settings.has('recovery')).toBe(false);
    expect(settings.has('recovery.ring')).toBe(false);
    expect(xOf(readRecovery())).toBe(43);
  });
});
