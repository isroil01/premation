/**
 * Engine jobs from the UI (ENGINE_API.md §4.9): `startJob` + the job's
 * `jobProgress` / `jobFinished` events, as one promise with progress and a
 * cancel.
 *
 * The C++ engine runs the analysis jobs itself (tracking, stabilize, scene
 * detection, auto-trace, object matte, audio analysis / ducking / gate,
 * proxies, renders, transcription, auto-reframe). It is the only engine
 * (docs/TS_ENGINE_REMOVAL.md): a `null` here (`unsupported`) means the engine
 * did not run it, and callers report it with {@link requireEngineJob} — there
 * is no page implementation to fall back to.
 *
 * A job with `apply: true` writes its result as ONE undoable history entry
 * (origin engine) when it finishes; with `apply: false` the result is held
 * until {@link applyEngineJob} (a dialog that previews first, then applies).
 */

import type { EngineClient, EngineError, EventBatch, JobInfo, JobSpec } from '@motion/engine-api';
import { engine } from './engineInstance';
import { engineOwnsDocumentNow } from './engineOwnership';
import { materializeSessionFootage } from './sessionFootage';

export interface EngineJobOutcome<R = unknown> {
  status: 'done' | 'failed' | 'cancelled';
  job: JobInfo;
  /** `JobInfo.result` parsed (the kind's summary); null when there is none. */
  result: R | null;
  error?: EngineError;
}

export interface EngineJobHandle<R = unknown> {
  readonly id: string;
  /** Ask the engine to stop; the outcome then resolves `cancelled`. */
  cancel(): void;
  readonly done: Promise<EngineJobOutcome<R>>;
}

export interface StartEngineJobOptions {
  /** Write the result when the job finishes (default true). */
  apply?: boolean;
  /** Progress 0…1 with the engine's status line. */
  onProgress?: (fraction: number, message: string) => void;
  client?: EngineClient;
}

function parse<R>(text: string): R | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as R;
  } catch {
    return null;
  }
}

/**
 * Start `spec` in the engine. Resolves the handle, or `null` when this engine
 * does not run jobs of that kind (`unsupported` — the caller's page path runs
 * instead). Any other refusal (a layer without footage, bad parameters) throws
 * an Error with the engine's message.
 */
export async function startEngineJob<R = unknown>(spec: JobSpec, opts: StartEngineJobOptions = {}): Promise<EngineJobHandle<R> | null> {
  const client = opts.client ?? engine();
  // The C++ engine cannot open blob:/data: session footage. When it owns the
  // document, write those bytes to a cache file and relink before the job.
  // A failure leaves the job to report the footage it still cannot read.
  if (engineOwnsDocumentNow()) {
    try {
      await materializeSessionFootage(client, spec);
    } catch {
      /* the job's own error is the one the caller shows */
    }
  }
  // Subscribed BEFORE the request: a job's events for an id we do not know yet are buffered.
  let id: string | null = null;
  const early: EventBatch[] = [];
  let settle!: (o: EngineJobOutcome<R>) => void;
  let settled = false;
  const done = new Promise<EngineJobOutcome<R>>((resolve) => { settle = resolve; });
  const onBatch = (b: EventBatch): void => {
    if (id === null) {
      early.push(b);
      return;
    }
    for (const e of b.events) {
      if (e.type === 'jobProgress' && e.job.id === id) {
        opts.onProgress?.(e.job.progress, e.job.message);
      } else if (e.type === 'jobFinished' && e.job.id === id && !settled) {
        settled = true;
        unsubscribe();
        const status = e.job.status === 'done' ? 'done' : e.job.status === 'cancelled' ? 'cancelled' : 'failed';
        settle({ status, job: e.job, result: parse<R>(e.job.result), ...(e.error ? { error: e.error } : {}) });
      }
    }
  };
  const unsubscribe = client.subscribe(onBatch);
  const res = await client.execute({ type: 'startJob', job: spec, apply: opts.apply ?? true });
  if (!res.ok) {
    unsubscribe();
    if (res.error.code === 'unsupported') return null;
    throw new Error(res.error.message);
  }
  id = res.value.job;
  for (const b of early.splice(0)) onBatch(b);
  const jobId = id;
  return {
    id: jobId,
    cancel: () => { void client.execute({ type: 'cancelJob', job: jobId }); },
    done,
  };
}

/**
 * A job's handle / outcome, or the user-facing error when the engine does not
 * run `what` (the jest harness; the app's engine runs every job kind).
 */
export function requireEngineJob<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} runs in the engine, and this engine does not run it.`);
  return value;
}

/** Apply a finished job's held result (`apply: false`) as one undoable entry. */
export async function applyEngineJob(id: string, client: EngineClient = engine()): Promise<boolean> {
  const res = await client.execute({ type: 'applyJobResult', job: id });
  return res.ok;
}

/** Run `spec` to the end: the outcome, or `null` when the engine does not run it (fall back). */
export async function runEngineJob<R = unknown>(spec: JobSpec, opts: StartEngineJobOptions = {}): Promise<EngineJobOutcome<R> | null> {
  const handle = await startEngineJob<R>(spec, opts);
  return handle ? handle.done : null;
}

/**
 * Run `spec` for its SUMMARY only (a dialog's preview): started with
 * `apply: false`, the held result discarded afterwards (cancelJob of a held
 * result drops it; nothing is written). `null` when the engine does not run it.
 */
export async function previewEngineJob<R = unknown>(spec: JobSpec, opts: Omit<StartEngineJobOptions, 'apply'> = {}): Promise<EngineJobOutcome<R> | null> {
  const handle = await startEngineJob<R>(spec, { ...opts, apply: false });
  if (!handle) return null;
  const outcome = await handle.done;
  if (outcome.status === 'done' && !outcome.job.applied) handle.cancel();
  return outcome;
}
