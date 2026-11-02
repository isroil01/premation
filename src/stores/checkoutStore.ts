/**
 * A checkout happening in the system browser, as the app sees it.
 *
 * Payment runs in the browser, not in the app window: saved cards, password
 * managers, wallets and bank 3-D Secure all live there, the address bar shows
 * whose page it is, and the open project is untouched. The cost is that the app
 * can no longer see the page, so this store waits for the answer instead.
 *
 * A store rather than component state because the wait outlives the Plan page:
 * the user goes back to work while the browser is open, and the news reaches
 * them wherever they are.
 *
 * Only `/billing/me` ends a wait. The `premation://billing` link and window
 * focus both mean "look now" and nothing more: any web page can open that link,
 * and closing the tab says nothing about whether the card went through.
 */

import { create } from 'zustand';
import { api, isAuthenticated, type BillingSummary } from '@core/api/client';
import { invalidate } from '@core/api/cache';
import { billingEnabled } from '@core/config/edition';
import { t } from '@core/i18n/t';
import { useEntitlementStore } from './entitlementStore';
import { useUIStore } from './uiStore';

export type CheckoutPhase =
  /** Nothing is waiting. */
  | 'idle'
  /** The checkout page was handed to the browser; the user is on it. */
  | 'browser'
  /** The browser said it finished; the provider's webhook is on its way. */
  | 'confirming'
  /** Finished in the browser, and the webhook is taking longer than it should. */
  | 'delayed';

/** Well inside the server's budget of 300 requests a minute per client. */
const BROWSER_POLL_MS = 8_000;
const CONFIRM_POLL_MS = 3_000;
/** Then only returning to the window checks: a forgotten tab must not poll all day. */
const POLL_FOR_MS = 30 * 60_000;
const CONFIRM_FOR_MS = 2 * 60_000;
/** The server's checkout link lives 24 hours; stop offering it before it dies. */
const LINK_LIFE_MS = 23 * 60 * 60_000;

interface CheckoutState {
  phase: CheckoutPhase;
  /** The page to reopen. Null when the app did not start this checkout. */
  url: string | null;
  /** The browser refused to open, so the link has to be carried over by hand. */
  openFailed: boolean;
  startedAt: number;
  returnedAt: number;
}

interface CheckoutActions {
  /** Hand a checkout page to the browser and start waiting for the answer. */
  begin: (url: string) => Promise<void>;
  reopen: () => Promise<void>;
  /** The browser came back (`premation://billing`). */
  noteReturned: () => Promise<void>;
  checkNow: () => Promise<void>;
  /** Stop waiting. A payment made anyway still lands: the server is the record. */
  dismiss: () => void;
}

const IDLE: CheckoutState = { phase: 'idle', url: null, openFailed: false, startedAt: 0, returnedAt: 0 };

/**
 * Show a payment page: the system browser on desktop, this tab on the web, which
 * has an address bar and a Back button. Throws when the browser would not open.
 */
export async function openPaymentPage(url: string): Promise<'browser' | 'tab'> {
  const open = window.motionEditor?.oauth?.openExternal;
  if (!open) {
    window.location.href = url;
    return 'tab';
  }
  await open(url);
  return 'browser';
}

/** The account now holds what the checkout was selling. */
function subscribed(summary: BillingSummary): boolean {
  return summary.hasSubscription && summary.plan.priceCents > 0;
}

export const useCheckoutStore = create<CheckoutState & CheckoutActions>((set, get) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped whenever a wait ends, so an answer still in flight cannot act on it.
  let wait = 0;
  let checking = false;

  const stop = (): void => {
    wait += 1;
    clearTimeout(timer);
    window.removeEventListener('focus', onFocus);
  };

  const finish = (): void => {
    stop();
    set(IDLE);
  };

  const welcome = (summary: BillingSummary): void => {
    finish();
    invalidate('billing', 'account');
    void useEntitlementStore.getState().refresh({ force: true });
    useUIStore.getState().notify({
      level: 'success',
      durationMs: 8000,
      // A trial takes no money, so "payment confirmed" would be untrue.
      message:
        summary.subscriptionStatus === 'on_trial'
          ? t('billing.notice.trialStarted', 'Your free trial has started. The full Library and Premation plugins are ready.')
          : t(
              'billing.notice.upgraded',
              'Welcome to Premation Cloud. The full Library, Premation plugins and unlimited cloud projects are ready.',
            ),
    });
  };

  const check = async (): Promise<void> => {
    if (checking) return;
    const { startedAt, url } = get();
    if (!isAuthenticated() || (url && Date.now() - startedAt > LINK_LIFE_MS)) {
      finish();
      return;
    }
    const asked = wait;
    checking = true;
    try {
      const summary = await api.getBilling({ force: true });
      if (asked === wait && subscribed(summary)) welcome(summary);
    } catch {
      // Offline for a moment. The next look decides; a wait is not a failure.
    } finally {
      checking = false;
    }
  };

  const schedule = (): void => {
    clearTimeout(timer);
    const { phase, startedAt, returnedAt } = get();
    const now = Date.now();
    let delay: number | null = null;
    if (phase === 'browser' && now - startedAt < POLL_FOR_MS) delay = BROWSER_POLL_MS;
    if (phase === 'delayed' && now - returnedAt < POLL_FOR_MS) delay = BROWSER_POLL_MS;
    if (phase === 'confirming') {
      if (now - returnedAt < CONFIRM_FOR_MS) {
        delay = CONFIRM_POLL_MS;
      } else {
        set({ phase: 'delayed' });
        delay = BROWSER_POLL_MS;
        useUIStore.getState().notify({
          level: 'info',
          durationMs: 8000,
          message: t(
            'billing.checkout.delayedToast',
            'Your subscription is still being confirmed. Your plan will update on its own.',
          ),
        });
      }
    }
    if (delay === null) return;
    const mine = wait;
    timer = setTimeout(() => {
      void check().then(() => {
        if (mine === wait) schedule();
      });
    }, delay);
  };

  // Coming back to the window is the moment someone expects the answer.
  function onFocus(): void {
    void check();
  }

  const watch = (): void => {
    window.removeEventListener('focus', onFocus);
    window.addEventListener('focus', onFocus);
    schedule();
  };

  const show = async (url: string): Promise<void> => {
    try {
      await openPaymentPage(url);
      set({ openFailed: false });
    } catch {
      set({ openFailed: true });
    }
  };

  return {
    ...IDLE,

    begin: async (url) => {
      // The web leaves for the page and returns with `?checkout=` in the address.
      if (!window.motionEditor?.oauth) {
        await openPaymentPage(url);
        return;
      }
      stop();
      set({ ...IDLE, phase: 'browser', url, startedAt: Date.now() });
      watch();
      await show(url);
    },

    reopen: async () => {
      const { url } = get();
      if (url) await show(url);
    },

    noteReturned: async () => {
      if (!billingEnabled() || !isAuthenticated()) return;
      if (get().phase === 'idle') {
        // The link can come from anywhere, or from a checkout started before a
        // restart. Only wait on an account that does not have the plan yet.
        const summary = await api.getBilling({ force: true }).catch(() => null);
        if (!summary || subscribed(summary)) return;
      }
      stop();
      set({ phase: 'confirming', returnedAt: Date.now() });
      watch();
      await check();
    },

    checkNow: () => check(),

    dismiss: finish,
  };
});
