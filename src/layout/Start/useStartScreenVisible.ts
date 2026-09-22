/**
 * When the local edition's start screen is up.
 *
 * It used to be dismissed only by ITS OWN buttons — each handler called
 * `onDismiss` after its own open succeeded. Every other way a project becomes
 * open went around it: Ctrl+O and File ▸ Open loaded the project BEHIND the
 * screen, a crash-recovery Restore did the same, and so would an OS open-file
 * event. The screen's claim is "there is no project yet", so the rule is stated
 * once, against the one source of truth for that: it is visible exactly while
 * the ProjectManager has no current project and the user has not waved it away.
 *
 * Subscribing also brings it BACK when a project is closed. That was avoided
 * while Close left the scene on the canvas (re-covering work the user was still
 * looking at); Close now unloads the document, so what is underneath is the
 * same empty editor as at boot, and the recents are the useful thing to show.
 *
 * "Continue without a project" is session state, not a preference, and it is
 * spent by the next project: dismiss, open, close → the screen returns.
 */

import { useCallback, useEffect, useState } from 'react';
import { getProjectManager } from '@core/services/coreServices';

export interface StartScreenVisibility {
  visible: boolean;
  /** "Not now" — hide until a project has been opened and closed again. */
  dismiss: () => void;
}

/*
 * A request from OUTSIDE the screen to get out of the way.
 *
 * A project opening is covered by the subscription below. A crash-recovery
 * Restore of a scene that never had a project is not: it is a "scratch" scene,
 * so no project arrives, `hasProject` stays false, and the recovered work
 * loaded BEHIND this screen — the user clicked Restore and saw the project
 * browser, with nothing to say their work was back (seen in the desktop app).
 */
const dismissRequests = new Set<() => void>();
/**
 * A dismissal that arrived before there was a screen to dismiss.
 *
 * On a COLD launch the recovery prompt is up seconds before this hook mounts
 * (the start screen sits behind a lazy route). Restore clicked in that window
 * found no listener, and the screen then mounted — three seconds later — on top
 * of the work it had just brought back. The request is held until a screen
 * takes it; a project opening spends it, exactly like an ordinary dismissal.
 */
let dismissalPending = false;

/** Hide the start screen now — for a restore that brings back a scene with no project. */
export function dismissStartScreen(): void {
  dismissalPending = true;
  for (const fn of [...dismissRequests]) fn();
}

/** Test seam: forget a held dismissal. */
export function resetStartScreenDismissal(): void {
  dismissalPending = false;
}

export function useStartScreenVisible(enabled: boolean): StartScreenVisibility {
  const [hasProject, setHasProject] = useState(() => getProjectManager().getState().current !== null);
  const [dismissed, setDismissed] = useState(() => dismissalPending);

  useEffect(() => {
    const pm = getProjectManager();
    // Re-read on subscribe: a project opened between the first render and this
    // effect (boot-time recovery, a CLI path) has already emitted.
    setHasProject(pm.getState().current !== null);
    return pm.subscribe((s) => {
      const open = s.current !== null;
      setHasProject(open);
      // A project arriving spends the dismissal, so the close that follows is
      // offered the recents again.
      if (open) { setDismissed(false); dismissalPending = false; }
    });
  }, []);

  const dismiss = useCallback(() => setDismissed(true), []);
  useEffect(() => {
    dismissRequests.add(dismiss);
    return () => { dismissRequests.delete(dismiss); };
  }, [dismiss]);
  return { visible: enabled && !hasProject && !dismissed, dismiss };
}
