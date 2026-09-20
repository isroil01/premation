/**
 * The publisher shelf's data, in one place.
 *
 * Four screens read the same two lists — the publisher record and the listings
 * under it — and every one of them can change the other. Claiming a namespace
 * creates the publisher; publishing adds a listing; withdrawing removes one;
 * flipping visibility rewrites a row. Each of those used to re-fetch from
 * wherever it happened to live, which is how a withdrawn plugin stayed on
 * screen until something else re-rendered.
 *
 * So loading and reloading live here, and the screens are handed data plus a
 * `refresh`. Nothing below this hook fetches.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginRegistryEnabled } from '@core/config/edition';
import {
  myPublishedPlugins,
  myPublishers,
  type MyRegistryPlugin,
  type PublisherRecord,
} from '@core/plugins/registry';

export type ShelfStatus =
  /** The hosted registry is not part of this build. */
  | 'unavailable'
  /** First load, nothing on screen yet — the only time a skeleton shows. */
  | 'loading'
  /** Loaded, and the user has not claimed a namespace. */
  | 'unclaimed'
  /** Loaded, with at least one publisher record. */
  | 'ready'
  /** The request failed. Almost always "not signed in". */
  | 'error';

export interface PublisherShelf {
  status: ShelfStatus;
  publisher: PublisherRecord | null;
  listings: MyRegistryPlugin[];
  error: string | null;
  /** Re-read both lists. Safe to call from anywhere; never sets `loading`. */
  refresh: () => Promise<void>;
  /** Clear a banner the user has read, without re-fetching. */
  dismissError: () => void;
  /** Surface a failure from a screen's own mutation. */
  reportError: (message: string | null) => void;
}

export function usePublisherShelf(): PublisherShelf {
  const [status, setStatus] = useState<ShelfStatus>(() =>
    pluginRegistryEnabled() ? 'loading' : 'unavailable',
  );
  const [publisher, setPublisher] = useState<PublisherRecord | null>(null);
  const [listings, setListings] = useState<MyRegistryPlugin[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A refresh that lands after the component has gone — a withdraw the user
  // navigated away from — must not set state on a dead tree.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!pluginRegistryEnabled()) return;
    try {
      const [publishers, mine] = await Promise.all([myPublishers(), myPublishedPlugins()]);
      if (!alive.current) return;
      setPublisher(publishers[0] ?? null);
      setListings(mine);
      setError(null);
      setStatus(publishers.length > 0 ? 'ready' : 'unclaimed');
    } catch (err) {
      if (!alive.current) return;
      // The registry answers "who am I" with a 401 when nobody is signed in,
      // which is not an error state the user can fix by retrying — so the
      // screen says what to do rather than showing a raw status.
      setError((err as Error).message || 'Could not load your publisher details.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    status,
    publisher,
    listings,
    error,
    refresh,
    dismissError: useCallback(() => setError(null), []),
    reportError: useCallback((message: string | null) => setError(message), []),
  };
}
