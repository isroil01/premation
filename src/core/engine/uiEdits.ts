/**
 * How UI code sends document edits (B3). Two shapes cover every call site:
 *
 *   await edit(label, commands)      one user action = one undo entry: always a
 *                                    BATCH (atomic, one entry named `label`; an
 *                                    empty label keeps the command's own name,
 *                                    e.g. "Layer Switches").
 *   const g = new GestureSession(label); g.send(cmds) … g.end() / g.cancel()
 *                                    a drag = one entry, however many moves
 *                                    (ENGINE_API.md §5). React code uses the
 *                                    `useGesture` hook over this (src/hooks).
 *
 * Failure is a value (`EngineResult`). A typed error changed nothing; unless
 * the caller passes `quiet`, it is also shown to the user as a toast, because
 * a click that silently does nothing is the failure the old helpers had.
 *
 * No React (src/core). See docs/B3_PATTERNS.md for before/after conversions.
 */

import type { Command, CommandResult, EngineError, EngineResult, EngineClient } from '@motion/engine-api';
import { useUIStore } from '@stores/uiStore';
import { engine, engineGeneration } from './engineInstance';

export interface EditOptions {
  /** Do not toast a typed error (the caller shows its own message). */
  quiet?: boolean;
  /** Override the client (tests). Default: the session engine. */
  client?: EngineClient;
}

const CODE_TEXT: Partial<Record<EngineError['code'], string>> = {
  locked: 'is locked',
  notFound: 'target no longer exists',
  cycle: 'would create a cycle',
  notAnimatable: 'cannot be animated',
  unsupported: 'is not supported yet',
  typeMismatch: 'got the wrong kind of value',
  outOfRange: 'value is out of range',
  io: 'could not read or write the file',
  gestureOpen: 'another drag is still in progress',
};

/** The user-facing sentence for a typed engine error. */
export function describeEngineError(label: string, error: EngineError): string {
  const what = CODE_TEXT[error.code];
  const head = label ? `${label}: ` : '';
  // The engine's message names the layer/property; the code gives the reason.
  return what ? `${head}${error.message || what}` : `${head}${error.message || error.code}`;
}

/** Toast a typed error (warning for user-state refusals, error for the rest). */
export function reportEngineError(label: string, error: EngineError): void {
  const soft = error.code === 'locked' || error.code === 'notAnimatable' || error.code === 'unsupported' || error.code === 'gestureOpen';
  try {
    useUIStore.getState().notify({
      level: soft ? 'warning' : 'error',
      message: describeEngineError(label, error),
      durationMs: soft ? 3000 : 6000,
    });
  } catch {
    // No UI store (headless): the result value still carries the error.
  }
}

/**
 * One user action. `commands` may be a single command or a list, sent as ONE
 * batch — one undo entry named `label`, all-or-nothing. An empty list is a
 * no-op success.
 */
export async function edit(
  label: string,
  commands: Command | readonly Command[],
  opts: EditOptions = {},
): Promise<EngineResult<CommandResult[]>> {
  const list = Array.isArray(commands) ? commands as readonly Command[] : [commands as Command];
  const client = opts.client ?? engine();
  if (list.length === 0) return { ok: true, value: [], revision: client.revision };
  const res = await client.batch(label, [...list]);
  if (!res.ok && !opts.quiet) reportEngineError(label, res.error);
  return res;
}

/**
 * A drag as one undo entry.
 *
 *   begin      beginGesture(label) — sent at construction (pointer down / scrub start)
 *   send       the command(s) for the CURRENT pointer position; LATEST WINS: while
 *              one message is in flight only the newest pending one is kept (each
 *              message carries an absolute value, so dropping intermediates loses
 *              nothing and a slow engine never builds a backlog). A message sent
 *              with `{ keep: true }` is never dropped: a STRUCTURAL step inside a
 *              drag (a vertex inserted at pointer down, `editPathTopology`) that
 *              the later absolute messages build on — it lands once, in order.
 *   end        endGesture(commit) after the last message landed; Esc → cancel()
 *              reverts every edit of the gesture
 *
 * A session begun on an engine that has since been rebuilt (project opened
 * mid-drag) is dead: its sends and end are dropped.
 */
export class GestureSession {
  readonly label: string;
  private readonly client: EngineClient;
  private readonly generation: number;
  private readonly quiet: boolean;
  private readonly opened: Promise<number | null>;
  private inFlight: Promise<void> | null = null;
  /** Messages waiting for the one in flight: kept ones in order, at most one droppable at the end. */
  private pending: Array<{ list: readonly Command[]; keep: boolean }> = [];
  private ended = false;
  private reported = false;

  constructor(label: string, opts: EditOptions = {}) {
    this.label = label;
    this.client = opts.client ?? engine();
    this.generation = engineGeneration();
    this.quiet = opts.quiet ?? false;
    this.opened = this.open();
  }

  /** True until `end`/`cancel`. */
  get active(): boolean {
    return !this.ended;
  }

  private alive(): boolean {
    return engineGeneration() === this.generation;
  }

  private async open(): Promise<number | null> {
    let res = await this.client.beginGesture(this.label);
    if (!res.ok && res.error.code === 'gestureOpen') {
      // A gesture leaked by an earlier bug must not block every drag for the
      // rest of the session: commit it (nothing the user saw is lost) and retry.
      await this.client.endGesture(0, true);
      res = await this.client.beginGesture(this.label);
    }
    if (!res.ok) {
      this.report(res.error);
      return null;
    }
    return res.value.gesture;
  }

  private report(error: EngineError): void {
    if (this.reported || this.quiet) return;
    this.reported = true;
    reportEngineError(this.label, error);
  }

  /** The edit for the current pointer position (see the class header). */
  send(commands: Command | readonly Command[], opts: { keep?: boolean } = {}): void {
    if (this.ended || !this.alive()) return;
    const list = Array.isArray(commands) ? commands as readonly Command[] : [commands as Command];
    if (list.length === 0) return;
    if (this.inFlight) {
      const keep = opts.keep === true;
      const last = this.pending[this.pending.length - 1];
      // Latest wins over the droppable message still waiting; a kept one stays.
      if (!keep && last && !last.keep) this.pending[this.pending.length - 1] = { list, keep };
      else this.pending.push({ list, keep });
      return;
    }
    this.dispatch(list);
  }

  private dispatch(list: readonly Command[]): void {
    this.inFlight = (async () => {
      const id = await this.opened;
      if (id === null || !this.alive()) return;
      const res = list.length === 1
        ? await this.client.execute(list[0]!)
        : await this.client.batch(this.label, [...list]);
      if (!res.ok) this.report(res.error);
    })().finally(() => {
      this.inFlight = null;
      const next = this.pending.flatMap((m) => m.list);
      this.pending = [];
      if (next.length > 0 && this.alive()) this.dispatch(next);
    });
  }

  /** Wait for every queued message to land. */
  private async drain(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  /** Commit (default) or revert the gesture. Idempotent. */
  async end(commit = true): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (!commit) this.pending = [];
    await this.drain();
    const id = await this.opened;
    if (id === null || !this.alive()) return;
    const res = await this.client.endGesture(id, commit);
    if (!res.ok) this.report(res.error);
  }

  /** Esc: revert everything the gesture applied. */
  cancel(): Promise<void> {
    return this.end(false);
  }
}
