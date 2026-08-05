/**
 * The history baseline sync — why one gesture was two undo entries.
 *
 * ## Rule 5·0: the observable, and why no unit test saw this for so long
 *
 * The user-visible symptom is "Ctrl+Z takes two presses for one edit", and it is
 * only observable through the REAL APP, because the command layer already
 * satisfies "one entry per gesture" on its own — `applyRigPreset` measured 1
 * from a direct call and 2 through the UI. The extra entry came from a second,
 * independent history mechanism that only runs in a booted app.
 *
 * What CAN be guarded here is the mechanism underneath it: `record()` must not
 * push a snapshot when the baseline already matches the current state, and the
 * baseline must be refreshed whenever the undo stack moves.
 *
 * ## The bug this pins
 *
 * `historyStore` subscribed to `UndoStackChanged` at MODULE SCOPE.
 * `Application.boot()` calls `setEventBus(new EventBus())`, so that subscription
 * was attached to a bus that boot then discarded — it never fired once. The
 * listener existed and was correct; it was wired to nothing.
 *
 * `Providers.tsx` already carries a note about this exact hazard, for the
 * cross-window sync. This was a second victim, and the fix is the same one:
 * subscribe INSIDE boot.
 */

import { EventBus, setEventBus, getEventBus } from '@core/events/EventBus';
import { attachHistoryBaselineSync } from './historyStore';

describe('attachHistoryBaselineSync', () => {
  it('subscribes to the bus that is live WHEN IT IS CALLED, not at import time', () => {
    // The whole bug in one assertion. Boot replaces the bus; a subscription made
    // before that lands on the discarded one. Calling the attach function after
    // the swap must reach the new bus.
    setEventBus(new EventBus());
    const busAtAttach = getEventBus();
    let fired = 0;
    const off = getEventBus().on('UndoStackChanged', () => { fired += 1; });
    const sync = attachHistoryBaselineSync();

    busAtAttach.emit('UndoStackChanged', { canUndo: true, canRedo: false });
    expect(fired).toBe(1);

    sync.dispose();
    off.dispose();
  });

  it('a subscription made BEFORE a bus swap is orphaned — the failure it fixes', () => {
    // Positive control for the claim above, and the reason module-scope
    // subscriptions are unsafe here. Without this the test above could pass on a
    // codebase where the bus is never replaced, proving nothing.
    setEventBus(new EventBus());
    let fired = 0;
    getEventBus().on('UndoStackChanged', () => { fired += 1; });

    // Boot's swap.
    setEventBus(new EventBus());
    getEventBus().emit('UndoStackChanged', { canUndo: true, canRedo: false });

    expect(fired).toBe(0);
  });

  it('returns a disposer so boot can tear it down', () => {
    setEventBus(new EventBus());
    const sync = attachHistoryBaselineSync();
    let after = 0;
    getEventBus().on('UndoStackChanged', () => { after += 1; });
    sync.dispose();
    getEventBus().emit('UndoStackChanged', { canUndo: false, canRedo: false });
    // The unrelated listener still fires — only ours was removed.
    expect(after).toBe(1);
  });
});
