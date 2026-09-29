/**
 * `premation render --commands session.jsonl`: a recorded command log (the B5
 * automation format — a header line with the start document, then one
 * `{request, revisionAfter, …}` record per line, byte arrays as `{"$bytes":[…]}`)
 * turned into the requests `premation-engine --prepare` replays.
 *
 * Main owns the file, so main reads it; the engine applies it. Each command
 * or batch request is encoded here with the generated codec (EngineMessage
 * {request}, base64) — the engine decodes it with its own. The start document
 * becomes the first request (`restoreDocument`), exactly as the editor's
 * replay reset the engine to it; queries are skipped (they change nothing).
 */

import { encodeEngineMessage } from './generated/engineCodec';
import type { Request } from './generated/engineTypes';

/** JSON.parse with the log's `{"$bytes":[…]}` byte arrays revived. */
function decodeLine(line: string): unknown {
  return JSON.parse(line, (_k, v: unknown) => (
    v && typeof v === 'object' && Array.isArray((v as { $bytes?: unknown }).$bytes)
      ? new Uint8Array((v as { $bytes: number[] }).$bytes)
      : v
  ));
}

export interface CommandLogRequests {
  /** base64 EngineMessage{request} per replayed request, in order. */
  requests: string[];
  /** Records skipped because they change nothing (queries). */
  skipped: number;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** Parse and encode a command log. Throws with a readable message when it is not one. */
export function commandLogRequests(text: string): CommandLogRequests {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) throw new Error('The command log is empty.');
  let head: { header?: { document?: unknown } };
  try {
    head = decodeLine(lines[0]!) as typeof head;
  } catch (e) {
    throw new Error(`the first line is not JSON (${(e as Error).message})`);
  }
  if (!head || typeof head !== 'object' || !head.header) throw new Error('the first line has no "header" — not a command log');
  const out: CommandLogRequests = { requests: [], skipped: 0 };
  let seq = 0;
  const push = (body: Request['body']): void => {
    seq += 1;
    out.requests.push(toBase64(encodeEngineMessage({ kind: 'request', value: { seq, body, origin: 'replay' } })));
  };
  if (head.header.document !== undefined) {
    const doc = head.header.document instanceof Uint8Array ? head.header.document : new TextEncoder().encode(JSON.stringify(head.header.document));
    push({ kind: 'command', value: { type: 'restoreDocument', document: doc, label: 'Replay' } });
  }
  for (let i = 1; i < lines.length; i++) {
    let rec: { request?: Request };
    try {
      rec = decodeLine(lines[i]!) as typeof rec;
    } catch (e) {
      throw new Error(`line ${i + 1} is not JSON (${(e as Error).message})`);
    }
    const req = rec?.request;
    if (!req || typeof req !== 'object' || !req.body) throw new Error(`line ${i + 1} has no "request"`);
    if (req.body.kind === 'query') {
      out.skipped += 1;
      continue;
    }
    try {
      push(req.body);
    } catch (e) {
      throw new Error(`line ${i + 1} is not an engine request this version understands (${(e as Error).message})`);
    }
  }
  return out;
}
