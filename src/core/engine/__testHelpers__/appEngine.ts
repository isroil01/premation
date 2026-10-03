/**
 * The APP's engine in a test: the real `premation-engine` (headless, through the
 * same EngineSupervisor + bridge the app uses, nativeEngine.ts) as the document
 * owner, reached through `engine()` exactly as UI code reaches it, with the
 * document mirror over it. One engine process per test file, reset with
 * `newProject` + `clearHistory` per `setupAppEngine()`; jest.setup.ts stops it.
 *
 * Suites that use it are named `*.native.test.ts(x)`: jest skips them when the
 * engine is not built (jest.config.cjs), the Native workflow runs them.
 */

import { unwrap, type OverlayLayerGeometry, type OverlayView, type Command, type CommandOf, type CommandResult, type CommandResults, type CommandType, type EngineClient, type EventBatch, type QueryOf, type QueryResults, type QueryType } from '@motion/engine-api';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { documentMirror, resetDocumentMirror } from '@stores/documentMirror';
import { bindEngineDocumentStores } from '@stores/engineDocumentStores';
import { bindEngineComps, bindEngineItems } from '@stores/engineItemsView';
import { retainSelectionTrees } from '@stores/selectionTrees';
import { MAIN_VIEWPORT, publishFrameGeometry, setEngineDrivenViewport } from '@stores/overlayGeometry';
import { settleToolEdits } from '@core/workspace/viewportGesture';
import { edit } from '../uiEdits';
import { propRefForTrack } from '../propRefs';
import { bootEngine, engine, engineIdle, shutdownEngine } from '../engineInstance';
import { resetEngineOwnership, setEngineOwnsDocument } from '../engineOwnership';
import { resetProcessEngine } from '../process/processEngine';
import { startNativeEngine, type NativeEngine } from './nativeEngine';

export const S = 705_600_000;
/** Seconds → flicks. */
export const sec = (s: number): number => Math.round(s * S);

/** What a scene builder needs (buildScene). */
export interface EngineRunner {
  run<T extends CommandType>(cmd: CommandOf<T>): Promise<CommandResults[T]>;
}

export interface AppHarness extends EngineRunner {
  /** The session's engine (`engine()`). */
  client: EngineClient;
  /** Every event batch since setup. */
  batches: EventBatch[];
  batch(label: string, cmds: Command[]): Promise<CommandResult[]>;
  query<T extends QueryType>(q: QueryOf<T>): Promise<QueryResults[T]>;
  /** The whole document (properties and keyframes), canonical JSON — equal strings, equal documents. */
  doc(): Promise<string>;
  dispose(): Promise<void>;
}

/** Back-compat name for the suites' `let h: Harness`. */
export type Harness = AppHarness;

let shared: NativeEngine | null = null;
let starting: Promise<NativeEngine> | null = null;

async function nativeEngine(): Promise<NativeEngine> {
  if (shared) return shared;
  // `--test-ports`: the engine's FakePorts — deterministic footage records for
  // any path, projects kept in memory (what the suites import and save).
  starting ??= startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports'] }).then((n) => {
    forwardFrames(n);
    return (shared = n);
  });
  return starting;
}

/**
 * What EngineSurface and Electron main's FrameForwarder do for a drawn frame,
 * minus the pixels: the FrameGeometry parts of a frame are collected until
 * `last`, published with that frame's FrameReady (the overlay geometry mirror),
 * and the slot is handed back.
 */
function forwardFrames(n: NativeEngine): void {
  const parts = new Map<number, { generation: number; frame: number; layers: OverlayLayerGeometry[]; views: OverlayView[]; last: boolean }>();
  n.supervisor.on('frame', (m) => {
    if (m.type === 'geometry') {
      let p = parts.get(m.viewport);
      if (!p || p.generation !== m.generation || p.frame !== m.frame || p.last) {
        p = { generation: m.generation, frame: m.frame, layers: [], views: [], last: false };
        parts.set(m.viewport, p);
      }
      p.layers.push(...m.layers);
      p.views.push(...m.views);
      p.last = m.last;
      return;
    }
    if (m.type !== 'frameReady') return;
    n.supervisor.releaseSlot(m.generation, m.slot);
    const p = parts.get(m.viewport);
    const mine = p && p.last && p.generation === m.generation && p.frame === m.frame;
    if (mine) parts.delete(m.viewport);
    publishFrameGeometry(m.viewport, m.time, m.revision, mine ? p.layers : [], mine ? p.views : []);
  });
}

/** Open the main viewport the way EngineSurface does, so its frames (and their geometry) flow. */
async function openMainViewport(client: EngineClient): Promise<void> {
  setEngineDrivenViewport(MAIN_VIEWPORT, true);
  unwrap(await client.execute({
    type: 'setViewport',
    viewport: MAIN_VIEWPORT,
    width: 1920,
    height: 1080,
    devicePixelRatio: 1,
    zoom: 1,
    pan: { x: 0, y: 0 },
    channel: 'rgb',
    exposure: 0,
    transparencyGrid: false,
    displayTransform: '',
    layerRenderEffects: true,
    view: 'active',
  } as Command));
}

/** Stop the file's engine process (jest.setup.ts, afterAll). */
async function stopShared(): Promise<void> {
  const n = shared;
  shared = null;
  starting = null;
  for (const off of viewsOff) off();
  viewsOff = [];
  await shutdownEngine();
  await resetProcessEngine();
  resetEngineOwnership();
  resetDocumentMirror();
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  if (n) await n.stop();
}
(globalThis as { __premationStopNativeEngine?: () => Promise<void> }).__premationStopNativeEngine = stopShared;

// jsdom has no object URLs; New Project revokes the session's asset URLs.
const U = URL as unknown as { revokeObjectURL?: (u: string) => void; createObjectURL?: (b: unknown) => string };
U.revokeObjectURL ??= () => {};
U.createObjectURL ??= () => 'blob:test';

/** Sort object keys so two snapshots of one document are the same string. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

let batchesOff: (() => void) | null = null;
/** The page stores the app binds to the mirror (engineOwnedSession.tsx): items, comps, guides / swatches / materials. */
let viewsOff: Array<() => void> = [];

export async function setupAppEngine(): Promise<AppHarness> {
  // A test that left a gesture open (or a dead engine) poisons the next: start over.
  if (shared) {
    const r = await shared.bridge.status();
    let stale = r.state !== 'running';
    if (!stale) {
      const hist = await engine().query({ type: 'getHistory' });
      stale = !hist.ok || hist.value.gestureOpen;
    }
    if (stale) await stopShared();
  }
  const native = await nativeEngine();
  (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  setEngineOwnsDocument(true);
  bootEngine({ ownsDocument: true });
  const client = engine();
  batchesOff?.();
  const batches: EventBatch[] = [];
  batchesOff = client.subscribe((b) => batches.push(b));
  const h: AppHarness = {
    client,
    batches,
    run: async (cmd) => unwrap(await client.execute(cmd)),
    batch: async (label, cmds) => unwrap(await client.batch(label, cmds)),
    query: async (q) => unwrap(await client.query(q)),
    doc: async () => {
      await engineIdle();
      const d = unwrap(await client.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true }));
      const { revision: _r, dirty: _d, projectPath: _p, ...rest } = d;
      return JSON.stringify(canonical(rest));
    },
    dispose: async () => {
      batchesOff?.();
      batchesOff = null;
      await engineIdle();
      // The page stores stop following the engine: a store-only test after this one is on its own.
      for (const off of viewsOff) off();
      viewsOff = [];
    },
  };
  await h.run({ type: 'newProject' });
  await h.run({ type: 'clearHistory' });
  await openMainViewport(client);
  const m = documentMirror().start();
  for (const off of viewsOff) off();
  viewsOff = [
    bindEngineDocumentStores({ mirror: m, send: (label, cmd) => edit(label, cmd) }),
    bindEngineItems(m),
    bindEngineComps(m),
    retainSelectionTrees(),
  ];
  await engineIdle();
  batches.length = 0;
  return h;
}

/**
 * The API property a legacy track name (`x`, `rotation`, `effect.<id>.<key>`)
 * lives on, and the member index within it — from the mirror, its tree loaded.
 */
export async function trackRef(layer: string, track: string): Promise<{ path: string; members: string[]; member?: number }> {
  await engineIdle();
  await documentMirror().loadTree(layer);
  const r = propRefForTrack(layer, track);
  if (!r) throw new Error(`no property for track '${track}' on ${layer}`);
  const member = r.members.length > 1 ? r.members.indexOf(track) : undefined;
  return { path: r.ref.path, members: [...r.members], ...(member !== undefined && member >= 0 ? { member } : {}) };
}

/** Whether the engine has a gesture open (the history's `gestureOpen`). */
export async function gestureOpen(): Promise<boolean> {
  return unwrap(await engine().query({ type: 'getHistory' })).gestureOpen;
}

/**
 * Everything the UI sent has landed: tool gestures closed (settleToolEdits),
 * the engine idle, the mirror caught up. Over the pipe a gesture closes a few
 * round trips after the pointer-up that ended it.
 */
export async function settleEdits(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await settleToolEdits();
    await engineIdle();
    await documentMirror().whenIdle();
  }
}

/** Empty the engine's undo stack (a test's setup is not part of what it measures). */
export async function clearHistory(): Promise<void> {
  unwrap(await engine().execute({ type: 'clearHistory' }));
}

/** Labels on the engine's undo stack, oldest first. */
export async function historyLabels(): Promise<string[]> {
  return unwrap(await engine().query({ type: 'getHistory' })).entries.map((e) => e.label);
}
