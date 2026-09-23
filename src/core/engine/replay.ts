/**
 * Command log replay (ENGINE_API.md §12, plan §6 — B5's core).
 *
 * A log is a header (the document the session started from + the engine's id
 * counters + its revision) and one `LogRecord` per applied request. Replaying
 * the requests into a fresh engine must reproduce every revision, every
 * recorded document hash, and — checked by the corpus — the final saved
 * project JSON and the undo stack. Either engine implementation can be the
 * target: this only speaks `EngineClient` plus the local engine's
 * `loadDocument` to seed the start state.
 */

import type { LogRecord } from '@motion/engine-api';
import type { LocalEngine, CommandLogData } from './LocalEngine';
import { documentHash } from './canonical';

export interface ReplayMismatch {
  index: number;
  what: 'revision' | 'hash' | 'outcome';
  expected: string;
  actual: string;
}

export interface ReplayResult {
  applied: number;
  mismatches: ReplayMismatch[];
}

/** Serialize a log as JSON lines (the script format, §12): header first, then one record per line. */
export function logToJsonl(log: CommandLogData): string {
  const enc = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $bytes: Array.from(x) } : x));
  return [enc({ header: log.header }), ...log.records.map((r) => enc(r))].join('\n');
}

export function logFromJsonl(text: string): CommandLogData {
  const dec = (s: string): unknown => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && Array.isArray((x as { $bytes?: unknown }).$bytes) ? new Uint8Array((x as { $bytes: number[] }).$bytes) : x));
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const head = dec(lines[0]!) as { header: CommandLogData['header'] };
  return { header: head.header, records: lines.slice(1).map((l) => dec(l) as LogRecord) };
}

export async function replayLog(log: CommandLogData, engine: LocalEngine, opts: { checkHashes?: boolean } = {}): Promise<ReplayResult> {
  engine.loadDocument(log.header.document, { ids: log.header.ids, revision: log.header.revision, reason: 'resync', resetWorkspace: true });
  const mismatches: ReplayMismatch[] = [];
  let i = 0;
  for (const rec of log.records) {
    const res = await engine.request(rec.request);
    if (res.outcome.kind === 'error') {
      mismatches.push({ index: i, what: 'outcome', expected: 'ok', actual: `${res.outcome.value.code}: ${res.outcome.value.message}` });
    }
    if (res.revision !== rec.revisionAfter) {
      mismatches.push({ index: i, what: 'revision', expected: String(rec.revisionAfter), actual: String(res.revision) });
    }
    if (opts.checkHashes && rec.documentHash !== 0) {
      const hsh = documentHash();
      if (hsh !== rec.documentHash) mismatches.push({ index: i, what: 'hash', expected: String(rec.documentHash), actual: String(hsh) });
    }
    i += 1;
  }
  return { applied: i, mismatches };
}
