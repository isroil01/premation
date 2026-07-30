/**
 * The renderer's cache of "may I write", and the way it goes stale to `false`.
 *
 * The invariant that matters most is the DEFAULT: a missing decision reads as
 * ALLOWED. The local edition has no paywall, and the cloud editor must not flash
 * a read-only bar over someone's work in the half-second before /auth/me returns.
 * Getting that backwards would lock out every user for whom the feature does not
 * even apply.
 */

import { canWriteCloud, useEntitlementStore } from './entitlementStore';
import type { CloudAccess } from '@core/api/client';

const access = (over: Partial<CloudAccess> = {}): CloudAccess => ({
  read: true,
  write: true,
  reason: 'active',
  daysRemaining: null,
  writeEndsAt: null,
  ...over,
});

describe('canWriteCloud', () => {
  it('allows when there is no decision yet — local edition and pre-load', () => {
    // The load-bearing default. `null` is "no paywall applies here", not "blocked".
    expect(canWriteCloud(null)).toBe(true);
  });

  it('follows the server’s decision when there is one', () => {
    expect(canWriteCloud(access({ write: true }))).toBe(true);
    expect(canWriteCloud(access({ write: false, reason: 'trial_expired' }))).toBe(false);
  });
});

describe('noteWriteDenied', () => {
  beforeEach(() => useEntitlementStore.getState().reset());

  it('flips the cached decision to blocked the instant a write 403s', () => {
    // The store starts optimistic (a trial that was fine when the editor opened).
    useEntitlementStore.setState({ access: access({ write: true }) });

    useEntitlementStore.getState().noteWriteDenied('trial_expired', 'Your trial has ended.');

    const a = useEntitlementStore.getState().access;
    expect(a?.write).toBe(false);
    expect(a?.reason).toBe('trial_expired');
    expect(useEntitlementStore.getState().message).toBe('Your trial has ended.');
  });

  it('preserves what it already knew and only overrides what a denial proves', () => {
    useEntitlementStore.setState({
      access: access({ write: true, writeEndsAt: '2026-08-01T00:00:00.000Z' }),
    });
    useEntitlementStore.getState().noteWriteDenied();
    const a = useEntitlementStore.getState().access;
    // read stays true (you can still export), the paid-through date is not lost,
    // but write is now false.
    expect(a).toMatchObject({ read: true, write: false, writeEndsAt: '2026-08-01T00:00:00.000Z' });
  });

  it('defaults the reason sensibly when the 403 carried none', () => {
    useEntitlementStore.setState({ access: null });
    useEntitlementStore.getState().noteWriteDenied();
    expect(useEntitlementStore.getState().access?.write).toBe(false);
    expect(useEntitlementStore.getState().access?.reason).toBeDefined();
  });

  it('reset clears everything for the next account on this machine', () => {
    useEntitlementStore.setState({ access: access({ write: false }), message: 'x' });
    useEntitlementStore.getState().reset();
    expect(useEntitlementStore.getState().access).toBeNull();
    expect(useEntitlementStore.getState().message).toBe('');
  });
});
