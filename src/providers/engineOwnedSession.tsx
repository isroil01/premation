/**
 * D5 / F2 — the editor session when the C++ ENGINE OWNS THE DOCUMENT
 * (the default since 2026-09-28; `PREMATION_ENGINE_OWNER=ui` or
 * `PREMATION_ENGINE=ts` keeps the TypeScript owner).
 *
 * What Providers wires instead of the TypeScript owner's pieces:
 *
 *   lifecycle     ProjectManager delegates New / Open / Save / Save As /
 *                 snapshot / Close to EngineDocumentSession (engine requests;
 *                 the engine reads and writes the files, temp + rename —
 *                 `.motion` bundles and Save Portable Copy's zip included).
 *   dirty dot     the active tab's unsaved flag follows `mirror.dirty` (the
 *                 engine's dirtyChanged), not the TypeScript bus traffic.
 *   autosave      every 60 s, `session.autosave()` — the engine writes a
 *                 recovery copy when the MIRROR says dirty.
 *   recovery      at boot, the engine's recovery record (not recovery.ts's
 *                 snapshot) is offered; Restore = `session.recover()` (one
 *                 undoable "Recover Unsaved Work" entry, still bound to its file).
 *   transport     play / pause / seek / the active comp go to the engine, whose
 *                 playhead drives the timeline (core/engine/engineTransport.ts).
 *   doc stores    guides / swatches / materials follow the mirror, and a user
 *                 edit to them is an engine command (stores/engineDocumentStores.ts).
 *
 * The first document is an engine `newProject`, sent through the owner so the
 * page's replica starts from the same empty document (ownedEngineClient.ts).
 */

import { EngineDocumentSession, type RecoveryFiles, type RecoveryIndex, type RecoveryRecord } from '@core/project/engineDocumentSession';
import { engine } from '@core/engine/engineInstance';
import { processEngine, processEngineBridge } from '@core/engine/process/processEngine';
import { installEngineTransport, type EngineTransportStats } from '@core/engine/engineTransport';
import { getProjectManager } from '@core/services/coreServices';
import { projectNameFromFilePath } from '@core/project/projectName';
import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { isLocalFirst } from '@core/config/flags';
import { documentMirror } from '@stores/documentMirror';
import { bindEngineDocumentStores } from '@stores/engineDocumentStores';
import { bindEngineComps, bindEngineItems } from '@stores/engineItemsView';
import { edit } from '@core/engine/uiEdits';
import { engineCanReadFootage, materializeUnreadableFootage } from '@core/engine/sessionFootage';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { openModal } from '@stores/modalStore';
import { bumpScene } from '@stores/sceneStore';
import { Button } from '@components/Button';

const RECOVERY_KEY = 'premation.engineRecovery.v1';
const AUTOSAVE_MS = 60_000;

/**
 * Rewrite session footage the engine cannot open, once per mirror update.
 * A relink lands another `items` update; that pass finds a disk path and stops.
 */
function watchSessionFootage(): () => void {
  let busy = false;
  let queued = false;
  const kick = (): void => {
    if (busy) {
      queued = true;
      return;
    }
    const ids = [...documentMirror().items.values()]
      .filter((item) => item.kind === 'footage' && !engineCanReadFootage(item.path))
      .map((item) => item.id);
    if (ids.length === 0) return;
    busy = true;
    void materializeUnreadableFootage(engine(), ids)
      .catch(() => { /* the item stays unreadable; the next items update retries */ })
      .finally(() => {
        busy = false;
        if (!queued) return;
        queued = false;
        kick();
      });
  };
  const stop = documentMirror().subscribe(['items'], kick);
  kick();
  return stop;
}

function notify(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 2600 });
}

/** The recovery record lives on this machine (editor state), like recent projects. */
const localRecoveryIndex: RecoveryIndex = {
  read(): RecoveryRecord | null {
    try {
      const raw = localStorage.getItem(RECOVERY_KEY);
      if (!raw) return null;
      const r = JSON.parse(raw) as Partial<RecoveryRecord>;
      if (typeof r.recoveryPath !== 'string' || typeof r.projectPath !== 'string') return null;
      return { recoveryPath: r.recoveryPath, projectPath: r.projectPath, savedAt: Number(r.savedAt) || 0, revision: Number(r.revision) || 0 };
    } catch {
      return null;
    }
  },
  write(record: RecoveryRecord | null): void {
    try {
      if (record) localStorage.setItem(RECOVERY_KEY, JSON.stringify(record));
      else localStorage.removeItem(RECOVERY_KEY);
    } catch {
      // storage unavailable: recovery is best effort
    }
  },
};

/** The recovery copy through the preload's file channel (an emptied file reads as gone). */
const preloadRecoveryFiles: RecoveryFiles = {
  async readText(path: string): Promise<string | null> {
    const file = (window as unknown as { motionEditor?: { file?: { read(p: string): Promise<string | null> } } }).motionEditor?.file;
    if (!file) return null;
    const text = await file.read(path);
    return text && text.trim() ? text : null;
  },
  async remove(path: string): Promise<void> {
    const file = (window as unknown as { motionEditor?: { file?: { write(p: string, c: string): Promise<void> } } }).motionEditor?.file;
    await file?.write(path, '');
  },
};

/** Keep the active tab's unsaved flag equal to the engine's (mirror.dirty). */
function syncDirtyFromMirror(): void {
  const m = documentMirror();
  const s = useProjectStore.getState();
  const id = s.activeTabId;
  if (!id || !s.tabs[id]) return;
  if ((s.tabs[id]!.dirty === true) !== m.dirty) s.actions.markDirty(id, m.dirty);
}

/**
 * Install the engine-owned session. Resolves once the first document is in
 * place (a fresh `newProject`, or the user's answer to the recovery prompt).
 * `track` receives every teardown.
 */
export async function installEngineOwnedSession(track: (dispose: () => void) => void): Promise<void> {
  let recoveryPath = '';
  try {
    recoveryPath = (await processEngineBridge()?.status())?.recoveryPath ?? '';
  } catch {
    recoveryPath = '';
  }
  const session = new EngineDocumentSession({
    engine: () => engine(),
    mirror: documentMirror(),
    recoveryPath,
    files: preloadRecoveryFiles,
    index: localRecoveryIndex,
    now: () => Date.now(),
    // F2 bundles: where the page would write a `.motion` directory bundle, the engine does.
    formatFor: (p) => (isLocalFirst() && isBundlePath(p) ? 'bundle' : 'auto'),
  });
  const pm = getProjectManager();
  pm.setEngineDocument(session);
  track(() => pm.setEngineDocument(null));

  // Transport through the engine.
  const transportStats: EngineTransportStats = { seeksSent: 0, seeksCoalesced: 0, playheadEvents: 0, plays: 0, pauses: 0, activeComp: '' };
  track(installEngineTransport(() => engine(), transportStats));
  // Read-only counters for the real-app harness (like __premationEngineSurface).
  (window as unknown as { __premationEngineTransport?: EngineTransportStats }).__premationEngineTransport = transportStats;

  // The unsaved indicator follows the engine.
  track(documentMirror().subscribe(['status', 'doc'], syncDirtyFromMirror));

  // F2: guides / swatches / materials are views of the engine's document; a
  // user edit to them is an undoable engine command (engineDocumentStores.ts).
  track(bindEngineDocumentStores({ mirror: documentMirror(), send: (label, cmd) => edit(label, cmd) }));
  // F2: the assets store's items half follows the engine's ItemInfo (session
  // fields stay the page's); the project store's compositions follow CompInfo.
  track(bindEngineItems(documentMirror()));
  track(bindEngineComps(documentMirror()));
  // Session blob:/data: footage is not a path the engine process can open.
  // Write it to the cache and relink as the mirror learns about the item, so
  // the viewport and jobs both see a file. A relink updates the mirror, which
  // runs this again; the second pass finds a disk path and stops.
  track(watchSessionFootage());
  let lastTab: string | null = null;
  track(useProjectStore.subscribe((s) => {
    if (s.activeTabId === lastTab) return;
    lastTab = s.activeTabId;
    syncDirtyFromMirror();
  }));

  // Autosave: the engine writes a recovery copy while the document is dirty.
  if (recoveryPath) {
    const timer = setInterval(() => { void session.autosave(); }, AUTOSAVE_MS);
    track(() => clearInterval(timer));
  }

  // The first document.
  await processEngine()?.whenReady();
  const pending = recoveryPath ? session.pendingRecovery() : null;
  if (pending) {
    offerRecovery(session, pending);
    return;
  }
  try {
    await session.newProject();
  } catch (err) {
    console.error('[engine] could not start a new project in the engine', err);
  }
  bumpScene();
}

function offerRecovery(session: EngineDocumentSession, rec: RecoveryRecord): void {
  const mins = Math.max(1, Math.round((Date.now() - rec.savedAt) / 60_000));
  const startFresh = async (): Promise<void> => {
    await session.discardRecovery();
    try {
      await session.newProject();
    } catch (err) {
      console.error('[engine] could not start a new project in the engine', err);
    }
    bumpScene();
  };
  openModal({
    id: 'recovery-modal',
    title: 'Recover unsaved work?',
    size: 'sm',
    render: () => (
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-md)', lineHeight: 1.6 }}>
        Premation found unsaved changes from your last session
        (about {mins} min ago{rec.projectPath ? `, in “${projectNameFromFilePath(rec.projectPath)}”` : ''}).
        Restore them, or discard and start fresh.
      </div>
    ),
    footer: (close) => (
      <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={() => { close(); void startFresh(); }}>Discard</Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            close();
            void (async () => {
              let ok = false;
              try {
                ok = await session.recover();
              } catch (err) {
                console.error('[engine] recovery failed', err);
              }
              if (!ok) {
                notify('The unsaved session could not be restored', 'warning');
                await startFresh();
                return;
              }
              // Bound to its file again: Save writes back to it (no ProjectLoaded, no recent entry).
              const path = rec.projectPath || null;
              getProjectManager().resume(path ? projectNameFromFilePath(path) : 'Untitled', path);
              bumpScene();
              syncDirtyFromMirror();
              notify('Session recovered', 'success');
            })();
          }}
        >
          Restore
        </Button>
      </div>
    ),
  });
}
