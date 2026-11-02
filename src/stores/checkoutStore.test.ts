import { api, type BillingSummary } from '@core/api/client';
import { useCheckoutStore } from './checkoutStore';
import { useEntitlementStore } from './entitlementStore';
import { useUIStore } from './uiStore';

let signedIn = true;

jest.mock('@core/config/edition', () => ({
  ...jest.requireActual('@core/config/edition'),
  billingEnabled: () => true,
}));
jest.mock('@core/api/client', () => ({
  ...jest.requireActual('@core/api/client'),
  isAuthenticated: () => signedIn,
  api: { getBilling: jest.fn(), me: jest.fn() },
}));

const free = { plan: { priceCents: 0 }, hasSubscription: false, subscriptionStatus: null } as unknown as BillingSummary;
const paid = { plan: { priceCents: 900 }, hasSubscription: true, subscriptionStatus: 'active' } as unknown as BillingSummary;
const trial = { ...paid, subscriptionStatus: 'on_trial' } as unknown as BillingSummary;
const URL = 'https://premation.lemonsqueezy.com/checkout/custom/abc';

const store = (): ReturnType<typeof useCheckoutStore.getState> => useCheckoutStore.getState();
const toasts = (): string[] => useUIStore.getState().notifications.map((n) => n.message);
const flush = async (ms = 0): Promise<void> => {
  await jest.advanceTimersByTimeAsync(ms);
};

describe('checkoutStore', () => {
  let openExternal: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    signedIn = true;
    openExternal = jest.fn().mockResolvedValue(undefined);
    (window as unknown as { motionEditor: unknown }).motionEditor = { oauth: { openExternal } };
    jest.mocked(api.getBilling).mockReset().mockResolvedValue(free);
    jest.spyOn(useEntitlementStore.getState(), 'refresh').mockResolvedValue(undefined);
    useUIStore.setState({ notifications: [] });
    store().dismiss();
  });

  afterEach(() => {
    store().dismiss();
    jest.useRealTimers();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  });

  it('hands the page to the browser and keeps waiting while nothing has changed', async () => {
    await store().begin(URL);
    expect(openExternal).toHaveBeenCalledWith(URL);
    expect(store().phase).toBe('browser');

    await flush(8_000);
    expect(api.getBilling).toHaveBeenCalledWith({ force: true });
    expect(store().phase).toBe('browser');
    expect(toasts()).toEqual([]);
  });

  it('notices the subscription by itself, with no return link at all', async () => {
    await store().begin(URL);
    jest.mocked(api.getBilling).mockResolvedValue(paid);
    await flush(8_000);
    expect(store().phase).toBe('idle');
    expect(toasts()).toEqual([expect.stringContaining('Welcome to Premation Cloud')]);
  });

  it('says a trial started rather than that a payment went through', async () => {
    await store().begin(URL);
    jest.mocked(api.getBilling).mockResolvedValue(trial);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(toasts()).toEqual([expect.stringContaining('free trial has started')]);
  });

  it('keeps the link when the browser will not open, so it can be carried over', async () => {
    openExternal.mockRejectedValueOnce(new Error('no browser'));
    await store().begin(URL);
    expect(store()).toMatchObject({ phase: 'browser', openFailed: true, url: URL });
    await store().reopen();
    expect(store().openFailed).toBe(false);
  });

  it('confirms quickly after the return link, then says it is taking long', async () => {
    await store().begin(URL);
    await store().noteReturned();
    expect(store().phase).toBe('confirming');

    await flush(121_000);
    expect(store().phase).toBe('delayed');
    expect(toasts()).toEqual([expect.stringContaining('still being confirmed')]);

    jest.mocked(api.getBilling).mockResolvedValue(paid);
    await flush(8_000);
    expect(store().phase).toBe('idle');
  });

  it('does not celebrate a return link on an account that already had the plan', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(paid);
    await store().noteReturned();
    expect(store().phase).toBe('idle');
    expect(toasts()).toEqual([]);
  });

  it('ignores an answer that arrives after the wait was dismissed', async () => {
    await store().begin(URL);
    let answer: (s: BillingSummary) => void = () => undefined;
    jest.mocked(api.getBilling).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    await flush(8_000);
    store().dismiss();
    answer(paid);
    await flush();
    expect(toasts()).toEqual([]);
  });

  it('stops polling a forgotten tab, but still looks when the window comes back', async () => {
    await store().begin(URL);
    await flush(31 * 60_000);
    jest.mocked(api.getBilling).mockClear();
    await flush(10 * 60_000);
    expect(api.getBilling).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(api.getBilling).toHaveBeenCalledTimes(1);
  });

  it('drops the wait once the checkout link has expired', async () => {
    await store().begin(URL);
    await flush(23 * 60 * 60_000 + 1);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(store().phase).toBe('idle');
  });

  it('drops the wait when the account signs out', async () => {
    await store().begin(URL);
    signedIn = false;
    await flush(8_000);
    expect(store().phase).toBe('idle');
    expect(toasts()).toEqual([]);
  });
});
