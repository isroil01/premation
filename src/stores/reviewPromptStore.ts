/**
 * Whether to ask this account for a review, and the state of the asking.
 *
 * ## When it is armed
 *
 * The trigger is "has made their first project" — the server decides everything
 * else (`shouldPrompt`: verified, never asked on ANY machine, no review yet).
 *
 * It fires on arrival at the dashboard rather than at the instant a project is
 * created, and that is deliberate. Creating a project navigates straight into
 * the editor, so a dialog opened at that moment would flash past on the way out
 * of the page. Waiting until the next time they are on the dashboard means the
 * same trigger, at a moment where it can actually be read, and it puts nothing
 * in front of somebody mid-flow.
 *
 * ## Why the answer lives on the server
 *
 * "Not now" is recorded by `POST /reviews/dismiss`, not in local storage. A
 * dismissal kept in the browser is one that expires at the next reinstall, and
 * on a second machine the prompt would be new again — which is how a one-off
 * ask turns into nagging.
 */

import { create } from 'zustand';
import { api, type MyReview, type ReviewDraft } from '@core/api/client';

interface ReviewPromptState {
  /** The dialog is on screen. */
  open: boolean;
  /** A submit is in flight. */
  submitting: boolean;
  /** Set when the last submit failed; cleared on the next attempt. */
  error: string | null;
  /** What the server last told us. Null until asked. */
  status: MyReview | null;
  /**
   * Asked already in this session.
   *
   * Guards against the dashboard's effects re-running — a remount must not
   * produce a second network call, and must not reopen a dialog the user has
   * just closed.
   */
  consideredThisSession: boolean;
}

interface ReviewPromptActions {
  /**
   * Ask the server whether the prompt is owed, and open it if so.
   *
   * Safe to call on every dashboard mount: it is a no-op after the first call
   * per session, and it swallows failures — not discovering that we could ask
   * for a review is not worth an error on somebody's dashboard.
   */
  consider: (opts: { hasProjects: boolean }) => Promise<void>;
  /** Open it deliberately, from a menu or a settings row. */
  openNow: () => Promise<void>;
  /** "Not now", recorded server-side so it is honoured everywhere. */
  dismiss: () => Promise<void>;
  /** Close without answering — Escape, or the scrim. Does NOT record a refusal. */
  close: () => void;
  submit: (draft: ReviewDraft) => Promise<void>;
  clearError: () => void;
}

export const useReviewPromptStore = create<ReviewPromptState & ReviewPromptActions>(
  (set, get) => ({
    open: false,
    submitting: false,
    error: null,
    status: null,
    consideredThisSession: false,

    consider: async ({ hasProjects }) => {
      if (get().consideredThisSession) return;
      // The trigger. Nothing to review before they have made something.
      if (!hasProjects) return;
      set({ consideredThisSession: true });
      try {
        const status = await api.myReview();
        set({ status, open: status.shouldPrompt });
      } catch {
        /* Asked on a later visit instead. */
      }
    },

    openNow: async () => {
      set({ open: true, error: null });
      try {
        // Forced: this path exists so somebody can edit a review they already
        // wrote, and a cached "you have none" would show them an empty form.
        set({ status: await api.myReview({ force: true }) });
      } catch {
        /* The form still works; it just starts empty. */
      }
    },

    dismiss: async () => {
      set({ open: false });
      // Fire-and-forget: being closed must not wait on the network. If it
      // fails, the worst case is being asked once more on another machine.
      void api.dismissReviewPrompt().catch(() => undefined);
    },

    close: () => set({ open: false, error: null }),

    submit: async (draft) => {
      if (get().submitting) return;
      set({ submitting: true, error: null });
      try {
        await api.submitReview(draft);
        // Re-read rather than assume: the server decides the status, and an
        // edit to a pending review comes back pending rather than accepted.
        const status = await api.myReview({ force: true }).catch(() => get().status);
        set({ submitting: false, open: false, status: status ?? null });
      } catch (err) {
        set({
          submitting: false,
          error: messageOf(err, 'Could not send that just now. Try again.'),
        });
        throw err;
      }
    },

    clearError: () => set({ error: null }),
  }),
);

/** Pull the server's `{ code, message }` out of a failed request. */
function messageOf(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string | { message?: string } } }).body;
  const msg = typeof body?.message === 'object' ? body.message.message : body?.message;
  return msg || (err instanceof Error ? err.message : fallback);
}
