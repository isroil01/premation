/**
 * This window's engine viewport ids.
 *
 * The page names its own viewports locally — the main viewport is 1
 * (`MAIN_VIEWPORT`), the overlay mirror, the focus set and the hidden-layer
 * list are all keyed by that — but the ENGINE numbers viewports across every
 * window: main hands each window a base (0 for the editor, a block of its own
 * for a pop-out) and the window's main viewport is base + 1. In the editor
 * window the two are the same number, which is why sending the local id
 * worked there; in a pop-out it addressed the EDITOR's viewport — the pop-out
 * got no overlay geometry (nothing selectable, no handles) and overwrote the
 * editor's subscription.
 *
 * So: every command that names a viewport by its local id goes through
 * `engineViewport`, and frames coming back are filed under the local id.
 */

import { processEngineBridge } from './process/processEngine';

let base: Promise<number> | null = null;

/** The first engine viewport id of this window (0 in the editor window). Asked once. */
export function windowViewportBase(): Promise<number> {
  base ??= (async () => {
    try {
      return (await processEngineBridge()?.viewportBase?.()) ?? 0;
    } catch {
      return 0;
    }
  })();
  return base;
}

/** The engine's id for this window's viewport `local` (1 = the main viewport). */
export async function engineViewport(local: number): Promise<number> {
  return (await windowViewportBase()) + local;
}

/** Only a pop-out window (`#/popout/…`, opened by main) has a base other than 0. */
function isPopout(): boolean {
  return typeof window !== 'undefined' && window.location.hash.startsWith('#/popout/');
}

/**
 * Run `send` with the engine's id for viewport `local`.
 *
 * Synchronously in the editor window — its base is 0 by construction, and the
 * commands sent this way (hide a layer under the text editor, the focus set)
 * were synchronous before pop-outs had ids of their own; keeping them so keeps
 * their order with the edits around them. A pop-out asks main for its base
 * first.
 */
export function withEngineViewport(local: number, send: (viewport: number) => void): void {
  const now = engineViewportNow(local);
  if (now !== null) {
    send(now);
    return;
  }
  void engineViewport(local).then(send);
}

/** The engine's id for viewport `local` when it is known without asking (the editor window), else null. */
export function engineViewportNow(local: number): number | null {
  return isPopout() ? null : local;
}
