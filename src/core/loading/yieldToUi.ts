/**
 * Hand the main thread back, mid-loop.
 *
 * ## Why an `await` is not already enough
 *
 * A long `async` loop that awaits an already-resolved promise never lets the
 * browser paint. Awaiting queues a MICROTASK, and microtasks run to exhaustion
 * before the event loop gets a turn — so a walk that awaits a frame it already
 * has occupies the thread continuously no matter how many `await`s it contains.
 * That is why a loop can look asynchronous, be full of awaits, and still freeze
 * the UI completely.
 *
 * `scheduler.yield` resumes at a lower priority than user input and rendering,
 * which is exactly what a background walk wants: the editor stays interactive
 * and repaints while the work continues. `setTimeout(0)` is the fallback — it
 * also yields, just with a clamp and no priority ordering.
 *
 * ## Where this matters
 *
 * The export loop (`offlineRenderer`), which is where this was first written
 * and is lifted from, and the tracking walks. It is shared rather than copied
 * because the two would otherwise diverge on the fallback, and the fallback is
 * the branch that runs everywhere `scheduler` has not shipped yet.
 */

export const yieldToUi: () => Promise<void> = (() => {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === 'function') return () => sched.yield!();
  return () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
})();

/**
 * How many frames of an analysis walk may run between yields.
 *
 * Measured: the matcher costs ~1.6ms per frame per point on the analysis tier
 * (960x540) and ~53ms on a 4K original — the tier is what made the difference,
 * and this is what stops the remainder adding up. Eight frames is roughly one
 * animation frame's worth of work at the analysis tier and one yield per ~13ms,
 * which keeps a drag or a Cancel click responsive without the yield itself
 * becoming the cost.
 *
 * Deliberately a frame COUNT rather than a time budget: a walk that measured
 * elapsed time would yield unpredictably often on a fast machine and rarely on
 * a slow one, which is backwards.
 */
export const ANALYSIS_YIELD_EVERY = 8;
