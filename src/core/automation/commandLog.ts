/**
 * Command-log recording and replay for automation (NATIVE_CORE_PLAN §5 B5,
 * ENGINE_API.md §12): "command logs can be recorded and replayed — replay of
 * recorded sessions reproduces documents exactly".
 *
 *   const rec = await recordSession();   // start a log at the current document
 *   … the user edits, an AI turn runs, a script runs …
 *   const jsonl = await rec.stop();      // JSON lines: header (start document), one request per line
 *   await replaySession(jsonl);          // the engine reset to the start document, every request re-sent
 *
 * The log is the C++ engine's own (`getCommandLog`): every request that reached
 * it from ANY client — UI edits, gestures, undo/redo, AI turns, scripts,
 * plugins — in order, with the revision each produced. The engine always
 * records. The JSON-lines form is the script/CLI format (`premation render
 * --commands <log.jsonl>`, electron/commandLog.ts): byte arrays as
 * `{"$bytes":[…]}`.
 */

import { unwrap, type Command, type EngineResult, type LogRecord } from '@motion/engine-api';
import { engine, engineIdle, hasEngine } from '@core/engine/engineInstance';

/** A recorded session: the document it started from and every request after. */
export interface CommandLogData {
  header: {
    /** The engine's document at the start (`exportDocument`). */
    document: Uint8Array;
    /** The engine's revision at the start. */
    revision: number;
  };
  records: LogRecord[];
}

export class CommandLogUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandLogUnavailable';
  }
}

/** Serialize a log as JSON lines (the script format, §12): header first, then one record per line. */
export function logToJsonl(log: CommandLogData): string {
  const enc = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $bytes: Array.from(x) } : x));
  return [enc({ header: log.header }), ...log.records.map((r) => enc(r))].join('\n');
}

export function logFromJsonl(text: string): CommandLogData {
  const dec = (s: string): unknown => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && Array.isArray((x as { $bytes?: unknown }).$bytes) ? new Uint8Array((x as { $bytes: number[] }).$bytes) : x));
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new CommandLogUnavailable('Not a command log: it is empty.');
  const head = dec(lines[0]!) as { header?: CommandLogData['header'] };
  if (!head?.header) throw new CommandLogUnavailable('Not a command log: the first line has no header.');
  return { header: head.header, records: lines.slice(1).map((l) => dec(l) as LogRecord) };
}

function requireEngine(): void {
  if (!hasEngine()) throw new CommandLogUnavailable('No engine is running.');
}

/** The engine's log records after `from` (controls at `from` included), oldest first. */
async function recordsSince(from: number): Promise<LogRecord[]> {
  return unwrap(await engine().query({ type: 'getCommandLog', fromRevision: Math.max(0, from - 1) })).records;
}

// ── Record ───────────────────────────────────────────────────────────

export interface SessionRecorder {
  /** Stop and return the log as JSON lines. */
  stop(): Promise<string>;
  /** The log so far (structured). */
  snapshot(): Promise<CommandLogData>;
}

/**
 * Start recording a session at the CURRENT document: the header carries the
 * document as the engine exports it, so a replay starts exactly where the
 * recording did. Requests already in the engine's log are not part of it.
 */
export async function recordSession(): Promise<SessionRecorder> {
  requireEngine();
  await engineIdle();
  const exported = unwrap(await engine().query({ type: 'exportDocument' }));
  const revision = engine().revision;
  // The engine's log is cumulative: what it holds at the start is skipped.
  const before = (await recordsSince(revision)).length;
  let stopped: CommandLogData | null = null;
  const snapshot = async (): Promise<CommandLogData> => {
    if (stopped) return stopped;
    await engineIdle();
    const records = (await recordsSince(revision)).slice(before);
    return { header: { document: exported.document, revision }, records };
  };
  return {
    snapshot,
    stop: async () => {
      stopped ??= await snapshot();
      return logToJsonl(stopped);
    },
  };
}

// ── Replay ───────────────────────────────────────────────────────────

export interface ReplayMismatch {
  index: number;
  what: 'revision' | 'outcome';
  expected: string;
  actual: string;
}

export interface SessionReplay {
  applied: number;
  /** Records whose outcome or revision step differs; empty = reproduced exactly. */
  mismatches: ReplayMismatch[];
  /** The document after the replay (`exportDocument`). */
  document: Uint8Array;
}

/**
 * Replay a recorded session (JSON lines or structured) into the session's
 * engine: the document is reset to the log's start document
 * (`restoreDocument`), then every recorded command and batch is re-sent in
 * order (queries change nothing and are skipped). A record whose revision step
 * or success differs from the recording is listed.
 */
export async function replaySession(log: string | CommandLogData): Promise<SessionReplay> {
  requireEngine();
  const data = typeof log === 'string' ? logFromJsonl(log) : log;
  if (!data.header?.document) throw new CommandLogUnavailable('Not a command log: the header has no start document.');
  const e = engine();
  // A new project first: the engine's id allocator starts over (as a fresh engine's would),
  // so the replayed requests mint the ids the recording did.
  unwrap(await e.execute({ type: 'newProject' }));
  unwrap(await e.execute({ type: 'restoreDocument', document: data.header.document, label: 'Replay' } as Command));
  const mismatches: ReplayMismatch[] = [];
  let applied = 0;
  let expectedPrev = data.header.revision;
  let actualPrev = e.revision;
  let openGesture: number | null = null;
  for (const [index, rec] of data.records.entries()) {
    const body = rec.request.body;
    if (body.kind === 'query') continue;
    // Gesture ids are the engine's own counter: an `endGesture` names the gesture
    // its replayed `beginGesture` opened (gestures never nest — one slot).
    const cmd: Command | null = body.kind === 'command' && body.value.type === 'endGesture' && openGesture !== null
      ? { ...body.value, gesture: openGesture }
      : body.kind === 'command' ? body.value : null;
    const res: EngineResult<unknown> = body.kind === 'batch'
      ? await e.batch(body.value.label, body.value.commands, { origin: 'replay' })
      : await e.execute(cmd!, { origin: 'replay' });
    if (body.kind === 'command' && body.value.type === 'beginGesture') {
      openGesture = res.ok ? (res.value as { gesture: number }).gesture : null;
    } else if (body.kind === 'command' && body.value.type === 'endGesture') {
      openGesture = null;
    }
    applied += 1;
    if (!res.ok) {
      mismatches.push({ index, what: 'outcome', expected: 'ok', actual: `${res.error.code}: ${res.error.message}` });
    }
    const expectedStep = rec.revisionAfter - expectedPrev;
    const actualStep = res.revision - actualPrev;
    if (expectedStep !== actualStep) {
      mismatches.push({ index, what: 'revision', expected: String(expectedStep), actual: String(actualStep) });
    }
    expectedPrev = rec.revisionAfter;
    actualPrev = res.revision;
  }
  await engineIdle();
  const document = unwrap(await e.query({ type: 'exportDocument' })).document;
  return { applied, mismatches, document };
}
