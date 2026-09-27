/**
 * One undo entry for a multi-domain operation.
 *
 * Split solved one-bar edits by hand-writing an exact inverse
 * (`TimelineController.splitLayerAtFrame`). That works
 * for one bar. It does not work for an ASSEMBLY — create a comp, insert eight
 * clips, split at forty cuts, delete the runts, sequence the survivors and
 * write crossfades — where the inverse is not a small edit but "the project as
 * it was", and where a third domain (the comp table and its tab) joins in.
 *
 * So this takes the other route: capture the whole editor document before and
 * after, and push ONE command that swaps between them. `captureDocument` is
 * already the save format — scene, animation, comps, timelines, tabs, guides —
 * which is exactly the set an assembly touches, and it is the only capture in
 * the app that includes clip geometry (the scene snapshot does not).
 *
 * It is heavier than a targeted inverse, and deliberately so: it is reserved
 * for operations a user thinks of as ONE act but which no small diff describes.
 * Do not reach for it to move a keyframe.
 *
 * ## What must hold while `fn` runs
 *
 * The engine history is SUSPENDED, so the split/delete/sequence commands
 * underneath do not each become their own undo step; it resumes in a
 * `finally`. `fn` may be async (it can span an `await insertMedia(...)`).
 */

import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { HistoryService } from '@core/commands/HistoryService';
import { bumpScene } from '@stores/sceneStore';
import { internDocumentParts, noteRestoredState } from '@core/commands/snapshotSharing';
import { liveDocumentFromEngine, replaceLiveDocument } from '@core/project/liveDocument';

/**
 * F2: with the ENGINE as owner the page's stores are its replica, and the undo
 * stack is the engine's. The operation still runs against the replica (these
 * builders are page-side automation until B5 moves them onto the API); what it
 * produced lands in the owner as ONE `restoreDocument` entry labelled `label`
 * — undoable there, and the replica receives the same request (a no-op, it is
 * already that document). Nothing is pushed on the page's history.
 */
function landInOwner(label: string): void {
  const after = captureDocument();
  void replaceLiveDocument(after, label).catch((err: unknown) => {
    console.error(`[F2] "${label}" could not be applied to the engine's document`, err);
  });
}

/**
 * `captureDocument`, with its scene and animation re-expressed in the shared
 * form history snapshots use — unchanged nodes and tracks are the objects the
 * neighbouring entries already hold. Same content; see `snapshotSharing.ts`.
 */
function captureShared(): EditorDocument {
  return internDocumentParts(captureDocument());
}

/** The app history service, or null in a headless context that has no CommandSystem. */
function historyService(): HistoryService | null {
  try {
    return getCommandSystem().getHistory();
  } catch {
    return null;
  }
}

function restore(doc: EditorDocument): void {
  // Cloned per restore: `restoreDocument` hands these objects to the stores,
  // which then own and mutate them. Handing over the same instance twice would
  // make the second undo restore a document the first one had since edited.
  restoreDocument(structuredClone(doc));
  // The live scene now matches `doc`, so the next capture can share with it.
  noteRestoredState(doc.scene, doc.animation);
  bumpScene();
}

/**
 * Run `fn` and record it as a single undoable step labelled `label`.
 *
 * Returns whatever `fn` returned. Nothing is pushed when `fn` throws — the
 * partial state is left as it is (there is no half-assembly worth an undo
 * entry), and the error propagates to the caller, which owns the message.
 */
export async function runAsOneHistoryEntry<T>(
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const toOwner = liveDocumentFromEngine();
  const before = toOwner ? null : captureShared();
  const history = historyService();

  history?.suspend();
  let result: T;
  try {
    result = await fn();
  } finally {
    history?.resume();
  }

  if (toOwner || !before) {
    landInOwner(label);
    return result;
  }
  const after = captureShared();
  history?.push({
    label,
    // The restore must not push entries of its own: suspended around it.
    execute: () => {
      history?.suspend();
      try {
        restore(after);
      } finally {
        history?.resume();
      }
    },
    undo: () => {
      history?.suspend();
      try {
        restore(before);
      } finally {
        history?.resume();
      }
    },
  });
  return result;
}

/**
 * `runAsOneHistoryEntry` for a SYNCHRONOUS edit, with every flag restored
 * before this returns.
 *
 * The async version resumes the engine history in a `finally` that runs after
 * an `await` — a microtask later even when `fn` is
 * synchronous. Anything that continues synchronously in the same task (a
 * second control edited in the same turn, a test driving controls in a loop)
 * then runs with history recording off, and records nothing. A synchronous
 * edit — Time Stretch from the dialog or the inspector field — has no reason
 * to leave that gap.
 */
export function runAsOneHistoryEntrySync<T>(label: string, fn: () => T): T {
  const toOwner = liveDocumentFromEngine();
  const before = toOwner ? null : captureShared();
  const history = historyService();

  history?.suspend();
  let result: T;
  try {
    result = fn();
  } finally {
    history?.resume();
  }

  if (toOwner || !before) {
    landInOwner(label);
    return result;
  }
  const after = captureShared();
  const swapTo = (doc: EditorDocument): void => {
    history?.suspend();
    try {
      restore(doc);
    } finally {
      history?.resume();
    }
  };
  history?.push({ label, execute: () => swapTo(after), undo: () => swapTo(before) });
  return result;
}
