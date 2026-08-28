/**
 * The one fact the whole update UI is built on: which version, if any, is
 * sitting on disk waiting for a restart.
 *
 * ## Why this is a store and not a toast
 *
 * It used to be neither — the "ready" status went straight into a notification
 * and the notification WAS the state. That made the notice as durable as a
 * toast, which is to say not durable at all: a stray dismiss (or the Escape key
 * on the way to something else) and the only thing telling the user a new
 * version existed was gone until the next launch. The update had been
 * downloaded, it was ready, and nothing on screen said so.
 *
 * A pending update is a STANDING FACT about the app, so it is held as state and
 * rendered as a persistent control (`UpdateButton` in the title bar). The
 * button is visible for exactly as long as the fact is true, and the only thing
 * that clears it is acting on it.
 *
 * Deliberately not persisted to disk: the shell re-publishes its status to any
 * renderer that mounts, so the truth is re-derived on every load rather than
 * cached into something that can go stale against an app that has since
 * installed the update.
 */

import { create } from 'zustand';

interface UpdateState {
  /** Version waiting on disk, or null when there is nothing to install. */
  readyVersion: string | null;
  /** True from the moment a restart is requested — the button is spent. */
  restarting: boolean;
  setReady(version: string | null): void;
  setRestarting(v: boolean): void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  readyVersion: null,
  restarting: false,
  setReady: (version) => set({ readyVersion: version }),
  setRestarting: (v) => set({ restarting: v }),
}));

/** Non-hook read, for callers outside React. */
export function pendingUpdateVersion(): string | null {
  return useUpdateStore.getState().readyVersion;
}
