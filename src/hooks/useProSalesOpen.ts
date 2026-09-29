/**
 * Whether new paid subscriptions are on sale right now.
 *
 * Reads `salesOpen` from the entitlement store and loads the plan catalog once
 * on mount (cached for an hour by the API layer). Returns true while unknown:
 * a server that predates the `purchasable` flag always sold its plans, and the
 * checkout endpoint is the real enforcement either way — this only decides
 * whether a "Subscribe"/"Upgrade" button is worth showing.
 */

import { useEffect } from 'react';
import { useEntitlementStore } from '@stores/entitlementStore';

export function useProSalesOpen(): boolean {
  const salesOpen = useEntitlementStore((s) => s.salesOpen);
  useEffect(() => {
    void useEntitlementStore.getState().refreshSales();
  }, []);
  return salesOpen !== false;
}
