/**
 * Crash recovery.
 *
 * A recovery snapshot is a non-destructive copy of the editable state (scene +
 * animation + playhead) written to persistent storage by the autosave loop.
 * On next launch, if one exists, the app offers to restore the exact session.
 * Source assets are never touched — restoring only swaps in-memory state.
 *
 * ── Where the work happens ───────────────────────────────────────────────
 * Capture is main-thread (it reads the live engines) and is scheduled into an
 * idle period by `AutosaveController`. Serialisation and compression run in
 * `recovery.worker.ts`, which also answers "unchanged" for a document identical
 * to the last one written. Storage is the append-only ring in
 * `recoveryStore.ts`: one new body plus a small index per write.
 */

import {  getSettingsManager } from '@core/services/coreServices';
import {   type EditorDocument } from '@core/api/cloudDocument';
import { type AnimSnapshot } from '@motion/animation';
import type { ProjectFile } from '@core/types';
import {
  RecoverySerializer,
  decodeRecoveryBody,
  type RecoveryJob,
  type RecoveryJobResult,
} from './recoverySerializer';
import {
  appendRecoverySnapshot,
  clearRecoveryLatest,
  localStorageKV,
  readRecoveryIndex,
  recoveryBodyKey,
  touchRecoveryLatest,
  type RecoveryIndexEntry,
  type RecoveryKV,
} from './recoveryStore';

/** Pre-ring builds: the newest snapshot, as a settings value. Read, then retired. */
const KEY = 'recovery';

export interface RecoverySnapshot {
  projectId?: string;
  savedAt: number;
  time: number;
  /** Full document (v1.1+). Older snapshots carry only `scene`/`anim`. */
  doc?: EditorDocument;
  scene: ProjectFile;
  anim: AnimSnapshot;
  /**
   * The desktop project the document belonged to, so a restore can bind it
   * back to its file and Save writes where it came from. Absent for a cloud
   * project (the route id is its identity) and for a scratch scene.
   */
  project?: { name: string; path: string | null };
}

/**
 * Identity for a document with no project at all ("Continue without a
 * project"). Stable, so every tick of one scratch session lands in the same
 * ring slot instead of looking like a new project each time.
 */
export const SCRATCH_PROJECT_ID = 'scratch';

// ── Keep-N ring + folder copy (Preferences ▸ Files) ──────────────────────
//
// The index's `latest` is what the launch-time recovery offer reads. The ring
// behind it keeps the last N so a snapshot that captured a mistake is not the
// only one there is; and a folder, when the user names one on the desktop,
// receives a JSON copy of each write so an autosave survives a wiped store too.

const RING_KEY = 'recovery.ring';
export const AUTOSAVE_KEEP_MIN = 1;
export const AUTOSAVE_KEEP_MAX = 50;

/** The preference store, reached lazily (this module is on the boot path). */
function autosavePrefs(): { keep: number; location: string | null } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy seam: this module is on the boot path, see layoutStore.ts
    const { usePreferenceStore } = require('@stores/preferenceStore') as typeof import('@stores/preferenceStore');
    const s = usePreferenceStore.getState();
    const keep = typeof s.autosaveKeep === 'number' && Number.isFinite(s.autosaveKeep)
      ? Math.min(AUTOSAVE_KEEP_MAX, Math.max(AUTOSAVE_KEEP_MIN, Math.round(s.autosaveKeep)))
      : 5;
    return { keep, location: typeof s.autosaveLocation === 'string' && s.autosaveLocation ? s.autosaveLocation : null };
  } catch {
    return { keep: 5, location: null };
  }
}

let kvOverride: RecoveryKV | null | undefined;

function recoveryKV(): RecoveryKV | null {
  return kvOverride !== undefined ? kvOverride : localStorageKV();
}

// ── The writer: worker when there is one, inline when there is not ───────

/** The slice of `Worker` the writer uses — a seam for tests. */
export interface RecoveryWorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((e: { data: RecoveryJobResult }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}
type WorkerLike = RecoveryWorkerLike;

export type RecoveryWorkerFactory = () => WorkerLike | null | Promise<WorkerLike | null>;
type WorkerFactory = RecoveryWorkerFactory;

interface JobMeta {
  projectId: string;
  savedAt: number;
  time: number;
}

type Writer = 'main' | 'worker';

const defaultWorkerFactory: WorkerFactory = async () => {
  if (typeof Worker === 'undefined') return null;
  const { spawnRecoveryWorker } = await import('./spawnRecoveryWorker');
  return spawnRecoveryWorker() as unknown as WorkerLike;
};

/** null = no worker: serialise inline. */
let workerFactory: WorkerFactory | null = defaultWorkerFactory;
let worker: WorkerLike | null = null;
let workerState: 'idle' | 'spawning' | 'ready' | 'unavailable' = 'idle';
/** Jobs posted before the worker finished loading — already private copies. */
let spawnQueue: RecoveryJob[] = [];
const inflight = new Map<number, JobMeta>();
let settleWaiters: Array<() => void> = [];
const mainSerializer = new RecoverySerializer();
let seq = 0;
/** Highest job whose result reached storage; older results are stale. */
let committedSeq = 0;
/**
 * Which serializer's memory of "the last content" is what `latest` holds. An
 * `unchanged` answer is only trusted from that one; any other job is forced.
 */
let inSyncWriter: Writer | null = null;
let ringSlot = 0;
let legacyRetired = false;
/** The decoded latest snapshot, so the two boot-time reads decode once. */
let decodedMemo: { id: string; snap: RecoverySnapshot } | null = null;

function settleIfIdle(): void {
  if (inflight.size > 0 || spawnQueue.length > 0 || workerState === 'spawning') return;
  const waiters = settleWaiters;
  settleWaiters = [];
  for (const w of waiters) w();
}

function entryId(savedAt: number): string {
  return `${Math.max(0, Math.floor(savedAt)).toString(36)}-${(seq >>> 0).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Retire the settings-store snapshots once the ring holds a newer one. */
function retireLegacySnapshots(): void {
  if (legacyRetired) return;
  try {
    const settings = getSettingsManager();
    if (settings.has(KEY)) settings.delete(KEY);
    if (settings.has(RING_KEY)) settings.delete(RING_KEY);
    legacyRetired = true;
  } catch {
    /* not booted — try again on the next write */
  }
}

function commit(result: RecoveryJobResult, meta: JobMeta, writer: Writer): void {
  // A newer write already landed (the window-close write overtook a worker job).
  if (result.seq <= committedSeq) return;
  const kv = recoveryKV();
  if (result.status === 'error' || !kv) {
    if (inSyncWriter === writer) inSyncWriter = null;
    return;
  }
  if (result.status === 'unchanged') {
    // Only true of storage if this serializer wrote what `latest` holds; if
    // not, write nothing now and force the next job.
    if (inSyncWriter === writer) {
      committedSeq = result.seq;
      touchRecoveryLatest(kv, meta.savedAt);
    }
    return;
  }
  committedSeq = result.seq;
  const entry: RecoveryIndexEntry = { id: entryId(meta.savedAt), projectId: meta.projectId, savedAt: meta.savedAt, time: meta.time };
  const ok = appendRecoverySnapshot(kv, entry, result.body, autosavePrefs().keep);
  inSyncWriter = ok ? writer : null;
  decodedMemo = null;
  if (ok) retireLegacySnapshots();
  if (result.folderJson) void copyToFolder(meta.projectId, result.folderJson);
}

function runInline(job: RecoveryJob, meta: JobMeta): void {
  commit(mainSerializer.run({ ...job, force: job.force || inSyncWriter !== 'main' }), meta, 'main');
}

function workerFailed(): void {
  worker?.terminate();
  worker = null;
  workerState = 'unavailable';
  // The worker's memory of the last content died with it; results never
  // arrive for what was in flight, and those ticks are simply missed.
  if (inSyncWriter === 'worker') inSyncWriter = null;
  inflight.clear();
  const queued = spawnQueue;
  spawnQueue = [];
  for (const job of queued) runInline(job, metaOf(job.snap));
  settleIfIdle();
}

function metaOf(snap: RecoverySnapshot): JobMeta {
  return { projectId: snap.projectId ?? 'project', savedAt: snap.savedAt, time: snap.time };
}

function post(job: RecoveryJob): void {
  if (!worker) return;
  inflight.set(job.seq, metaOf(job.snap));
  try {
    worker.postMessage({ ...job, force: job.force || inSyncWriter !== 'worker' });
  } catch {
    // An uncloneable document: this tick is written inline instead.
    inflight.delete(job.seq);
    runInline(job, metaOf(job.snap));
  }
}

function startWorker(): void {
  workerState = 'spawning';
  void (async () => {
    let w: WorkerLike | null = null;
    try {
      w = workerFactory ? await workerFactory() : null;
    } catch {
      w = null;
    }
    if (!w) {
      workerFailed();
      return;
    }
    w.onmessage = (e) => {
      const result = e.data;
      const meta = inflight.get(result.seq);
      if (!meta) return;
      inflight.delete(result.seq);
      commit(result, meta, 'worker');
      settleIfIdle();
    };
    w.onerror = () => workerFailed();
    worker = w;
    workerState = 'ready';
    const queued = spawnQueue;
    spawnQueue = [];
    for (const job of queued) post(job);
    settleIfIdle();
  })();
}

/**
 * Persist a snapshot.
 *
 * By default the write is asynchronous: the document is copied into the worker
 * now (so later edits cannot reach it) and stored when the worker answers.
 * `sync` does all of it before returning — for the window closing, where there
 * is no later. `force` writes even an unchanged document (Autosave now).
 */
export function persistRecovery(
  snap: RecoverySnapshot | null,
  opts: { sync?: boolean; force?: boolean } = {},
): void {
  if (!snap || !snap.projectId) return;
  const job: RecoveryJob = { seq: ++seq, snap, force: !!opts.force, folder: autosavePrefs().location !== null };

  // No Worker at all (Jest, an old runtime): inline from the first write rather
  // than after a failed asynchronous spawn.
  if (workerState === 'idle' && (workerFactory === null || (workerFactory === defaultWorkerFactory && typeof Worker === 'undefined'))) {
    workerState = 'unavailable';
  }
  if (opts.sync || workerState === 'unavailable') {
    runInline(opts.sync ? { ...job, force: true } : job, metaOf(snap));
    return;
  }
  if (workerState === 'ready') {
    post(job);
    return;
  }
  // Loading: keep a private copy until it can be posted.
  let copy: RecoverySnapshot;
  try {
    copy = structuredClone(snap);
  } catch {
    runInline(job, metaOf(snap));
    return;
  }
  spawnQueue.push({ ...job, snap: copy });
  if (workerState === 'idle') startWorker();
}

/** Resolves once every submitted snapshot has been stored (or dropped). */
export function whenRecoveryWritesSettled(): Promise<void> {
  return new Promise((resolve) => {
    settleWaiters.push(resolve);
    settleIfIdle();
  });
}

/**
 * Tests: swap the storage and/or worker, resetting the writer. An omitted
 * field restores the default; `workerFactory: null` means "no worker".
 */
export function configureRecoveryForTests(opts: { storage?: RecoveryKV | null; workerFactory?: WorkerFactory | null }): void {
  kvOverride = opts.storage;
  workerFactory = opts.workerFactory === undefined ? defaultWorkerFactory : opts.workerFactory;
  worker?.terminate();
  worker = null;
  workerState = 'idle';
  spawnQueue = [];
  inflight.clear();
  committedSeq = seq;
  inSyncWriter = null;
  legacyRetired = false;
  decodedMemo = null;
  ringSlot = 0;
}

/** Where the folder copy of a snapshot goes: a slot that wraps at keep-N. */
export function autosaveFileName(projectId: string, slot: number): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return `${safe}-autosave-${slot}.json`;
}

interface FolderBridge {
  file?: { write?: (path: string, contents: string) => Promise<void> };
  bundle?: { writeAtomic?: (root: string, name: string, contents: string) => Promise<void> };
}

async function copyToFolder(projectId: string, json: string): Promise<void> {
  const { keep, location } = autosavePrefs();
  if (!location) return;
  const bridge = typeof window !== 'undefined'
    ? (window as unknown as { motionEditor?: FolderBridge }).motionEditor
    : undefined;
  const atomic = bridge?.bundle?.writeAtomic;
  const write = bridge?.file?.write;
  if (!atomic && !write) return;
  const slot = ringSlot++ % keep;
  const root = location.replace(/[\\/]+$/, '');
  const name = autosaveFileName(projectId, slot);
  try {
    if (atomic) {
      // Temp file + rename: a crash mid-write leaves that slot's previous copy
      // whole instead of a truncated JSON file.
      await atomic(root, name, json);
    } else if (write) {
      const sep = location.includes('\\') ? '\\' : '/';
      await write(`${root}${sep}${name}`, json);
    }
  } catch {
    /* an unwritable folder must not stop the in-app snapshot, which already landed */
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

function isOfferable(v: RecoverySnapshot | null | undefined): v is RecoverySnapshot {
  return !!v && typeof v.savedAt === 'number' && !!v.scene && typeof v.projectId === 'string' && v.projectId.trim() !== '';
}

function loadEntry(kv: RecoveryKV, e: RecoveryIndexEntry): RecoverySnapshot | null {
  let snap: RecoverySnapshot | null;
  if (decodedMemo && decodedMemo.id === e.id) {
    snap = decodedMemo.snap;
  } else {
    let body: string | null = null;
    try { body = kv.getItem(recoveryBodyKey(e.id)); } catch { body = null; }
    snap = decodeRecoveryBody(body);
    if (!snap) return null;
    decodedMemo = { id: e.id, snap };
  }
  // The index carries the authoritative stamp (an unchanged tick re-stamps it).
  return { ...snap, projectId: e.projectId, savedAt: e.savedAt };
}

function legacySettingsValue<T>(key: string, fallback: T): T {
  try {
    return getSettingsManager().get<T>(key, fallback);
  } catch {
    return fallback;
  }
}

/** Every kept snapshot, newest first. */
export function readRecoveryRing(): RecoverySnapshot[] {
  const kv = recoveryKV();
  const index = kv ? readRecoveryIndex(kv) : null;
  if (kv && index) {
    const out: RecoverySnapshot[] = [];
    for (const e of index.entries) {
      let body: string | null = null;
      try { body = kv.getItem(recoveryBodyKey(e.id)); } catch { body = null; }
      const snap = decodeRecoveryBody(body);
      if (snap) out.push({ ...snap, projectId: e.projectId, savedAt: e.savedAt });
    }
    return out;
  }
  const v = legacySettingsValue<RecoverySnapshot[] | null>(RING_KEY, null);
  return Array.isArray(v) ? v.filter((r) => r && typeof r.savedAt === 'number') : [];
}

export function readRecovery(): RecoverySnapshot | null {
  const kv = recoveryKV();
  const index = kv ? readRecoveryIndex(kv) : null;
  if (kv && index) {
    if (index.latest === null) return null;
    const start = index.entries.findIndex((e) => e.id === index.latest);
    if (start < 0) return null;
    // Newest first from `latest`: a body that is missing or unreadable (a crash
    // mid-write, an eviction) falls back to the snapshot before it rather than
    // to no recovery at all.
    for (let i = start; i < index.entries.length; i++) {
      const snap = loadEntry(kv, index.entries[i]!);
      if (isOfferable(snap)) return snap;
    }
    return null;
  }
  // Written by a build that kept the snapshot in settings.
  const v = legacySettingsValue<RecoverySnapshot | null>(KEY, null);
  return isOfferable(v) ? v : null;
}

export function clearRecovery(): void {
  decodedMemo = null;
  // The offer is gone, so an unchanged document must be written again next time.
  inSyncWriter = null;
  try {
    const kv = recoveryKV();
    if (kv) clearRecoveryLatest(kv);
  } catch {
    /* no storage — nothing on offer */
  }
  // The dashboard calls this BEFORE the editor boots (Create & Launch), when
  // core services aren't registered yet — there is nothing to clear then, and
  // throwing here broke the entire launch flow.
  try {
    getSettingsManager().delete(KEY);
  } catch {
    /* app not booted — no settings, so no snapshot to clear */
  }
}
