/**
 * The renderer's half of auto-update: turn what the shell is doing into the one
 * notice a user should see, and nothing else.
 *
 * The shell downloads and installs on its own (see `electron/updater.ts`). The
 * only moment worth a user's attention is when a new version is sitting on disk
 * waiting for a restart — everything before that is noise they did not ask for,
 * and everything after is automatic.
 *
 * Deliberately quiet:
 *  • Checking and downloading say NOTHING. A progress bar for a background
 *    download the user never requested is an interruption dressed as courtesy.
 *  • Errors say nothing. A failed check is not the user's problem to solve, and
 *    an editor that complains about the network every six hours trains people
 *    to ignore it. Help ▸ Check for Updates reports failures, because there the
 *    user asked a question and deserves an answer.
 *
 * ## What this used to do, and why it stopped
 *
 * "Ready" used to raise a toast carrying a `Restart now` action. A toast is the
 * wrong shape for this one fact: it is easy to miss in the corner, it competes
 * with every other notice, and — the part that actually bit — it can be
 * DISMISSED, after which nothing on screen said an update was waiting even
 * though one was. The notice was as durable as a toast, and a pending update is
 * a standing fact about the app.
 *
 * So this hook now only records the fact (`updateStore`), and the fact is drawn
 * as a persistent, primary-coloured control in the title bar (`UpdateButton`) —
 * visible until the user acts on it. One affordance, not two: the toast is gone
 * rather than kept alongside, or a single update would announce itself twice.
 */

import { useEffect } from 'react';
import { useUpdateStore } from './updateStore';
import type { UpdateStatus } from '@app-types/motionEditor';

/** The bridge, or null in a browser build where there is nothing to update. */
function updates(): NonNullable<Window['motionEditor']>['updates'] | null {
  return window.motionEditor?.updates ?? null;
}

/**
 * Track whether a restart is pending, for the whole session.
 *
 * Returns nothing: this is a side effect on the update store, mounted once near
 * the app root (`AppRouter`), which is also where the title bar lives — so the
 * button is available on every route, including the pre-boot ones.
 */
export function useAutoUpdate(): void {
  useEffect(() => {
    const bridge = updates();
    if (!bridge) return;

    const onStatus = (status: UpdateStatus): void => {
      // Only `ready` is a fact worth showing. Every other kind leaves whatever
      // is already recorded alone — in particular a `checking` for the NEXT
      // version must not retract a restart that is still pending.
      if (status.kind !== 'ready') return;
      useUpdateStore.getState().setReady(status.version);
    };

    const unsubscribe = bridge.onStatus(onStatus);
    // Catch up: the update may have finished downloading before this mounted,
    // which is the common case on a reload.
    void bridge.getStatus().then(onStatus).catch(() => {
      /* no status yet — nothing to record */
    });
    return unsubscribe;
  }, []);
}
