/**
 * When a native call runs, and what happens to the ones that pile up behind it.
 *
 * ── Two modes, because a preview and an export want opposite things ──────────
 *
 * During PREVIEW the only frame worth computing is the one the playhead is on.
 * A scrub submits a call per pointer move, each one newer and more relevant
 * than the last, and a queue that runs all of them finishes minutes after the
 * user stopped. So: latest-wins per lane. A superseded call resolves `null` —
 * "this did not happen" — which every caller already treats as "keep the layer
 * unchanged", the same contract C2's kernel pool uses.
 *
 * During EXPORT every frame is the one that matters. Nothing is dropped,
 * nothing is coalesced, and the caller awaits the exact frame before writing
 * it. `setNativeExactMode(true)` switches the whole scheduler for the duration,
 * mirroring `setGeneratorExactMode` — the same words in the same shape, because
 * an export has to reason about both at once.
 *
 * ── Concurrency comes from the plugin's own declaration ──────────────────────
 *
 * `threadSafety` is the same three words as the CPU kernels', and the lane rule
 * is literally C2's `laneFor` rather than a second copy of it:
 *
 *   unsafe    one lane for the whole plugin — every call serialised
 *   instance  one lane per effect instance (the default)
 *   full      a lane per job — the host may have several in flight at once
 *
 * A lane runs one call at a time. The declaration is the plugin's word about
 * its own globals, and it is taken at face value: there is no way to verify it
 * from out here, and an over-strict default costs throughput while an
 * over-loose one costs one wrong frame in a hundred, which is unreportable.
 *
 * ── The budget ───────────────────────────────────────────────────────────────
 *
 * Nothing native goes on the render loop's critical path without one. A preview
 * call that takes longer than `NATIVE_PREVIEW_BUDGET_MS` marks its plugin over
 * budget, and further PREVIEW calls are skipped until it comes back under —
 * the effect falls back to its JavaScript or WebAssembly path and the playhead
 * keeps moving. Export ignores the budget entirely: there is no interactive
 * loop to protect and the correct frame is worth waiting for.
 *
 * This is deliberately about the WHOLE PLUGIN rather than one effect instance.
 * A slow addon is slow because of what it is, not because of which instance
 * asked, and a per-instance budget would let a comp with thirty copies spend
 * thirty times the budget.
 */

import { laneFor } from '../kernel/kernelPool';
import type { ThreadSafety } from '../effectSchema';
import type { NativeCallOutcome, NativeRequest } from './nativeAbi';

/** Longer than a frame and shorter than a gesture. Over this, the JS path wins. */
export const NATIVE_PREVIEW_BUDGET_MS = 24;

/**
 * How long a plugin stays benched after it blew the budget.
 *
 * Long enough that a genuinely slow addon is not retried every frame of a
 * scrub, short enough that one slow frame — a cold cache, a first-call model
 * load — does not cost the user the native path for the rest of the session.
 */
export const NATIVE_BUDGET_COOLDOWN_MS = 2000;

/** What a caller submits. Everything needed to place it in a lane. */
export interface NativeJob {
  pluginId: string;
  /** The effect or layer INSTANCE. The lane and any per-instance cache key on it. */
  instanceId: string;
  threadSafety?: ThreadSafety;
  request: NativeRequest;
}

/** The thing that actually crosses to the plugin's process. Injected, for tests. */
export type NativeDispatch = (job: NativeJob) => Promise<NativeCallOutcome>;

interface Task {
  id: number;
  lane: string;
  job: NativeJob;
  coalesce: boolean;
  resolve: (r: NativeCallOutcome | null) => void;
}

/** One plugin's budget state. Absent until it has ever been over. */
interface Budget {
  benchedUntil: number;
  lastMs: number;
}

export class NativeScheduler {
  private seq = 0;
  private readonly queue: Task[] = [];
  /** Lane → the task running in it. A set of lanes could not name what is
   *  outstanding, and `settle` has to report the instances that did not land. */
  private readonly running = new Map<string, Task>();
  private readonly budgets = new Map<string, Budget>();
  private readonly errors: Array<{ pluginId: string; instanceId: string; message: string }> = [];
  private exact = false;
  /** Resolvers waiting for the queue to drain — `settleNative`. */
  private readonly drains = new Set<() => void>();

  constructor(
    private readonly dispatch: NativeDispatch,
    private readonly maxConcurrent = 4,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Export mode: nothing is dropped and the budget does not bench anyone. */
  setExactMode(on: boolean): void {
    this.exact = on;
    if (!on) return;
    // Entering export mode un-benches everyone: a plugin that was too slow for
    // a preview is not too slow for a file, and an export that silently used
    // the fallback path would produce a different picture from the one the user
    // approved in the viewport.
    this.budgets.clear();
  }

  exactMode(): boolean {
    return this.exact;
  }

  pendingCount(): number {
    return this.queue.length + this.running.size;
  }

  /** How long this plugin's last over-budget call took. For the plugin's own log. */
  lastCallMs(pluginId: string): number | null {
    return this.budgets.get(pluginId)?.lastMs ?? null;
  }

  /** Is this plugin currently skipped in preview because it blew the budget? */
  benched(pluginId: string): boolean {
    if (this.exact) return false;
    const budget = this.budgets.get(pluginId);
    return budget !== undefined && budget.benchedUntil > this.now();
  }

  /**
   * Failures since the last call, for the export gate.
   *
   * Taken rather than read, exactly like `takeGeneratorErrors`: the gate wants
   * "did anything fail while I was building this frame", and a list that is not
   * drained answers that question wrongly for every frame after the first.
   */
  takeErrors(): Array<{ pluginId: string; instanceId: string; message: string }> {
    return this.errors.splice(0);
  }

  /**
   * Record something that went wrong ABOUT a call rather than IN it.
   *
   * The call itself succeeded — the addon returned pixels — but the host
   * refused something it asked for, and the author needs to know. Same channel
   * as a failure so it reaches the same log and the same export gate, because
   * "your plugin renders but its cache is being thrown away every frame" is a
   * thing a publisher must be able to find out without a profiler.
   */
  note(pluginId: string, instanceId: string, message: string): void {
    this.errors.push({ pluginId, instanceId, message });
  }

  /**
   * Run a call, eventually.
   *
   * Resolves `null` for every "this did not happen" case — superseded, benched,
   * or a plugin with nothing to run — and an outcome otherwise. A refusal is an
   * outcome with `ok: false`, not a rejection: the caller's job is to render the
   * frame either way, and a rejection makes that an exception handler.
   */
  submit(job: NativeJob): Promise<NativeCallOutcome | null> {
    if (this.benched(job.pluginId)) return Promise.resolve(null);

    const id = ++this.seq;
    const lane = laneFor(job.threadSafety, job.pluginId, job.instanceId, id);
    // `full` lanes are unique per job, so there is nothing to coalesce against;
    // in export mode nothing is coalesced at all.
    const coalesce = !this.exact && job.threadSafety !== 'full';

    return new Promise<NativeCallOutcome | null>((resolve) => {
      const task: Task = { id, lane, job, coalesce, resolve };
      const queuedAt = coalesce ? this.queue.findIndex((t) => t.lane === lane) : -1;
      if (queuedAt >= 0) {
        // Replaced in place: the lane keeps its turn and the stale call never
        // runs. The same rule C2's pool applies, for the same reason.
        this.queue[queuedAt]!.resolve(null);
        this.queue[queuedAt] = task;
      } else {
        this.queue.push(task);
      }
      this.pump();
    });
  }

  /**
   * Wait for everything outstanding, or give up after `timeoutMs`.
   *
   * The export's settle gate. Returns the ids of the instances that did NOT
   * finish in time, which the caller turns into layer diagnostics — the same
   * shape `settleGenerators` returns, so the export loop treats both the same
   * way and a frame that is missing native work is refused rather than written
   * with last frame's pixels.
   */
  settle(timeoutMs: number): Promise<string[]> {
    if (this.pendingCount() === 0) return Promise.resolve([]);
    return new Promise<string[]>((resolve) => {
      let done = false;
      // Queued AND running. A call that is still inside the plugin's process
      // when the gate expires is exactly the one the export has to refuse the
      // frame over — reporting only the queue would let it through.
      const outstanding = (): string[] => [
        ...new Set([
          ...this.queue.map((t) => t.job.instanceId),
          ...[...this.running.values()].map((t) => t.job.instanceId),
        ]),
      ];
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.drains.delete(onDrain);
        resolve(outstanding());
      }, timeoutMs);
      const onDrain = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.drains.delete(onDrain);
        resolve([]);
      };
      this.drains.add(onDrain);
    });
  }

  /** Drop everything queued. Running calls are left to the host to kill. */
  dispose(): void {
    for (const task of this.queue.splice(0)) task.resolve(null);
    this.running.clear();
    this.budgets.clear();
    this.notifyDrained();
  }

  /** Forget one plugin's queued work — an unload, a reload, a revocation. */
  forget(pluginId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const task = this.queue[i]!;
      if (task.job.pluginId !== pluginId) continue;
      this.queue.splice(i, 1);
      task.resolve(null);
    }
    this.budgets.delete(pluginId);
    this.notifyDrained();
  }

  private pump(): void {
    while (this.running.size < this.maxConcurrent) {
      const index = this.queue.findIndex((t) => !this.running.has(t.lane));
      if (index < 0) return;
      const task = this.queue.splice(index, 1)[0]!;
      this.running.set(task.lane, task);
      void this.run(task);
    }
  }

  private async run(task: Task): Promise<void> {
    const started = this.now();
    let outcome: NativeCallOutcome;
    try {
      outcome = await this.dispatch(task.job);
    } catch (err) {
      // The dispatch itself threw — a bridge that is gone, a channel that was
      // refused. Reported like any other failure so the frame still renders.
      outcome = { ok: false, code: 'failed', error: (err as Error).message };
    }
    const elapsed = this.now() - started;

    if (!outcome.ok) {
      this.errors.push({
        pluginId: task.job.pluginId,
        instanceId: task.job.instanceId,
        message: outcome.error,
      });
    } else if (!this.exact && elapsed > NATIVE_PREVIEW_BUDGET_MS) {
      this.budgets.set(task.job.pluginId, {
        benchedUntil: this.now() + NATIVE_BUDGET_COOLDOWN_MS,
        lastMs: elapsed,
      });
    }

    this.running.delete(task.lane);
    task.resolve(outcome);
    this.pump();
    this.notifyDrained();
  }

  private notifyDrained(): void {
    if (this.pendingCount() > 0) return;
    for (const fn of [...this.drains]) fn();
  }
}

// ── The one the app uses ──────────────────────────────────────────────────────

let scheduler: NativeScheduler | null = null;

/**
 * The process-wide scheduler, created on first use.
 *
 * Lazy because a project with no native plugins must cost nothing: no map, no
 * timer, no module state. `hasNativeWork()` answers without creating one, which
 * is what the export loop and the snapshot path check.
 */
export function nativeScheduler(dispatch?: NativeDispatch): NativeScheduler | null {
  if (scheduler) return scheduler;
  if (!dispatch) return null;
  scheduler = new NativeScheduler(dispatch);
  return scheduler;
}

export function hasNativeWork(): boolean {
  return scheduler !== null && scheduler.pendingCount() > 0;
}

/** Export mode, for the duration of a render. Restored in the export's `finally`. */
export function setNativeExactMode(on: boolean): void {
  scheduler?.setExactMode(on);
}

/** Await outstanding native work. Returns the instance ids that did not land. */
export function settleNative(timeoutMs: number): Promise<string[]> {
  return scheduler ? scheduler.settle(timeoutMs) : Promise.resolve([]);
}

/** Native failures since the last call, for the export gate. */
export function takeNativeErrors(): Array<{ pluginId: string; instanceId: string; message: string }> {
  return scheduler ? scheduler.takeErrors() : [];
}

export function resetNativeSchedulerForTests(next?: NativeScheduler | null): void {
  scheduler?.dispose();
  scheduler = next ?? null;
}
