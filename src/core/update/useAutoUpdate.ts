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
 *  • The toast never auto-dismisses (`durationMs: 0`) and never repeats for a
 *    version already announced. It is a standing fact, not an event.
 */

import { useEffect, useRef } from 'react';
import { useUIStore } from '@stores/uiStore';
import type { UpdateStatus } from '@app-types/motionEditor';

/** The bridge, or null in a browser build where there is nothing to update. */
function updates(): NonNullable<Window['motionEditor']>['updates'] | null {
  return window.motionEditor?.updates ?? null;
}

/**
 * Raise the "update ready" toast, once per version.
 *
 * Returns nothing: this is a side effect on the notification store, mounted
 * once near the app root.
 */
export function useAutoUpdate(): void {
  /**
   * Versions already announced this session.
   *
   * The shell re-publishes its last status to any renderer that mounts (so a
   * reload does not lose the notice), and a long session can see several
   * checks. Without this, one pending update produces a new toast every six
   * hours and a stack of identical ones after a reload.
   */
  const announced = useRef(new Set<string>());

  useEffect(() => {
    const bridge = updates();
    if (!bridge) return;

    const onStatus = (status: UpdateStatus): void => {
      if (status.kind !== 'ready') return;
      if (announced.current.has(status.version)) return;
      announced.current.add(status.version);

      useUIStore.getState().notify({
        level: 'success',
        message: `Premation ${status.version} is ready — it installs when you quit.`,
        // Stays until dismissed. A restart prompt that vanishes after 2.6s is
        // one the user will never manage to act on.
        durationMs: 0,
        action: {
          label: 'Restart now',
          onSelect: () => {
            void bridge.restartAndInstall();
          },
        },
      });
    };

    const unsubscribe = bridge.onStatus(onStatus);
    // Catch up: the update may have finished downloading before this mounted,
    // which is the common case on a reload.
    void bridge.getStatus().then(onStatus).catch(() => {
      /* no status yet — nothing to announce */
    });
    return unsubscribe;
  }, []);
}
