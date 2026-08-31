/**
 * windowSync — makes a popped-out panel a LIVE VIEW of the main editor.
 *
 * `syncChannel` already provided the transport (BroadcastChannel in the browser,
 * Electron IPC on the desktop) but nothing ever called `publish`, and
 * PopoutRoute's two subscribers had empty bodies. A pop-out window therefore
 * booted its own realm, ran `seedDefaultScene` into its OWN scene graph, and
 * showed a completely different composition from the one you detached it from —
 * which makes the whole second-monitor workflow useless.
 *
 * This module wires both directions:
 *
 *   main  ──doc/selection/time──▶  popout      (main is the source of truth)
 *   main  ◀──doc/selection/time──  popout      (edits made in the pop-out apply back)
 *
 * The document is sent whole (`captureDocument`/`restoreDocument` — the same pair
 * autosave and the cloud use) rather than as a diff. That is heavier per message
 * but it is the only representation guaranteed to round-trip every subsystem, and
 * it cannot drift: a dropped message just means the next one re-syncs everything.
 * Sends are debounced so a drag publishes once when it settles, not per tick.
 *
 * Echo control: `syncChannel` drops messages from the sender's own window id, and
 * `applying` suppresses the re-publish that applying a remote document would
 * otherwise trigger through the scene/animation events.
 */

import { syncChannel } from './syncChannel';
import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { useHistoryStore } from '@stores/historyStore';
import { getEventBus } from '@core/events/EventBus';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';

/** This window renders a detached panel, not the editor shell. */
export function isPopoutWindow(): boolean {
  return typeof window !== 'undefined' && window.location.hash.startsWith('#/popout/');
}

const MSG_DOC = 'doc';
const MSG_DOC_REQUEST = 'doc-request';
const MSG_SELECTION = 'selection-update';
const MSG_TIME = 'time-update';

/** Scene/animation edits settle before we serialize the whole document. */
const DOC_DEBOUNCE_MS = 120;
/** The playhead moves 60×/s; a detached view does not need every tick. */
const TIME_THROTTLE_MS = 60;

interface TimePayload {
  time: number;
  frame: number;
}

/**
 * Start syncing this window with the others. Returns a teardown function.
 * Safe to call in any window; both roles publish and both apply.
 */
export function startWindowSync(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  /** True while we are writing a remote change into local state. */
  let applying = false;
  let docTimer: number | null = null;
  let lastTimeSent = 0;
  let disposed = false;

  const publishDoc = (): void => {
    if (applying || disposed) return;
    try {
      syncChannel.publish<EditorDocument>(MSG_DOC, captureDocument());
    } catch {
      /* a half-built document during boot is not worth breaking the editor for */
    }
  };

  const scheduleDoc = (): void => {
    if (applying || disposed) return;
    if (docTimer !== null) window.clearTimeout(docTimer);
    docTimer = window.setTimeout(() => {
      docTimer = null;
      publishDoc();
    }, DOC_DEBOUNCE_MS);
  };

  // ── Outbound ────────────────────────────────────────────────────
  const subs = [
    getEventBus().on('SceneGraphChanged', scheduleDoc),
    // Media decode repaints carry no document change — publishing one to
    // the other window is a whole-document serialize per decoded frame.
    getEventBus().on('AnimationChanged', (p) => { if (!isMediaDecodeRepaint(p)) scheduleDoc(); }),
    getEventBus().on('NodeUpdated', scheduleDoc),
  ];

  const unsubSelection = useSelectionStore.subscribe((state, prev) => {
    if (applying || state.ids === prev.ids) return;
    syncChannel.publish<readonly string[]>(MSG_SELECTION, [...state.ids]);
  });

  const unsubTime = useProjectStore.subscribe((state, prev) => {
    if (applying) return;
    const id = state.activeTabId;
    if (!id) return;
    const now = state.tabs[id]?.time;
    const before = prev.activeTabId === id ? prev.tabs[id]?.time : undefined;
    if (now === undefined || now === before) return;
    const stamp = performance.now();
    if (stamp - lastTimeSent < TIME_THROTTLE_MS) return;
    lastTimeSent = stamp;
    syncChannel.publish<TimePayload>(MSG_TIME, { time: now, frame: state.tabs[id]?.frame ?? 0 });
  });

  // ── Inbound ─────────────────────────────────────────────────────
  const offDoc = syncChannel.subscribe<EditorDocument>(MSG_DOC, (doc) => {
    if (!doc) return;
    applying = true;
    try {
      // `runRestoring` as well as `applying`: the first stops this window from
      // re-broadcasting, the second stops history from recording a document
      // that arrived from ANOTHER window as a local edit. Without it, every
      // sync push became an undo step, and undoing it would have shoved the
      // other window's older document back over the user's work.
      useHistoryStore.getState().runRestoring(() => {
        restoreDocument(doc);
        bumpScene();
      });
    } finally {
      // Release on the next macrotask: restoreDocument's own store writes emit
      // events synchronously, and those must not be mistaken for local edits.
      window.setTimeout(() => { applying = false; }, 0);
    }
  });

  // A window that just opened has an empty (or seeded) scene and asks for the
  // current one. Everyone answers; the asker keeps whichever arrives.
  const offDocRequest = syncChannel.subscribe(MSG_DOC_REQUEST, () => {
    if (isPopoutWindow()) return; // only the editor shell is authoritative
    publishDoc();
  });

  const offSelection = syncChannel.subscribe<readonly string[]>(MSG_SELECTION, (ids) => {
    if (!Array.isArray(ids)) return;
    applying = true;
    try {
      useSelectionStore.getState().set(ids as string[]);
    } finally {
      window.setTimeout(() => { applying = false; }, 0);
    }
  });

  const offTime = syncChannel.subscribe<TimePayload>(MSG_TIME, (p) => {
    if (!p || typeof p.time !== 'number') return;
    applying = true;
    try {
      useProjectStore.getState().actions.setTime(p.time, p.frame);
    } finally {
      window.setTimeout(() => { applying = false; }, 0);
    }
  });

  return () => {
    disposed = true;
    if (docTimer !== null) window.clearTimeout(docTimer);
    for (const s of subs) s.dispose();
    unsubSelection();
    unsubTime();
    offDoc();
    offDocRequest();
    offSelection();
    offTime();
  };
}

/** Ask the editor shell for the current document (called by a fresh pop-out). */
export function requestDocumentSync(): void {
  syncChannel.publish(MSG_DOC_REQUEST, {});
}
