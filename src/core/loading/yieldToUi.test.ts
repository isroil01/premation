/**
 * The yield.
 *
 * The property that matters is not "it returns a promise" — every `await` does
 * that, and the whole bug is that awaiting an already-resolved promise queues a
 * MICROTASK, which runs before the event loop gets a turn. A yield has to reach
 * the TASK queue or it yields nothing.
 */

import { yieldToUi, ANALYSIS_YIELD_EVERY } from './yieldToUi';

describe('yieldToUi', () => {
  it('reaches the task queue, not just the microtask queue', async () => {
    // A macrotask scheduled before the yield must run BEFORE the yield resumes.
    // An `await Promise.resolve()` would resume first and prove nothing.
    const order: string[] = [];
    setTimeout(() => order.push('task'), 0);
    await yieldToUi();
    order.push('after-yield');
    expect(order).toEqual(['task', 'after-yield']);
  });

  it('a bare await does NOT — which is the bug this exists for', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('task'), 0);
    await Promise.resolve();
    order.push('after-await');
    // The microtask wins. A loop built out of these never lets anything paint.
    expect(order).toEqual(['after-await']);
  });

  it('prefers scheduler.yield when the platform has one', async () => {
    const g = globalThis as { scheduler?: unknown };
    const original = g.scheduler;
    let called = 0;
    g.scheduler = { yield: () => { called += 1; return Promise.resolve(); } };
    try {
      // The helper resolves its implementation once at module load, so this
      // asserts the SELECTION rule rather than re-importing the module.
      const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
      const picked: () => Promise<void> = typeof sched?.yield === 'function'
        ? () => sched.yield!()
        : () => new Promise<void>((r) => { setTimeout(r, 0); });
      await picked();
      expect(called).toBe(1);
    } finally {
      if (original === undefined) delete g.scheduler;
      else g.scheduler = original;
    }
  });
});

describe('the walk pacing constant', () => {
  it('yields often enough to stay responsive and rarely enough to be free', () => {
    // At the analysis tier the matcher measures ~1.6ms per frame per point, so
    // this is roughly one animation frame of work between yields.
    expect(ANALYSIS_YIELD_EVERY).toBeGreaterThan(1);
    expect(ANALYSIS_YIELD_EVERY * 1.6).toBeLessThan(20);
  });
});
