/**
 * Recognising, in the event stream, a document change no request in this
 * window's command log caused: a revisioned batch with origin `engine` and no
 * `causedBy` (a job result the engine applied, an undo of an engine entry
 * reached outside a request), or a `documentReset{resync}`. Both mean the
 * command log is no longer the whole story — the session recorder
 * (commandLog.ts) and an AI turn (aiEngineSession.ts) count them.
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
