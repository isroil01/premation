/**
 * F2 — keep this window's page REPLICA in step with the engine when ANOTHER
 * window edited it (docs/NATIVE_CORE_PLAN.md §5 Phase F2, inventory row
 * "windowSync (pop-out windows)").
 *
 * With the C++ engine as owner every window is a mirror of the same engine:
 * main relays the engine's events to the editor window and to each pop-out,
 * and a window's edits are engine requests. Each window's mirror follows the
 * events by itself. What does NOT follow is the page replica (the TypeScript
 * stores the editor still reads for gizmos, hit tests and page-side builders —
 * ownedEngineClient.ts): it is fed only the requests THIS window sent. So when
 * main marks a batch `foreign` (caused by another window), the replica is
 * refreshed from the owner's `exportDocument` — debounced, so a drag in the
 * pop-out costs one refresh when it settles, and invisible to undo (the
 * history lives in the engine; a restore records no entry).
 *
 * This replaces windowSync's whole-document BroadcastChannel push, whose source
 * was the editor window's page capture.
 *
 * No React (src/core).
 */

import type { EngineClient } from '@motion/engine-api';
import { restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { bumpScene } from '@stores/sceneStore';

/** Foreign edits settle before the document is fetched (windowSync's cadence). */
export const REPLICA_REFRESH_MS = 120;

export interface ReplicaRefresher {
  /** A foreign batch arrived: refresh once things settle. */
  schedule(): void;
  /** Refresh now (a pop-out's first document). Resolves when applied (false: nothing applied). */
  refreshNow(): Promise<boolean>;
  dispose(): void;
}

export interface ReplicaRefreshOptions {
  /** The owner (queries answer from the engine). */
  owner: () => EngineClient;
  /** Where the document lands (the page stores by default). */
  apply?: (doc: EditorDocument) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

function applyToPage(doc: EditorDocument): void {
  restoreDocument(doc);
  bumpScene();
}

export function createReplicaRefresher(o: ReplicaRefreshOptions): ReplicaRefresher {
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const apply = o.apply ?? applyToPage;
  let timer: unknown = null;
  let disposed = false;
  let inFlight: Promise<boolean> | null = null;
  let again = false;

  const refreshNow = async (): Promise<boolean> => {
    if (disposed) return false;
    if (inFlight) {
      again = true;  // one more after this one: the document moved on meanwhile
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const r = await o.owner().query({ type: 'exportDocument' });
        if (!r.ok || disposed) return false;
        apply(JSON.parse(new TextDecoder().decode(r.value.document)) as EditorDocument);
        return true;
      } catch {
        return false;  // the next foreign batch tries again
      } finally {
        inFlight = null;
        if (again && !disposed) {
          again = false;
          void refreshNow();
        }
      }
    })();
    return inFlight;
  };

  return {
    schedule() {
      if (disposed) return;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        void refreshNow();
      }, o.delayMs ?? REPLICA_REFRESH_MS);
    },
    refreshNow,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
