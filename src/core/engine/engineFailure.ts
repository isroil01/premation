import { EngineRequestError, type EngineError } from '@motion/engine-api';

/**
 * A failed engine request as a thrown error that keeps its code.
 *
 * These sites threw `new Error(res.error.message)`: the code (`busy`,
 * `timeout`, `decode`…) was lost, and a crash report could only say `Error`.
 * The message stays the engine's own sentence — callers show it to the user —
 * where `EngineRequestError` alone would prefix it with the code.
 */
export function engineFailure(error: EngineError): EngineRequestError {
  const err = new EngineRequestError(error);
  err.message = error.message;
  return err;
}
