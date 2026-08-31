/**
 * Coalescing repaints for landed media decodes.
 *
 * ## The loop this exists to cut
 *
 * `exactVideoFrames` gives the renderer a SYNCHRONOUS contract — `get()` never
 * blocks, a miss queues a decode, and `AnimationChanged` repaints when it
 * lands. That contract is right. What was wrong is the *rate*: during streaming
 * playback the pump decodes up to `STREAM_AHEAD` frames past the playhead, and
 * every one of those landings fired its own `AnimationChanged`. That event is
 * the app's widest signal — the timeline tracks, the inspector, autosave, the
 * dirty flag, the thumbnail workers, history's debounce and both viewport
 * surfaces all hang off it — so one decoded frame paid a full app-wide fan-out.
 * On the viewport side each fan-out could schedule a repaint, so a displayed
 * frame ran `buildSnapshot` and the whole effect chain more than once.
 *
 * That is a positive feedback loop, which is why it reads as "effects get
 * disproportionately slower as the stack grows": a slower stack leaves a longer
 * window for decodes to land mid-render, which queues more repaints, which
 * makes the stack slower still.
 *
 * ## What this does
 *
 * A landed decode marks its source dirty and asks the injected scheduler for
 * ONE flush. Every landing inside that window collapses into that flush. The
 * flush then emits one `AnimationChanged` per distinct dirty source — never one
 * per decoded frame.
 *
 * Per distinct SOURCE, not one event overall, is deliberate: the payload's
 * `nodeId` is the only thing that tells a listener which media moved, and
 * collapsing two sources into one id would be a behaviour change rather than a
 * rate change. In practice the count is one or two, and the storm being cut is
 * 25 landings on a single source inside a single frame.
 *
 * ## Why the scheduler is injected
 *
 * Same reason `DecoderIO`, `ExactSourceLoader`, `VideoFactory` and
 * `LocalBlobResolver` are injected: so the seam is testable with a fake clock,
 * and so an OFFLINE context can opt out of the wall clock entirely.
 *
 * `requestAnimationFrame` is a *display* callback. In a hidden Electron window
 * (`premation render`, whose whole design is a real DOM in a window that is
 * never shown) it is throttled to roughly 1 Hz by `backgroundThrottling`, and
 * in a fully occluded window it can stop firing altogether. A deterministic
 * fixed-timestep render loop that parked work behind it would crawl or hang.
 * Offline entry points therefore install `syncFlushScheduler`, which flushes
 * before `request()` returns — no wall clock anywhere on the export path.
 */

import { getEventBus } from '@core/events/EventBus';

/** Hands a flush callback to whatever decides when "one frame" is over. */
export type FlushScheduler = (flush: () => void) => void;

/**
 * The interactive default: one flush per displayed frame.
 *
 * Falls back to a macrotask where `requestAnimationFrame` is missing (node,
 * a worker, a stripped test environment) rather than dropping the flush — a
 * repaint that never happens is a frozen viewport.
 */
export const rafFlushScheduler: FlushScheduler = (flush) => {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  if (typeof raf === 'function') raf(flush);
  else setTimeout(flush, 0);
};

/** Offline/headless: flush before `request()` returns. No wall clock. */
export const syncFlushScheduler: FlushScheduler = (flush) => flush();

/**
 * Dirty-flag + one-flush-per-window coalescer.
 *
 * `emit` is injected too, so a test can count repaints without an EventBus.
 */
export class RepaintScheduler {
  /** Sources that landed a decode since the last flush. */
  private readonly dirty = new Set<string>();
  private armed = false;
  /** Flushes performed — the counter the perf work is measured against. */
  private flushes = 0;

  constructor(
    private readonly emit: (nodeId: string) => void,
    private schedule: FlushScheduler = rafFlushScheduler,
  ) {}

  /**
   * Note that `nodeId`'s pixels changed and ask for a repaint.
   *
   * Idempotent within a window: the 2nd..Nth call before the flush costs a Set
   * lookup and nothing else.
   */
  request(nodeId: string): void {
    this.dirty.add(nodeId);
    if (this.armed) return;
    this.armed = true;
    this.schedule(() => this.flush());
  }

  /**
   * Emit the pending repaints now.
   *
   * Drains into a local first: a listener may synchronously do work that marks
   * another source dirty, and that belongs to the NEXT window, not this one —
   * otherwise a busy listener could spin this loop forever.
   */
  flush(): void {
    this.armed = false;
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    this.flushes += 1;
    for (const id of ids) this.emit(id);
  }

  /**
   * Swap the scheduler (offline entry points, tests).
   *
   * Flushes anything already pending under the OLD scheduler first. Without
   * that, a repaint armed against a rAF that is about to stop firing — exactly
   * the hidden-window case — would be stranded.
   */
  setScheduler(schedule: FlushScheduler): void {
    if (this.armed) this.flush();
    this.schedule = schedule;
  }

  /** True while a flush is armed and not yet run. */
  get pending(): boolean {
    return this.armed;
  }

  /** Distinct sources waiting on the next flush. */
  get pendingCount(): number {
    return this.dirty.size;
  }

  /** Flushes performed since construction — diagnostics and tests. */
  get flushCount(): number {
    return this.flushes;
  }

  /** Drop pending work without emitting (teardown). */
  reset(): void {
    this.dirty.clear();
    this.armed = false;
    this.flushes = 0;
  }
}

/**
 * The app-wide media repaint channel.
 *
 * `media: true` on the payload is what makes the classification in
 * `mediaRepaint.ts` a FACT rather than a guess about the shape of a URL — see
 * that module's header for what the guess used to miss.
 */
export const mediaRepaints = new RepaintScheduler((nodeId) => {
  getEventBus().emit('AnimationChanged', { nodeId, media: true });
});

/** Mark `nodeId`'s decoded pixels changed; one repaint per frame follows. */
export function requestMediaRepaint(nodeId: string): void {
  mediaRepaints.request(nodeId);
}

/** Offline/headless entry points call this once at startup. */
export function setMediaRepaintScheduler(schedule: FlushScheduler): void {
  mediaRepaints.setScheduler(schedule);
}

/** Emit any pending media repaint immediately. */
export function flushMediaRepaints(): void {
  mediaRepaints.flush();
}
