/**
 * Recognising a document change made AROUND the engine (a legacy writer that
 * has not moved onto the API yet) in the event stream.
 *
 * The TypeScript engine reports such a change on the next microtask
 * (`LocalEngine.flushExternal`, so the B4 document mirror never shows a stale
 * document): incrementally, as a revisioned batch of its own with origin
 * `engine` and no `causedBy`, when the app bus named the one layer it touched;
 * as `documentReset{resync}` otherwise (or at the next request). Both mean the
 * command log is no longer the whole story — the session recorder
 * (commandLog.ts) and an AI turn (aiEngineSession.ts) count them.
 *
 * Other engine-initiated revisions (a job result applied by the engine, an
 * undo of an engine entry reached outside a request) are also changes no
 * request in the log caused, so counting them is right for the same reason.
 */

import type { EventBatch } from '@motion/engine-api';

export function isWriteAroundEngine(batch: EventBatch): boolean {
  let reset = false;
  for (const ev of batch.events) {
    if (ev.type !== 'documentReset') continue;
    if (ev.reason === 'resync') return true;
    reset = true;
  }
  return !reset && batch.causedBy === undefined && batch.origin === 'engine' && batch.fromRevision !== batch.toRevision;
}
