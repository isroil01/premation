/**
 * EngineClient — the one door the editor (and AI tools, scripts, plugins, the
 * CLI and replay) uses to talk to an engine (docs/ENGINE_API.md §1, §12).
 *
 * Transport-agnostic: an implementation only has to turn a `Request` into a
 * `Response` (`request`) and deliver `EventBatch`es to subscribers. Every
 * convenience below is built on those two, so the in-process TypeScript
 * backend (src/core/engine, phase B2) and the C++ process backend (phase C3)
 * are interchangeable behind this interface — the same command stream drives
 * either.
 *
 * Failure is a VALUE, never an exception: `execute`/`query`/`batch` resolve to
 * `{ ok: false, error }` with the typed `EngineError` (§10). A failed request
 * changed nothing. Use `unwrap` (or `EngineRequestError`) where a throw is the
 * clearer control flow.
 */

import type {
  Command,
  CommandResult,
  CommandResults,
  CommandType,
  EngineError,
  ErrorCode,
  EventBatch,
  Origin,
  Query,
  QueryResults,
  QueryType,
  Request,
  Response,
  Revision,
  SeekMode,
  PlayRange,
  TimeRange,
  HistoryStep,
  GestureRef,
  Empty,
} from './generated/types';
import { COMMANDS } from './generated/meta';
import type { CommandKind } from './generated/meta';

/** A command of one type, as sent (`{ type, ...args }`). */
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
/** A query of one type, as sent. */
export type QueryOf<T extends QueryType> = Extract<Query, { type: T }>;

/** The outcome of one request: the typed value, or the typed error that changed nothing. */
export type EngineResult<T> =
  | { ok: true; value: T; revision: Revision }
  | { ok: false; error: EngineError; revision: Revision };

export interface RequestOptions {
  /** Who is asking (history labels, logs, permission checks). Default `ui`. */
  origin?: Origin;
  /** Optimistic concurrency: reject with `conflict` unless the document is at this revision. */
  baseRevision?: Revision;
}

/** Receives every event batch the engine sends, in order. */
export type EventListener = (batch: EventBatch) => void;

/** The contract. See the file header. */
export interface EngineClient {
  /** The newest document revision this client has seen (responses and event batches). */
  readonly revision: Revision;

  /** The wire-level primitive every helper is built on. */
  request(request: Request): Promise<Response>;

  /** Execute one command (edit, control or io). */
  execute<T extends CommandType>(command: CommandOf<T>, options?: RequestOptions): Promise<EngineResult<CommandResults[T]>>;
  /** Several commands as ONE undo entry, all-or-nothing (§5.1). */
  batch(label: string, commands: Command[], options?: RequestOptions): Promise<EngineResult<CommandResult[]>>;
  /** Read without changing anything. */
  query<T extends QueryType>(query: QueryOf<T>, options?: RequestOptions): Promise<EngineResult<QueryResults[T]>>;

  /** Subscribe to event batches; returns the unsubscribe function. */
  subscribe(listener: EventListener): () => void;

  // ── History and gestures (§5) ──
  beginGesture(label: string, options?: RequestOptions): Promise<EngineResult<GestureRef>>;
  endGesture(gesture: number, commit?: boolean, options?: RequestOptions): Promise<EngineResult<Empty>>;
  undo(options?: RequestOptions): Promise<EngineResult<HistoryStep>>;
  redo(options?: RequestOptions): Promise<EngineResult<HistoryStep>>;

  // ── Transport (§6) ──
  play(opts?: { rate?: number; range?: PlayRange; custom?: TimeRange; audio?: boolean; cacheFirst?: boolean; from?: number }): Promise<EngineResult<Empty>>;
  pause(returnToStart?: boolean): Promise<EngineResult<Empty>>;
  seek(time: number, mode?: SeekMode): Promise<EngineResult<Empty>>;
  step(frames: number): Promise<EngineResult<Empty>>;

  /** Release the connection. A gesture still open is COMMITTED (§5.1). */
  close(): Promise<void>;
}

/** The history kind of a command (`edit` | `control` | `io`), from the schema. */
export function commandKind(type: CommandType): CommandKind {
  return COMMANDS[type].kind;
}

/** Whether consecutive commands of this type may merge inside a gesture (`[coalesce]`). */
export function isCoalescable(type: CommandType): boolean {
  return COMMANDS[type].coalesce;
}

/** A thrown form of a failed request, for callers that prefer exceptions. */
export class EngineRequestError extends Error {
  readonly code: ErrorCode;
  readonly error: EngineError;
  constructor(error: EngineError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'EngineRequestError';
    this.code = error.code;
    this.error = error;
  }
}

/** The value of a successful result; throws `EngineRequestError` otherwise. */
export function unwrap<T>(result: EngineResult<T>): T {
  if (result.ok) return result.value;
  throw new EngineRequestError(result.error);
}

/** Build an `EngineError` value (engines and tests). */
export function engineError(code: ErrorCode, message: string, extra: Partial<Omit<EngineError, 'code' | 'message'>> = {}): EngineError {
  return { code, message, ...extra };
}

/**
 * Everything but `request`, `subscribe` and `close`, implemented once over the
 * wire primitive. Both backends extend this, so the helpers cannot drift.
 */
export abstract class EngineClientBase implements EngineClient {
  private seq = 0;
  protected lastRevision: Revision = 0;

  get revision(): Revision {
    return this.lastRevision;
  }

  abstract request(request: Request): Promise<Response>;
  abstract subscribe(listener: EventListener): () => void;
  abstract close(): Promise<void>;

  /** Track the newest revision a response or event batch reported. */
  protected noteRevision(revision: Revision): void {
    if (revision > this.lastRevision) this.lastRevision = revision;
  }

  private async send(body: Request['body'], options: RequestOptions | undefined): Promise<Response> {
    this.seq += 1;
    const req: Request = {
      seq: this.seq,
      body,
      origin: options?.origin ?? 'ui',
      ...(options?.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
    };
    const res = await this.request(req);
    this.noteRevision(res.revision);
    return res;
  }

  async execute<T extends CommandType>(command: CommandOf<T>, options?: RequestOptions): Promise<EngineResult<CommandResults[T]>> {
    const res = await this.send({ kind: 'command', value: command }, options);
    if (res.outcome.kind === 'error') return { ok: false, error: res.outcome.value, revision: res.revision };
    if (res.outcome.kind !== 'command') {
      return { ok: false, error: engineError('internal', `unexpected outcome '${res.outcome.kind}' for a command`), revision: res.revision };
    }
    const { type: _type, ...value } = res.outcome.value as CommandResult & Record<string, unknown>;
    return { ok: true, value: value as unknown as CommandResults[T], revision: res.revision };
  }

  async batch(label: string, commands: Command[], options?: RequestOptions): Promise<EngineResult<CommandResult[]>> {
    const res = await this.send({ kind: 'batch', value: { label, commands } }, options);
    if (res.outcome.kind === 'error') return { ok: false, error: res.outcome.value, revision: res.revision };
    if (res.outcome.kind !== 'batch') {
      return { ok: false, error: engineError('internal', `unexpected outcome '${res.outcome.kind}' for a batch`), revision: res.revision };
    }
    return { ok: true, value: res.outcome.value.results, revision: res.revision };
  }

  async query<T extends QueryType>(query: QueryOf<T>, options?: RequestOptions): Promise<EngineResult<QueryResults[T]>> {
    const res = await this.send({ kind: 'query', value: query }, options);
    if (res.outcome.kind === 'error') return { ok: false, error: res.outcome.value, revision: res.revision };
    if (res.outcome.kind !== 'query') {
      return { ok: false, error: engineError('internal', `unexpected outcome '${res.outcome.kind}' for a query`), revision: res.revision };
    }
    const { type: _type, ...value } = res.outcome.value as unknown as Record<string, unknown>;
    return { ok: true, value: value as unknown as QueryResults[T], revision: res.revision };
  }

  beginGesture(label: string, options?: RequestOptions): Promise<EngineResult<GestureRef>> {
    return this.execute({ type: 'beginGesture', label }, options);
  }
  endGesture(gesture: number, commit = true, options?: RequestOptions): Promise<EngineResult<Empty>> {
    return this.execute({ type: 'endGesture', gesture, commit }, options);
  }
  undo(options?: RequestOptions): Promise<EngineResult<HistoryStep>> {
    return this.execute({ type: 'undo' }, options);
  }
  redo(options?: RequestOptions): Promise<EngineResult<HistoryStep>> {
    return this.execute({ type: 'redo' }, options);
  }
  play(opts: { rate?: number; range?: PlayRange; custom?: TimeRange; audio?: boolean; cacheFirst?: boolean; from?: number } = {}): Promise<EngineResult<Empty>> {
    return this.execute({
      type: 'play',
      rate: opts.rate ?? 1,
      range: opts.range ?? 'all',
      audio: opts.audio ?? true,
      cacheFirst: opts.cacheFirst ?? false,
      ...(opts.custom ? { custom: opts.custom } : {}),
      ...(opts.from !== undefined ? { from: opts.from } : {}),
    });
  }
  pause(returnToStart = false): Promise<EngineResult<Empty>> {
    return this.execute({ type: 'pause', returnToStart });
  }
  seek(time: number, mode: SeekMode = 'exact'): Promise<EngineResult<Empty>> {
    return this.execute({ type: 'seek', time, mode });
  }
  step(frames: number): Promise<EngineResult<Empty>> {
    return this.execute({ type: 'step', frames });
  }
}
