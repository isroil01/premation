/**
 * Typed failures inside the local engine (docs/ENGINE_API.md §10).
 *
 * A handler validates first and throws `EngineFail` BEFORE it mutates
 * anything; the request loop catches it and answers with the `EngineError`.
 * Anything else thrown while applying is an `internal` error — the loop rolls
 * the captured parts back first, so a failed request changes nothing either way.
 */

import type { EngineError, ErrorCode } from '@motion/engine-api';

export class EngineFail extends Error {
  readonly error: EngineError;
  constructor(error: EngineError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'EngineFail';
    this.error = error;
  }
}

export function fail(code: ErrorCode, message: string, extra: Partial<Omit<EngineError, 'code' | 'message'>> = {}): never {
  throw new EngineFail({ code, message, ...extra });
}

/** `cond` or a typed failure. */
export function check(cond: unknown, code: ErrorCode, message: string, extra: Partial<Omit<EngineError, 'code' | 'message'>> = {}): asserts cond {
  if (!cond) fail(code, message, extra);
}

/** Any thrown value as an EngineError (EngineFail keeps its code; the rest are `internal`). */
export function toEngineError(err: unknown): EngineError {
  if (err instanceof EngineFail) return err.error;
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal', message };
}
