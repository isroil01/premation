/**
 * The renderer's single copy of "may this account write to the cloud".
 *
 * The server decides it — `cloudAccess()` in the backend, the same function the
 * write guards enforce — and this store is a cache of that decision so the UI can
 * read it synchronously without a fetch on every render. It never computes
 * entitlement; a second implementation of "am I inside my trial?" here would
 * disagree with the guard the first time either was edited, and the disagreement
 * would either lock out a paying customer or give the product away.
 *
 * Read by:
 *   • CloudAutosave — to stop trying to save when the answer is no, instead of
 *     retrying a 403 forever with backoff and leaving the tab "unsaved".
 *   • ReadOnlyBanner — to say why, with export as the way out.
 *
 * Written by:
 *   • `refresh()` on boot and after any entitlement-changing event.
 *   • `noteWriteDenied()` when a write actually 403s — the authoritative signal
 *     that a client's cached "yes" has gone stale mid-session (a trial that
 *     lapsed while the editor was open), so the UI updates the instant it happens
 *     rather than at the next poll.
 *
 * Server-only concern: in the local edition there is no backend and no
 * entitlement to fetch, so `refresh()` no-ops and `access` stays null, which the
 * consumers read as "unrestricted".
 */

import { create } from 'zustand';
import { api, isAuthenticated, type CloudAccess } from '@core/api/client';
import { onWriteDenied } from '@core/api/transport';
import { billingEnabled } from '@core/config/edition';

interface EntitlementState {
  /** Null until first loaded, and forever in the local edition. */
  access: CloudAccess | null;
  /** The server-authored sentence, e.g. "Free trial — 6 days left." */
  message: string;
  loading: boolean;
}

interface EntitlementActions {
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  /**
   * Record that the server just refused a write for this account.
   *
   * Called from the API layer on a 403 with `code: 'read_only'`. It flips the
   * cached decision to no immediately AND kicks a refresh, so the message
   * ("trial ended" vs "card failed") catches up without waiting for it.
   */
  noteWriteDenied: (reason?: CloudAccess['reason'], message?: string) => void;
  reset: () => void;
}

/**
 * The one question every consumer actually asks.
 *
 * `null` means "no entitlement info" — true in the local edition and before the
 * first load — and both cases must read as ALLOWED. Defaulting a missing answer
 * to "blocked" would make the local edition, which has no paywall at all, behave
 * as if it were perpetually locked; and it would flash a read-only banner over
 * the cloud editor for the half-second before `/auth/me` returns.
 */
export function canWriteCloud(access: CloudAccess | null): boolean {
  return access ? access.write : true;
}

export function messageAfterEntitlementRefresh(current: string, access: CloudAccess): string {
  return access.write ? '' : current;
}

export const useEntitlementStore = create<EntitlementState & EntitlementActions>((set, get) => ({
  access: null,
  message: '',
  loading: false,

  refresh: async (opts) => {
    // No backend, no entitlement to fetch. Leaving `access` null is correct: the
    // local edition is unrestricted.
    if (!billingEnabled() || !isAuthenticated()) return;
    if (get().loading && !opts?.force) return;
    set({ loading: true });
    try {
      const me = await api.me({ force: opts?.force });
      set((state) => ({
        access: me.access,
        // A refresh of /auth/me can update the decision but cannot replace the
        // server-authored denial sentence (that endpoint does not return it).
        // Keep the sentence while access remains denied; clear it only after a
        // successful verification/payment refresh restores write access.
        message: messageAfterEntitlementRefresh(state.message, me.access),
      }));
    } catch {
      // Offline, or the server is down. Keep the last known decision rather than
      // dropping it — telling a user their access is gone because their wifi
      // dropped is the worst possible false alarm, and the write guards are the
      // real enforcement anyway. This cache is only ever an optimisation.
    } finally {
      set({ loading: false });
    }
  },

  noteWriteDenied: (reason, message) => {
    const prev = get().access;
    set({
      access: {
        // Preserve whatever we knew; override only the parts a denial proves.
        read: prev?.read ?? true,
        write: false,
        reason: reason ?? prev?.reason ?? 'trial_expired',
        daysRemaining: 0,
        writeEndsAt: prev?.writeEndsAt ?? null,
      },
      ...(message ? { message } : {}),
    });
    // Get the authoritative message and dates, but do not block on it.
    void get().refresh({ force: true });
  },

  reset: () => set({ access: null, message: '', loading: false }),
}));

/**
 * Wire the API layer's read-only signal into the store, once, at module load.
 *
 * This module is imported by authStore, which the app boots early, so the
 * listener is live before the first request. Registered here rather than in a
 * component so it survives remounts and cannot be double-registered.
 */
onWriteDenied((detail) => {
  useEntitlementStore.getState().noteWriteDenied(
    detail.reason as CloudAccess['reason'] | undefined,
    detail.message,
  );
});
