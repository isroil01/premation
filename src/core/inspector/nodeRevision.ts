/**
 * Per-node revision — so a scrub on one layer re-renders only that layer's
 * inspector rows.
 *
 * `useSceneRevision((s) => s.rev)` is one counter for the whole scene: every
 * value write on any node bumps it, and every subscriber re-renders. The
 * Properties panel subscribed to it at the root and in every section, so a
 * drag on layer A re-rendered every section drawn for layer B, plus the panel
 * shell, on every pointer event.
 *
 * This keeps a counter PER NODE, fed from the events that already name the
 * node they touched (`NodeUpdated`, `AnimationChanged`), and bumps every
 * counter only on the events that cannot say (`SceneGraphChanged` — add,
 * delete, reparent). A section keyed on `useNodeRevision(nodeId)` therefore
 * sees every change to its own layer and nothing about anyone else's.
 *
 * Not coalesced to a frame: React 18 batches every `setState` raised inside
 * one task, so the burst of bumps a pointer event produces is one render
 * already — and a synchronous tick is what lets a test read the row right
 * after the write, exactly as `useAnimationRevision` allowed.
 *
 * Wired lazily — the first subscriber mounts the bus subscriptions — and
 * re-armed when the bus instance changes, because `Application.boot()` swaps
 * the bus (the trap `attachHistoryBaselineSync` documents).
 *
 * The React hooks over this counter (`useNodeRevision`, `useNodesRevision`)
 * live in `@hooks/useNodeRevision` — `src/core` does not import React
 * (docs/NATIVE_CORE_PLAN.md §4 T0).
 */

import { getEventBus } from '@core/events/EventBus';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { useSceneRevision } from '@stores/sceneStore';

type Listener = () => void;

const revisions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
let globalRev = 0;
let wiredBus: unknown = null;
let disposers: Array<{ dispose(): void }> = [];
let storeUnsub: (() => void) | null = null;

/**
 * True between a `NodeUpdated` and the end of the current microtask.
 *
 * `updateNodeComponentProp` emits `NodeUpdated` and THEN advances the scene
 * revision; the two arrive synchronously, so a revision bump that follows an
 * attributed event is the same write and must not fan out to every node. A
 * revision bump with no attribution (the viewport gesture's `gestureSceneBump`,
 * an effect edit) names no node, so it has to reach them all.
 */
let attributed = false;

function notify(nodeId: string): void {
  revisions.set(nodeId, (revisions.get(nodeId) ?? 0) + 1);
  listeners.get(nodeId)?.forEach((l) => l());
  if (!attributed) {
    attributed = true;
    queueMicrotask(() => { attributed = false; });
  }
}

function notifyAll(): void {
  globalRev += 1;
  for (const set of listeners.values()) set.forEach((l) => l());
}

/** Advance a node's counter by hand — tests and non-bus writers. */
export function bumpNodeRevision(nodeId?: string): void {
  if (nodeId) notify(nodeId);
  else notifyAll();
}

/** Current revision of one node (its own counter plus the global one). */
export function nodeRevision(nodeId: string): number {
  return (revisions.get(nodeId) ?? 0) + globalRev * 1_000_003;
}

function ensureWired(): void {
  const bus = getEventBus();
  if (wiredBus === bus) return;
  for (const d of disposers) d.dispose();
  wiredBus = bus;
  disposers = [
    bus.on('NodeUpdated', (p) => notify(p.nodeId)),
    bus.on('AnimationChanged', (p) => {
      if (isMediaDecodeRepaint(p)) return;
      if (p.nodeId && p.nodeId !== '*') notify(p.nodeId);
      else notifyAll();
    }),
    bus.on('SceneGraphChanged', () => notifyAll()),
  ];
  // Revision-only bumps (`bumpSceneRevision`) announce no node. Unattributed
  // ones fan out; the one that trails a `NodeUpdated` in the same microtask is
  // that write's own bump and is already delivered.
  if (!storeUnsub) {
    storeUnsub = useSceneRevision.subscribe((s, prev) => {
      if (s.rev === prev.rev) return;
      if (attributed) return;
      notifyAll();
    });
  }
}

/** Subscribe to one node's revision. Returns the unsubscribe. */
export function subscribeNodeRevision(nodeId: string, listener: Listener): () => void {
  ensureWired();
  let set = listeners.get(nodeId);
  if (!set) {
    set = new Set();
    listeners.set(nodeId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(nodeId);
  };
}

