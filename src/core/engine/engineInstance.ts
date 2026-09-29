/**
 * THE engine of this editor session — one `LocalEngine` over the live scene
 * graph, animation engine, timelines and project stores (NATIVE_CORE_PLAN §5
 * B3, ENGINE_API.md §15.3).
 *
 *   engine()                 the EngineClient every UI write goes through
 *   bootEngine(opts)         boot (Providers, after Application.boot and the
 *                            history wiring); idempotent
 *   rebuildEngine(reason)    a fresh instance for a new document — called on
 *                            ProjectLoaded / ProjectUnloaded (bootEngine wires
 *                            it) and by anything else that swaps the whole
 *                            document (crash recovery)
 *   subscribeEngine(l)       event batches from WHICHEVER instance is current;
 *                            survives rebuilds, and a rebuild delivers a
 *                            synthetic `documentReset` so a mirror refetches
 *   onEngineReplaced(l)      told when the instance changes
 *   shutdownEngine()         teardown (Providers unmount, tests)
 *
 * Why a rebuild per document: the engine keeps per-document state beside the
 * stores it drives — the deterministic id counters (seeded from the document's
 * keyframe ids), the keyframe id index, the command log header, the project
 * path and the saved revision. A document swapped in underneath it (the app's
 * own Open/New/Close still go through ProjectManager, not the API) would
 * leave all of that describing the previous project. The history stack is
 * reset by the same transitions (`baselineProjectHistory`), so no entry of the
 * old instance survives to be undone against the new one.
 *
 * Headless: the CLI render and the export worker window mount `Providers`
 * (src/pages/RenderPage.tsx), so they boot this engine too. Their document
 * changes (caption insertion, auto-reframe in headlessRender.ts) are core-side
 * document builders, not UI writes — they move onto the API with the other
 * automation clients in B5; until then the engine sees them as external
 * changes (documentReset{resync}), which is correct and cheap.
 *
 * D5 / F2 — the C++ ENGINE OWNS THE DOCUMENT wherever there is an engine
 * bridge (always in the app; the owner flag and the TypeScript fallback are
 * gone — docs/TS_ENGINE_REMOVAL.md): `engine()` is an `OwnedEngineClient`
 * over the process client. Its events feed `subscribeEngine` (the mirror),
 * undo/redo route to it, and the LocalEngine is only the page's REPLICA (fed
 * the same document-changing requests, ownedEngineClient.ts) until the UI
 * reads only the mirror. A project open / close no longer rebuilds it: the
 * replica received the same newProject / openProject the owner did. Without a
 * bridge (the jest harness) the LocalEngine answers `engine()` itself.
 *
 * No React here (src/core). The hooks over this live in src/hooks.
 */

import type { EngineClient, EventBatch, EventListener } from '@motion/engine-api';
import { getEventBus } from '@core/events/EventBus';
import { LocalEngine, type LocalEngineOptions } from './LocalEngine';
import { createAppProcessEngine } from './process/processEngine';
import { OwnedEngineClient } from './ownedEngineClient';
import { installAnimEditBridge } from './animEditBridge';
import { setEngineOwnsDocument } from './engineOwnership';
import { useUIStore } from '@stores/uiStore';
import { setHistoryRoute } from '@stores/historyStore';
import { setAppMirrorSource } from '@stores/documentMirror';
import type { EnginePorts } from './ports';
import { createReplicaRefresher, type ReplicaRefresher } from './replicaRefresh';

export interface BootEngineOptions {
  ports?: EnginePorts;
  /** Current project path, if any (engine's `projectPath` / dirty tracking). */
  projectPath?: () => string | null | undefined;
  /**
   * Record the command log (§12). Off in the app until B5 turns replay on:
   * every drag message is deep-copied into it and it is never trimmed.
   */
  recordLog?: boolean;
  /** Extra options for tests. */
  engineOptions?: Partial<LocalEngineOptions>;
  /**
   * D5 / F2: the C++ engine owns the document (the owner flag, decided by main:
   * `engine:status.ownsDocument`). Needs the process bridge; without one the
   * TypeScript engine stays the owner and the flag is cleared.
   */
  ownsDocument?: boolean;
}

let current: LocalEngine | null = null;
/** The session's engine while the C++ engine owns the document (else null). */
let owned: OwnedEngineClient | null = null;
let detachOwned: (() => void) | null = null;
/** F2: refreshes the page replica after another window's edit (replicaRefresh.ts). */
let replicaRefresher: ReplicaRefresher | null = null;
let bootOpts: BootEngineOptions | null = null;
let busSubs: Array<{ dispose(): void }> = [];
let generation = 0;
const listeners = new Set<EventListener>();
const replacedListeners = new Set<(engine: LocalEngine) => void>();
let detachCurrent: (() => void) | null = null;

function create(): LocalEngine {
  const o = bootOpts ?? {};
  const path = o.projectPath?.() ?? '';
  const e = new LocalEngine({
    legacyUiRefresh: true,
    recordLog: o.recordLog ?? false,
    ...(o.ports ? { ports: o.ports } : {}),
    ...(path ? { projectPath: path } : {}),
    ...o.engineOptions,
  });
  // The replica's events are not the session's while the engine owns the document.
  detachCurrent = owned ? null : e.subscribe((batch) => fanOut(batch));
  return e;
}

function fanOut(batch: EventBatch): void {
  for (const l of [...listeners]) {
    try {
      l(batch);
    } catch {
      // One subscriber's failure never reaches the engine or the others.
    }
  }
}

function install(next: LocalEngine, reason: 'opened' | 'created'): void {
  const prev = current;
  current = next;
  installHistoryRoute();
  generation += 1;
  // The document under the old instance is already gone: abandon it (an open
  // gesture is dropped, not committed onto the new document's history).
  if (prev) prev.dispose();
  for (const l of [...replacedListeners]) {
    try { l(next); } catch { /* isolate */ }
  }
  // Every install, the first included: a subscriber that outlived a shutdown
  // (the document mirror, B4) must refetch from the new instance. (Owner mode:
  // the replica changed, not the document — the owner's own reset covers it.)
  if (owned) return;
  fanOut({
    fromRevision: 0,
    toRevision: next.documentRevision,
    events: [{ type: 'documentReset', revision: next.documentRevision, reason }],
    origin: 'engine',
  });
}

/**
 * The app's Undo/Redo/History-panel jump become engine requests (G2): they
 * are in the command log, so a keyboard-undo session replays revision-exact.
 * They go to the session's engine — the owner when the C++ engine owns the
 * document (which forwards them to the replica).
 */
function installHistoryRoute(): void {
  setHistoryRoute({
    step: (dir) => (current || owned ? engine().execute({ type: dir }) : Promise.resolve()),
    jump: (position) => (current || owned ? engine().execute({ type: 'jumpToHistory', position }) : Promise.resolve()),
  });
}

/** The toast for a process-engine notice (main also shows the blocking dialog when it is unavailable). */
function noticeToUser(n: { kind: 'unavailable'; reason: string } | { kind: 'restarted'; cause: string; replayed: number }): void {
  try {
    useUIStore.getState().notify({
      level: n.kind === 'unavailable' ? 'error' : 'info',
      message: n.kind === 'unavailable'
        ? `The engine is unavailable (${n.reason})`
        : `The engine restarted (${n.cause}); ${n.replayed} edits restored`,
      durationMs: n.kind === 'unavailable' ? 8000 : 4000,
    });
  } catch {
    // No UI store (headless).
  }
}

/**
 * D5 / F2: make the C++ engine the owner. The LocalEngine (already booted)
 * becomes the page's replica (until the UI reads only the mirror). False when
 * there is no engine bridge (the jest harness): the LocalEngine answers there.
 */
function startOwner(): boolean {
  const pc = createAppProcessEngine({
    onNotice: (n) => noticeToUser(n),
    // F2: another window (a pop-out, or the editor from a pop-out) edited the
    // engine; this window's page replica missed those requests.
    onForeignBatch: () => replicaRefresher?.schedule(),
  });
  if (!pc) return false;
  owned = new OwnedEngineClient(pc, () => current);
  // Page-history animation edits reach the owner (animEditBridge.ts), not the replica alone.
  installAnimEditBridge();
  replicaRefresher?.dispose();
  replicaRefresher = createReplicaRefresher({ owner: () => owned ?? engine() });
  // The replica's own events stop reaching the session; the owner's start.
  detachCurrent?.();
  detachCurrent = null;
  detachOwned = owned.subscribe((batch) => fanOut(batch));
  installHistoryRoute();
  generation += 1;
  const rev = owned.revision;
  fanOut({ fromRevision: rev, toRevision: rev, events: [{ type: 'documentReset', revision: rev, reason: 'resync' }], origin: 'engine' });
  return true;
}

// The document mirror (src/stores/documentMirror.ts) reads the session's
// engine through the API only: its events, its queries — and, in process, the
// synchronous query fast path (LocalEngine.querySync).
setAppMirrorSource(() => ({
  subscribe: (listener) => subscribeEngine(listener),
  query: (q) => engine().query(q),
  querySync: (q) => {
    const e = engine();
    return e instanceof LocalEngine ? e.querySync(q) : null;
  },
}));

/**
 * Boot the session's engine. Call once the app bus exists (after
 * `Application.boot`) — the engine subscribes to it to detect writes made
 * around the API. Idempotent: a second call re-binds the bus and returns the
 * running instance.
 */
export function bootEngine(opts: BootEngineOptions = {}): LocalEngine {
  bootOpts = opts;
  for (const s of busSubs) s.dispose();
  const bus = getEventBus();
  // Owner mode: the replica received the same newProject / openProject as the
  // owner, so a project transition must NOT swap it for a fresh one (that
  // would forget the document the owner still has).
  busSubs = opts.ownsDocument || owned
    ? []
    : [
      bus.on('ProjectLoaded', () => rebuildEngine('opened')),
      bus.on('ProjectUnloaded', () => rebuildEngine('created')),
    ];
  let e: LocalEngine;
  if (current) {
    current.attachBus();
    if (opts.ports) current.attachPorts(opts.ports);
    e = current;
  } else {
    e = create();
    install(e, 'opened');
  }
  if (opts.ownsDocument && !owned) {
    if (!startOwner()) {
      setEngineOwnsDocument(false);
      busSubs = [
        bus.on('ProjectLoaded', () => rebuildEngine('opened')),
        bus.on('ProjectUnloaded', () => rebuildEngine('created')),
      ];
    }
  }
  return e;
}

/**
 * Replace the engine with a fresh one over the (already swapped) live document.
 * Owner mode: only the replica is replaced (the owner keeps its document).
 */
export function rebuildEngine(reason: 'opened' | 'created' = 'opened'): LocalEngine {
  if (current) detachCurrent?.();
  const e = create();
  install(e, reason);
  return e;
}

/** Tear down (Providers unmount, tests). A gesture still open is committed. */
export async function shutdownEngine(): Promise<void> {
  for (const s of busSubs) s.dispose();
  busSubs = [];
  const e = current;
  current = null;
  // The owner's process client is the window's (processEngine.ts) and outlives
  // a Providers remount; only this session's view of it goes.
  detachOwned?.();
  detachOwned = null;
  replicaRefresher?.dispose();
  replicaRefresher = null;
  owned = null;
  setHistoryRoute(null);
  detachCurrent?.();
  detachCurrent = null;
  bootOpts = null;
  if (e) await e.close();
}

/**
 * The session's EngineClient. Before `bootEngine` (a panel mounted on its own
 * in a test, a surface that renders without Providers) it boots a PORTLESS
 * engine on the current bus: edits work, file/media commands answer
 * `unsupported`. Providers' boot then adopts it and attaches the real ports.
 * When the C++ engine owns the document, the owner (see the file header).
 */
export function engine(): EngineClient {
  if (owned) return owned;
  if (!current) bootEngine({});
  return owned ?? current!;
}

/**
 * F2: refresh this window's page replica from the engine now (a pop-out's
 * first document — windowSync). False when the engine does not own the
 * document here, or nothing could be fetched.
 */
export function refreshReplicaFromEngine(): Promise<boolean> {
  return replicaRefresher?.refreshNow() ?? Promise.resolve(false);
}

/** The owner client while the C++ engine owns the document (diagnostics, the harness). */
export function ownedEngine(): OwnedEngineClient | null {
  return owned;
}

/**
 * Resolves once every request sent so far has been answered (requests are
 * applied strictly in order). Tests: `fireEvent.click(…); await engineIdle();`.
 */
export async function engineIdle(): Promise<void> {
  if (!current) return;
  await current.whenIdle();
}

/** The concrete local engine (history state, gesture flag) — tests and diagnostics. */
export function localEngine(): LocalEngine | null {
  return current;
}

export function hasEngine(): boolean {
  return current !== null;
}

/** Bumped on every rebuild (a gesture begun on an older instance is dead). */
export function engineGeneration(): number {
  return generation;
}

/** Event batches from the current instance, across rebuilds. */
export function subscribeEngine(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Told whenever `rebuildEngine`/`bootEngine` installs a new instance. */
export function onEngineReplaced(listener: (engine: LocalEngine) => void): () => void {
  replacedListeners.add(listener);
  return () => replacedListeners.delete(listener);
}
