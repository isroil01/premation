/**
 * Spacebar transport — After Effects' most reflexive shortcut.
 *
 * Space had no play binding at all: it only pushed the temporary Hand tool for
 * pan, so play/pause was mouse-only, while the app's own onboarding told users
 * "Spacebar plays". AE resolves the same conflict by intent:
 *
 *   tap Space            → play / pause
 *   hold Space + drag    → pan the viewport (temporary Hand tool)
 *
 * So we push the Hand tool on key-down as before, and on key-up decide: if the
 * user never dragged, they meant to play.
 *
 * This is a window listener rather than a viewport one because Space must work
 * with focus in the timeline too. It's deliberately NOT a ShortcutManager
 * binding: that layer captures and stops propagation, which would swallow the
 * key before the viewport could pan with it.
 */

import { useEffect } from 'react';
import { keyFrom } from '@motion/workspace';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { getTimelineController } from '@core/timeline/TimelineController';

function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    el?.tagName === 'INPUT' ||
    el?.tagName === 'TEXTAREA' ||
    el?.isContentEditable === true
  );
}

export function useSpaceTransport(): void {
  useEffect(() => {
    let spaceDown = false;
    let panned = false;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || isTextEntry(e.target)) return;
      // Space scrolls the page / re-triggers the focused button otherwise.
      e.preventDefault();
      if (e.repeat) return;
      spaceDown = true;
      panned = false;
      getWorkspaceController().ws.feedKeyDown(keyFrom(e, performance.now()));
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || isTextEntry(e.target)) return;
      e.preventDefault();
      getWorkspaceController().ws.feedKeyUp(keyFrom(e, performance.now()));
      if (spaceDown && !panned) getTimelineController().togglePlay();
      spaceDown = false;
    };

    // Any drag while Space is held means the user was panning, not playing.
    const onPointerMove = (e: PointerEvent): void => {
      if (spaceDown && e.buttons !== 0) panned = true;
    };

    // Focus loss (alt-tab, a modal) strands `spaceDown` — key-up never arrives.
    const onBlur = (): void => {
      getWorkspaceController().ws.cancelTransientInput();
      spaceDown = false;
      panned = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('blur', onBlur);
    return () => {
      getWorkspaceController().ws.cancelTransientInput();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
