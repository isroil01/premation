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

/**
 * THE engine of this editor session: the C++ engine (`premation-engine`, D5 /
 * F2), which owns the document (docs/TS_ENGINE_REMOVAL.md — the TypeScript
 * engine is gone).
 *
 *   engine()                 the EngineClient every UI write goes through
 *   bootEngine(opts)         boot (Providers, after the history wiring); idempotent
 *   subscribeEngine(l)       event batches from the session's engine; a boot
 *                            delivers a synthetic `documentReset` so a mirror refetches
 *   shutdownEngine()         teardown (Providers unmount, tests)
 *
 * `engine()` is an `OwnedEngineClient` over the window's process client. Its
 * events feed `subscribeEngine` (the mirror) and undo/redo route to it. The
 * page keeps no copy of the document; the UI reads the mirror. Without an
 * engine bridge (a jest suite that does not boot the native harness) there is
 * no engine: `engine()` answers every request `busy`.
 *
 * No React here (src/core). The hooks over this live in src/hooks.
 */

import { EngineClientBase, engineError, type EngineClient, type EventListener, type Request, type Response } from '@motion/engine-api';
import { createAppProcessEngine } from './process/processEngine';
import { OwnedEngineClient } from './ownedEngineClient';
import { setEngineOwnsDocument } from './engineOwnership';
import { useUIStore } from '@stores/uiStore';
import { setHistoryRoute } from '@stores/historyStore';
import { documentMirror, hasDocumentMirror, setAppMirrorSource } from '@stores/documentMirror';

export interface BootEngineOptions {
  /**
   * D5 / F2: the C++ engine owns the document (main's `engine:status.ownsDocument`,
   * or a pop-out mirroring it). Needs the process bridge.
   */
  ownsDocument?: boolean;
}

/** The session's engine (else null). */
let owned: OwnedEngineClient | null = null;
let detachOwned: (() => void) | null = null;
let generation = 0;
const listeners = new Set<EventListener>();

/** No engine (no bridge, not booted): every request answers `busy`, nothing is ever sent. */
class NoEngineClient extends EngineClientBase {
  request(request: Request): Promise<Response> {
    return Promise.resolve({
      seq: request.seq,
      revision: this.revision,
      outcome: { kind: 'error', value: engineError('busy', 'No engine is running.') },
    });
  }
  subscribe(): () => void {
    return () => {};
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
const noEngine = new NoEngineClient();

function fanOut(batch: Parameters<EventListener>[0]): void {
  for (const l of [...listeners]) {
    try {
      l(batch);
    } catch {
      // One subscriber's failure never reaches the engine or the others.
    }
  }
}

/**
 * The app's Undo/Redo/History-panel jump become engine requests (G2), sent to
 * the session's engine.
 */
function installHistoryRoute(): void {
  setHistoryRoute({
    step: (dir) => (owned ? owned.execute({ type: dir }) : Promise.resolve()),
    jump: (position) => (owned ? owned.execute({ type: 'jumpToHistory', position }) : Promise.resolve()),
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

/** Make the C++ engine the session's engine. False when there is no engine bridge. */
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
// engine through the API only: its events and its queries.
setAppMirrorSource(() => ({
  subscribe: (listener) => subscribeEngine(listener),
  query: (q) => engine().query(q),
  querySync: () => null,
}));

/**
 * Boot the session's engine. Idempotent: a second call returns the running
 * engine. Without `ownsDocument` or without an engine bridge there is none
 * (`engine()` answers `busy`).
 */
export function bootEngine(opts: BootEngineOptions = {}): EngineClient {
  if (owned) return owned;
  if (opts.ownsDocument && startOwner()) return owned!;
  setEngineOwnsDocument(false);
  return noEngine;
}

/** Tear down (Providers unmount, tests). */
export async function shutdownEngine(): Promise<void> {
  // The owner's process client is the window's (processEngine.ts) and outlives
  // a Providers remount; only this session's view of it goes.
  detachOwned?.();
  detachOwned = null;
  owned = null;
  setHistoryRoute(null);
}

/** The session's EngineClient: the owner, else the inert `busy` client. */
export function engine(): EngineClient {
  return owned ?? noEngine;
}

/** The owner client (diagnostics, the harness). */
export function ownedEngine(): OwnedEngineClient | null {
  return owned;
}

/**
 * Resolves once every request sent so far has been answered (requests are
 * applied strictly in order) and the mirror has caught up.
 * Tests: `fireEvent.click(…); await engineIdle();`.
 */
export async function engineIdle(): Promise<void> {
  if (!owned) return;
  const res = await owned.query({ type: 'getItems', items: [] });
  if (hasDocumentMirror()) await documentMirror().whenAt(res.revision);
}

export function hasEngine(): boolean {
  return owned !== null;
}

/** Bumped every time an engine is installed (a gesture begun on an older one is dead). */
export function engineGeneration(): number {
  return generation;
}

/** Event batches from the session's engine. */
export function subscribeEngine(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
