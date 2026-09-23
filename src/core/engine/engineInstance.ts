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
 * No React here (src/core). The hooks over this live in src/hooks.
 */

import type { EngineClient, EventBatch, EventListener } from '@motion/engine-api';
import { getEventBus } from '@core/events/EventBus';
import { LocalEngine, type LocalEngineOptions } from './LocalEngine';
import { createAppProcessEngine, processEngineEnabled } from './process/processEngine';
import { useUIStore } from '@stores/uiStore';
import { setHistoryRoute } from '@stores/historyStore';
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
}

let current: LocalEngine | null = null;
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
  // The app's Undo/Redo/History-panel jump become engine requests (G2): they
  // are in the command log, so a keyboard-undo session replays revision-exact.
  setHistoryRoute({
    step: (dir) => (current ? current.execute({ type: dir }) : Promise.resolve()),
    jump: (position) => (current ? current.execute({ type: 'jumpToHistory', position }) : Promise.resolve()),
  });
  generation += 1;
  // The document under the old instance is already gone: abandon it (an open
  // gesture is dropped, not committed onto the new document's history).
  if (prev) prev.dispose();
  for (const l of [...replacedListeners]) {
    try { l(next); } catch { /* isolate */ }
  }
  if (prev) {
    fanOut({
      fromRevision: 0,
      toRevision: next.documentRevision,
      events: [{ type: 'documentReset', revision: next.documentRevision, reason }],
      origin: 'engine',
    });
  }
}

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
  busSubs = [
    bus.on('ProjectLoaded', () => rebuildEngine('opened')),
    bus.on('ProjectUnloaded', () => rebuildEngine('created')),
  ];
  if (current) {
    current.attachBus();
    if (opts.ports) current.attachPorts(opts.ports);
    startProcessEngine();
    return current;
  }
  const e = create();
  install(e, 'opened');
  startProcessEngine();
  return e;
}

/**
 * The C++ engine (C3), when the process backend is enabled
 * (`PREMATION_ENGINE=process` or `<userData>/engine.json`). It runs beside this
 * LocalEngine with it as the fallback, drives the engine surface, and is
 * reachable through `processEngine()`.
 *
 * Deliberately NOT what `engine()` returns yet: the C++ engine implements C2's
 * command subset and does not render the whole document, while today's
 * viewport draws the TypeScript document — routing UI edits there would make
 * them vanish from the screen. `engine()` switches to it at D5, when the engine
 * viewport becomes the real one (docs/NATIVE_CORE_PLAN.md §5).
 */
function startProcessEngine(): void {
  void processEngineEnabled().then((on) => {
    if (!on) return;
    createAppProcessEngine({
      fallback: () => engine(),
      onNotice: (n) => {
        try {
          useUIStore.getState().notify({
            level: n.kind === 'fallback' ? 'warning' : 'info',
            message: n.kind === 'fallback'
              ? `The C++ engine is unavailable — continuing on the built-in engine (${n.reason})`
              : `The C++ engine restarted (${n.cause}); ${n.replayed} edits restored`,
            durationMs: n.kind === 'fallback' ? 8000 : 4000,
          });
        } catch {
          // No UI store (headless).
        }
      },
    });
  }).catch(() => { /* no bridge / not desktop */ });
}

/** Replace the engine with a fresh one over the (already swapped) live document. */
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
 */
export function engine(): EngineClient {
  if (!current) bootEngine({});
  return current!;
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
