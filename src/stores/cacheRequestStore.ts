/**
 * "Cache that span NOW" — a one-way request bus to the idle pre-render pump.
 *
 * The pump lives inside `useWorkspace`'s big viewport effect, because that is
 * the only place that holds the three things a pass needs: the backend, the
 * content canvas, and the freeze-mask canvas it hides the pass behind. None of
 * those can leave the closure, so a UI button cannot call the pump directly.
 *
 * What it CAN do is ask. This store carries no state anyone renders — just a
 * counter that the pump watches. Bumping it means "the user pressed Cache Work
 * Area; start a pass now instead of waiting out the 1.5s idle delay". The pump
 * still owns every decision about whether a pass is safe (playing, exporting,
 * hidden tab, span already full); a request is a nudge, not a command.
 *
 * A counter rather than a boolean because two requests in a row must both be
 * heard, and a boolean would need a reset write that races the listener.
 */

import { create } from 'zustand';

interface CacheRequestState {
  /** Bumped once per explicit request. Nothing renders this. */
  nonce: number;
  request(): void;
}

export const useCacheRequestStore = create<CacheRequestState>((set) => ({
  nonce: 0,
  request: () => set((s) => ({ nonce: s.nonce + 1 })),
}));

/** Ask the idle pump to start a pass over the current span immediately. */
export function requestPreviewCache(): void {
  useCacheRequestStore.getState().request();
}

/**
 * Subscribe to those requests. Returns the unsubscribe.
 *
 * The nonce is latched at subscribe time so a listener mounted after earlier
 * requests does not fire once for history it missed.
 */
export function onPreviewCacheRequest(listener: () => void): () => void {
  let last = useCacheRequestStore.getState().nonce;
  return useCacheRequestStore.subscribe((s) => {
    if (s.nonce === last) return;
    last = s.nonce;
    listener();
  });
}
