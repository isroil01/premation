/**
 * Command-log recording and replay for automation (NATIVE_CORE_PLAN §5 B5,
 * ENGINE_API.md §12): "command logs can be recorded and replayed — replay of
 * recorded sessions reproduces documents exactly".
 *
 *   const rec = await recordSession();  // start a fresh log at the current document
 *   … the user edits, an AI turn runs, a script runs …
 *   const jsonl = rec.stop();           // JSON lines: header (document + id counters), one request per line
 *   await replaySession(jsonl);         // a fresh engine instance over the log's start document, every request re-sent
 *
 * The log is the engine's own (`LocalEngine.commandLog`): every request that
 * reached the engine from ANY client — UI edits, gestures, undo/redo, AI turns,
 * scripts, plugins — in order, with the revision each produced. The JSON-lines
 * form is the script/CLI format (`premation render --commands <log.jsonl>`).
 *
 * Recording must be on for the engine instance (the app turns it on with the
 * dev/automation flag below; it is off by default in production because every
 * drag message is deep-copied into it and the log is never trimmed).
 *
 * This module only USES the engine's public surface (`commandLog`, `startLog`,
 * `loadDocument` via `replayLog`); it adds nothing inside src/core/engine.
 */

import type { LocalEngine, CommandLogData } from '@core/engine/LocalEngine';
import { localEngine, rebuildEngine, engineIdle } from '@core/engine/engineInstance';
import { replayLog, logToJsonl, logFromJsonl, type ReplayResult } from '@core/engine/replay';
import { canonicalJson } from '@core/engine/canonical';

// ── The recording flag ───────────────────────────────────────────────

let recording = false;

/**
 * Whether the app's engine records its command log. Set once at boot from the
 * build env (`main.tsx`: on in development, `VITE_RECORD_COMMAND_LOG=1`
 * elsewhere) — `import.meta.env` stays out of shared modules (Jest).
 * Takes effect for every engine instance built after it is set (each project
 * open/new builds one).
 */
export function commandLogRecordingEnabled(): boolean {
  return recording;
}

export function setCommandLogRecording(on: boolean): void {
  recording = on;
}

// ── Record ───────────────────────────────────────────────────────────

export interface SessionRecorder {
  /** Stop and return the log as JSON lines. */
  stop(): string;
  /** The log so far (structured). */
  snapshot(): CommandLogData;
  /**
   * How many times the document was changed AROUND the engine while recording
   * (the engine answered with a `documentReset` resync): a legacy writer, an
   * AI turn that committed as a snapshot (a named B5 gap), a panel not yet on
   * the API. Those changes are not requests, so they are not in the log — a
   * replay of a session with any is not exact. 0 = the log is the whole session.
   */
  readonly writesAroundEngine: number;
}

export class CommandLogUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandLogUnavailable';
  }
}

function requireEngine(e?: LocalEngine | null): LocalEngine {
  const engine = e ?? localEngine();
  if (!engine) throw new CommandLogUnavailable('No engine is running.');
  return engine;
}

/**
 * Whether an engine instance records its log. `LocalEngine` exposes no flag,
 * but its log header is created once at construction when recording is on and
 * is then handed out as the same object; with recording off every
 * `commandLog()` builds a fresh one. (Read-only probe; B5 adds nothing to the
 * engine. Costs one document capture when recording is off.)
 */
export function isRecording(engine: LocalEngine): boolean {
  return engine.commandLog().header === engine.commandLog().header;
}

/**
 * Start recording a session: the log restarts at the CURRENT document (its
 * header captures the document and the engine's id counters), so the replay
 * starts exactly where the recording did. The undo stack a replay rebuilds is
 * the one recorded from here (entries made before the recording are not in
 * the log).
 *
 * An empty batch goes first: the engine builds its lazy timeline mirror and
 * answers any write made around it (a legacy panel, a project open) with its
 * resync revision BEFORE the header is taken, so the replay's revisions line
 * up from the first record.
 */
export async function recordSession(opts: { engine?: LocalEngine } = {}): Promise<SessionRecorder> {
  const engine = requireEngine(opts.engine);
  if (!isRecording(engine)) {
    throw new CommandLogUnavailable(
      'This engine does not record its command log. Start the app with command-log recording on ' +
        '(development builds, or VITE_RECORD_COMMAND_LOG=1), then open or create a project.',
    );
  }
  await engine.batch('', []);
  await engine.whenIdle();
  // The header's id counters include the gesture counter (ids.ts), so a
  // recorded `endGesture{gesture: n}` names the same gesture on replay.
  engine.startLog();
  let stopped: CommandLogData | null = null;
  let around = 0;
  const unsubscribe = engine.subscribe((batch) => {
    if (!stopped) for (const ev of batch.events) if (ev.type === 'documentReset' && ev.reason === 'resync') around += 1;
  });
  return {
    snapshot: () => stopped ?? engine.commandLog(),
    get writesAroundEngine() { return around; },
    stop: () => {
      if (!stopped) {
        stopped = engine.commandLog();
        unsubscribe();
      }
      return logToJsonl(stopped);
    },
  };
}

// ── Replay ───────────────────────────────────────────────────────────

export interface SessionReplay extends ReplayResult {
  /** The canonical document after the replay (what a save would write). */
  document: string;
}

/**
 * Replay a recorded session (JSON lines or structured) into a FRESH engine: the
 * app's engine is rebuilt (new instance, new id allocator, empty history), the
 * log's start document is loaded, and every request is re-sent in order. The
 * result lists any record whose revision or outcome differs — empty means the
 * session was reproduced exactly (documents, ids, undo stack).
 *
 * Pass `engine` to replay into a specific instance instead (tests, a headless
 * render) — it is reset to the log's start document the same way.
 */
export async function replaySession(log: string | CommandLogData, opts: { engine?: LocalEngine; checkHashes?: boolean } = {}): Promise<SessionReplay> {
  const data = typeof log === 'string' ? logFromJsonl(log) : log;
  if (!data.header?.document) throw new CommandLogUnavailable('Not a command log: the header has no start document.');
  const engine = opts.engine ?? rebuildEngine('opened');
  const result = await replayLog(withGestureCounter(data), engine, { checkHashes: opts.checkHashes ?? false });
  await engine.whenIdle();
  if (!opts.engine) await engineIdle();
  return { ...result, document: canonicalJson() };
}

/**
 * A log recorded before the gesture counter joined the id counters (B5's
 * recorder) carries it as `header.gestureSeq`: read it as the `gesture` counter.
 */
function withGestureCounter(data: CommandLogData): CommandLogData {
  const legacy = (data.header as { gestureSeq?: number }).gestureSeq;
  if (legacy === undefined || data.header.ids.gesture !== undefined) return data;
  return { ...data, header: { ...data.header, ids: { ...data.header.ids, gesture: legacy } } };
}

export { logToJsonl, logFromJsonl };
export type { CommandLogData };
