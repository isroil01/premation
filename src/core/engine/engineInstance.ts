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
 * over the process client. Its events feed `subscribeEngine` (the mirror) and
 * undo/redo route to it. The page keeps NO copy of the document (block 3: the
 * replica is gone) — no LocalEngine is created; the UI reads the mirror.
 * Without a bridge (the jest harness, the headless CLI window) the LocalEngine
 * answers `engine()` itself.
 *
 * No React here (src/core). The hooks over this live in src/hooks.
 */

import type { EngineClient, EventBatch, EventListener } from '@motion/engine-api';
import { getEventBus } from '@core/events/EventBus';
import { LocalEngine, type LocalEngineOptions } from './LocalEngine';
import { createAppProcessEngine } from './process/processEngine';
import { OwnedEngineClient } from './ownedEngineClient';
import { setEngineOwnsDocument } from './engineOwnership';
import { useUIStore } from '@stores/uiStore';
import { setHistoryRoute } from '@stores/historyStore';
import { documentMirror, hasDocumentMirror, setAppMirrorSource } from '@stores/documentMirror';
import type { EnginePorts } from './ports';

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
  detachCurrent = e.subscribe((batch) => fanOut(batch));
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
  // (the document mirror, B4) must refetch from the new instance.
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
 * document.
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
 * D5 / F2: make the C++ engine the owner — the session's only engine. False
 * when there is no engine bridge (the jest harness): a LocalEngine answers there.
 */
function startOwner(): boolean {
  const pc = createAppProcessEngine({ onNotice: (n) => noticeToUser(n) });
  if (!pc) return false;
  owned = new OwnedEngineClient(pc);
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
 * `Application.boot`). Idempotent: a second call re-binds the bus and returns
 * the running engine. With `ownsDocument` and an engine bridge the C++ engine
 * is the session's engine and no LocalEngine is created (a portless one booted
 * earlier by `engine()` is dropped); otherwise a LocalEngine over the live
 * stores, rebuilt on every project transition.
 */
export function bootEngine(opts: BootEngineOptions = {}): EngineClient {
  bootOpts = opts;
  for (const s of busSubs) s.dispose();
  busSubs = [];
  if (owned) return owned;
  if (opts.ownsDocument) {
    if (startOwner()) {
      if (current) {
        detachCurrent?.();
        detachCurrent = null;
        current.dispose();
        current = null;
      }
      return owned!;
    }
    setEngineOwnsDocument(false);
  }
  const bus = getEventBus();
  busSubs = [
    bus.on('ProjectLoaded', () => rebuildEngine('opened')),
    bus.on('ProjectUnloaded', () => rebuildEngine('created')),
  ];
  if (current) {
    current.attachBus();
    if (opts.ports) current.attachPorts(opts.ports);
    return current;
  }
  const e = create();
  install(e, 'opened');
  return e;
}

/**
 * Replace the TypeScript engine with a fresh one over the (already swapped)
 * live document. Not in owner mode (the C++ engine keeps its document).
 */
export function rebuildEngine(reason: 'opened' | 'created' = 'opened'): LocalEngine {
  if (owned) throw new Error('rebuildEngine: the C++ engine owns the document');
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

/** The owner client while the C++ engine owns the document (diagnostics, the harness). */
export function ownedEngine(): OwnedEngineClient | null {
  return owned;
}

/**
 * Resolves once every request sent so far has been answered (requests are
 * applied strictly in order). Tests: `fireEvent.click(…); await engineIdle();`.
 */
export async function engineIdle(): Promise<void> {
  if (owned) {
    // Requests are applied in order: a query sent now is answered after every
    // request before it. Then let the mirror reach that revision.
    const res = await owned.query({ type: 'getItems', items: [] });
    if (hasDocumentMirror()) await documentMirror().whenAt(res.revision);
    return;
  }
  if (!current) return;
  await current.whenIdle();
}

/** The concrete local engine (history state, gesture flag) — tests and diagnostics. */
export function localEngine(): LocalEngine | null {
  return current;
}

export function hasEngine(): boolean {
  return current !== null || owned !== null;
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
