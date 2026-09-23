/**
 * One prompt, one undo entry — as an ENGINE GESTURE (NATIVE_CORE_PLAN §5 B5,
 * ENGINE_API.md §12).
 *
 * A single request ("make the title fade in and rise, then pulse") fans out
 * into dozens of tool calls. To the user that was *one act*, so pressing undo
 * once must put everything back. The turn therefore runs inside ONE engine
 * gesture labelled after it (`beginGesture('AI: …')`, origin `ai`): every
 * command a tool sends lands in it, the canvas animates as the model works,
 * and `commit` closes it as one history entry that the command log can replay
 * against either engine. `rollback` is the engine's own cancel
 * (`endGesture{commit:false}`), which reverts every edit of the gesture.
 *
 * A turn whose tools had to write AROUND the engine (a named legacy gap, or a
 * write the engine noticed and resynced) cannot be expressed as that gesture.
 * It still commits as ONE entry — the pre-engine whole-document snapshot — so
 * the user sees no difference; it is just not replayable from the log. The
 * outcome says which (`kind: 'engine' | 'snapshot' | 'empty'`).
 */

import type { EngineClient, Origin } from '@motion/engine-api';
import { StoreSnapshotCommand, restoreSnapshotState, useHistoryStore } from '@stores/historyStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { bumpScene } from '@stores/sceneStore';
import { captureSharedState, statesEqual, type DocState } from '@core/commands/snapshotSharing';
import { engine } from '@core/engine/engineInstance';
import { EngineTurnSession } from './aiEngineSession';

/**
 * Scene + animation (+ clip geometry under the unified history), structurally
 * shared with every other history snapshot — so a snapshot entry restores the
 * timeline too, and a long session does not hold a document per step.
 */
const capture = (): DocState => captureSharedState();

/** The store's own restore path: clones, restores every half, re-baselines. */
const restore = (s: DocState): void => restoreSnapshotState(s);

export interface AiTurnOutcome {
  /**
   * `engine`   one engine history entry (replayable from the command log);
   * `snapshot` one whole-document snapshot entry (a legacy gap was hit);
   * `empty`    nothing changed, no entry.
   */
  kind: 'engine' | 'snapshot' | 'empty';
  /** The legacy gaps that forced a snapshot (empty for `engine`). */
  gaps: readonly string[];
}

export interface AiTransaction {
  /** The session every tool of the turn writes through. */
  readonly session: EngineTurnSession;
  readonly label: string;
  /** Push one undo entry covering everything the run changed. Idempotent. */
  commit(): Promise<AiTurnOutcome>;
  /** Put the document back as it was. Idempotent. */
  rollback(): Promise<void>;
}

export interface BeginTurnOptions {
  /** Default: the app engine. */
  client?: EngineClient;
  /** Default `ai`; scripts pass `script`. */
  origin?: Origin;
}

/** How long a turn waits for a user's drag to finish before it opens (ms). */
const GESTURE_WAIT_MS = 2000;

async function openGesture(client: EngineClient, label: string, origin: Origin): Promise<number | null> {
  const deadline = Date.now() + GESTURE_WAIT_MS;
  for (;;) {
    const res = await client.beginGesture(label, { origin });
    if (res.ok) return res.value.gesture;
    // A drag in progress owns the one gesture slot: wait for it rather than
    // steal it (committing the user's half-finished drag would be a lie).
    if (res.error.code !== 'gestureOpen' || Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Begin an AI turn (or a script run: `origin: 'script'`).
 *
 * Call `commit` when the run finishes and `rollback` if it throws or the user
 * cancels — a half-applied AI edit is worse than none, because the user can't
 * tell which half landed.
 */
export async function beginAiTransaction(label: string, opts: BeginTurnOptions = {}): Promise<AiTransaction> {
  const client = opts.client ?? engine();
  const origin = opts.origin ?? 'ai';
  // A sync point first: the engine builds its lazy timeline mirror and resyncs
  // any write made around it BEFORE the turn, so neither is the turn's.
  await client.batch('', [], { origin });
  const before = capture();
  const gesture = await openGesture(client, label, origin);
  const session = new EngineTurnSession(client, origin);
  // Watch AFTER the gesture opened: a stale write from before the turn is
  // resynced by beginGesture itself and is not this turn's.
  session.watch();
  // No gesture (a drag never finished): every engine write of the turn would be
  // its own entry, so the whole turn is a snapshot turn instead.
  if (gesture === null) session.legacy('no gesture slot (a drag was still open)');

  // Other subsystems push their own commands as a side effect of work the run
  // triggers — lazily booting a comp's timeline emits an "Add Track", for
  // instance. Those are noise here: the turn's entry covers everything, so a
  // stray entry would just be a second undo step that half-undoes the run.
  // Engine edits inside the gesture push nothing until endGesture, which runs
  // after `resume`.
  const history = getCommandSystem().getHistory();
  history.suspend();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    history.resume();
  };
  let settled: Promise<AiTurnOutcome> | null = null;

  /**
   * Legacy writes schedule the 700 ms debounce recorder. Settle it while
   * history is still suspended (its entry is dropped: the turn's own entry
   * covers the same change) — released first, it would land as a stray
   * "Edit N" beside the turn. The snapshot restore then re-baselines it.
   */
  const settleRecorder = (): void => {
    if (released) history.suspend();
    released = false;
    useHistoryStore.getState().flush();
  };

  const snapshotCommit = async (gestureOpen: boolean): Promise<AiTurnOutcome> => {
    settleRecorder();
    const after = capture();
    // The engine's share goes back first (its own cancel); the snapshot then
    // reinstates the whole finished document, legacy writes included.
    if (gesture !== null && gestureOpen) await client.endGesture(gesture, false, { origin });
    restore(after);
    release();
    if (statesEqual(before, after)) return { kind: 'empty', gaps: session.legacyGaps };
    history.push(new StoreSnapshotCommand(label, before, after));
    bumpScene();
    return { kind: 'snapshot', gaps: session.legacyGaps };
  };

  const commit = async (): Promise<AiTurnOutcome> => {
    // A sync point: the engine resyncs (and the session hears it) before any
    // command if something wrote around it since the last one.
    await client.batch('', [], { origin });
    try {
      if (gesture !== null && session.legacyGaps.length === 0) {
        release();
        const top = (): unknown => history.getEntries()[history.getIndex()];
        const was = top();
        const res = await client.endGesture(gesture, true, { origin });
        if (res.ok) return { kind: top() !== was ? 'engine' : 'empty', gaps: [] };
        // The gesture was closed under the turn (a leaked-gesture recovery):
        // its entry went to the suspended history, so fall back.
        session.legacy(`the turn's gesture was closed by another client (${res.error.code})`);
        return await snapshotCommit(false);
      }
      return await snapshotCommit(true);
    } finally {
      session.dispose();
    }
  };

  const rollback = async (): Promise<void> => {
    try {
      settleRecorder();
      if (gesture !== null) await client.endGesture(gesture, false, { origin });
      if (gesture === null || session.legacyGaps.length > 0) restore(before);
    } finally {
      release();
      session.dispose();
    }
  };

  return {
    session,
    label,
    commit(): Promise<AiTurnOutcome> {
      settled ??= commit();
      return settled;
    },
    async rollback(): Promise<void> {
      if (settled) {
        await settled;
        return;
      }
      settled = rollback().then(() => ({ kind: 'empty' as const, gaps: session.legacyGaps }));
      await settled;
    },
  };
}

/**
 * The one-act-one-undo SNAPSHOT transaction for non-AI bulk document builders
 * (file import, captions, auto-reframe) — synchronous, pre-engine, unchanged.
 *
 * These are core-side document builders, not engine clients yet (report B5:
 * they are the next automation clients to move onto the API). A Lottie import
 * without it was effectively un-undoable: 25 presses to walk a 23-layer import
 * back.
 */
export interface DocumentTransaction {
  commit(): void;
  rollback(): void;
}

export function beginDocumentTransaction(label: string): DocumentTransaction {
  const before = capture();
  let settled = false;
  const history = getCommandSystem().getHistory();
  history.suspend();
  const release = (): void => history.resume();

  return {
    commit(): void {
      if (settled) return;
      settled = true;
      release();
      const after = capture();
      // A read-only run must not litter the undo stack with a no-op entry.
      if (statesEqual(before, after)) return;
      history.push(new StoreSnapshotCommand(label, before, after));
      bumpScene();
    },

    rollback(): void {
      if (settled) return;
      settled = true;
      release();
      restore(before);
    },
  };
}
