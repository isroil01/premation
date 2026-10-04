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
 * Every mutating tool is engine-routed (toolHandlers ENGINE_ROUTED_TOOLS). A
 * write that still went AROUND the engine (a named legacy gap, or one the
 * engine noticed and resynced) is REPORTED in the outcome's `gaps`; there is
 * no page snapshot to fall back on — the engine's document is the one saved.
 */

import type { EngineClient, Origin } from '@motion/engine-api';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { engine } from '@core/engine/engineInstance';
import { EngineTurnSession } from './aiEngineSession';

export interface AiTurnOutcome {
  /**
   * `engine`   one engine history entry (replayable from the command log);
   * `empty`    nothing changed, no entry.
   */
  kind: 'engine' | 'empty';
  /**
   * Writes the turn made AROUND the engine (`session.legacy`, or an engine
   * resync) — reported, never papered over: the engine's document is the one
   * that is saved, and it did not get them.
   */
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
  // A sync point first: the engine resyncs any write made around it BEFORE
  // the turn, so it is not the turn's.
  await client.batch('', [], { origin });
  const gesture = await openGesture(client, label, origin);
  // Every engine write of the turn goes into ONE gesture = one undo entry; a
  // gesture slot still held (a drag that never finished) leaves nothing to
  // group the turn in, so the turn does not start.
  if (gesture === null) throw new Error('Another edit is still in progress (a drag that has not finished) — finish it, then ask again.');
  // The document revision the turn starts from: a turn that moved it is an entry.
  const startRevision = client.revision;
  const session = new EngineTurnSession(client, origin);
  // Watch AFTER the gesture opened: a stale write from before the turn is
  // resynced by beginGesture itself and is not this turn's.
  session.watch();

  // Other subsystems push their own commands as a side effect of work the run
  // triggers. Those are noise here: the turn's entry covers everything, so a
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

  const commit = async (): Promise<AiTurnOutcome> => {
    // A sync point: the engine resyncs (and the session hears it) before any
    // command if something wrote around it since the last one.
    await client.batch('', [], { origin });
    try {
      release();
      const res = await client.endGesture(gesture, true, { origin });
      // The gesture closed under the turn (a leaked-gesture recovery) still
      // committed its writes in the engine; say so.
      if (!res.ok) session.legacy(`the turn's gesture was closed by another client (${res.error.code})`);
      return { kind: res.ok && client.revision === startRevision ? 'empty' : 'engine', gaps: session.legacyGaps };
    } finally {
      session.dispose();
    }
  };

  const rollback = async (): Promise<void> => {
    try {
      await client.endGesture(gesture, false, { origin });
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
