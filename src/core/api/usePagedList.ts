/**
 * usePagedList — the client half of a paged API endpoint.
 *
 * motion-back returns `{items, total, limit, offset}` from every list route,
 * but the dashboard used to call each one with a fixed `{limit: 50}` and render
 * the result as the whole library. This hook is the missing piece: it holds the
 * page, refetches when the page or the query changes, and hands the component
 * the `total` it needs to say what it isn't showing.
 *
 * The fetcher must be stable (`useCallback`). Its identity IS the query: when
 * it changes — a new search term, a different filter — the list snaps back to
 * page 1, because page 4 of the old query means nothing under the new one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Paginated, PageQuery } from './transport';

export type PagedFetcher<T> = (params: Required<PageQuery>) => Promise<Paginated<T>>;

export interface PagedList<T> {
  items: T[];
  /** Rows matching the query, ignoring paging. */
  total: number;
  limit: number;
  offset: number;
  /** 'loading' only when there is nothing to show yet — see `busy`. */
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** A request is in flight. The current page stays rendered meanwhile. */
  busy: boolean;
  setPage: (page: { limit: number; offset: number }) => void;
  /** Refetch the current page (after a create, a delete, a rename…). */
  reload: () => void;
  /**
   * Drop rows the caller just deleted, then refill the page from the server.
   *
   * Without the refill, deleting 3 of 24 rows leaves a short page while 119
   * more wait behind it — the local splice is only there so the rows vanish on
   * click instead of one round-trip later.
   */
  removeLocal: (ids: ReadonlySet<string> | string[]) => void;
}

export interface UsePagedListOptions {
  pageSize?: number;
  /** Skip fetching entirely — e.g. a tab that hasn't been opened. */
  enabled?: boolean;
  /** Fallback message when the failure carries none. */
  errorMessage?: string;
}

export function usePagedList<T extends { id: string }>(
  fetcher: PagedFetcher<T>,
  { pageSize = 24, enabled = true, errorMessage = 'Could not load this list.' }: UsePagedListOptions = {},
): PagedList<T> {
  const [limit, setLimit] = useState(pageSize);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  // A new query means page 1. Done during render (not in an effect) so the
  // fetch below runs once, with the right offset, instead of firing for the
  // stale page first and racing its own correction.
  const lastFetcher = useRef(fetcher);
  if (lastFetcher.current !== fetcher) {
    lastFetcher.current = fetcher;
    if (offset !== 0) setOffset(0);
  }

  // Only the newest request may write state: pages are switched faster than
  // they load, and an out-of-order response would render the wrong page.
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const ticket = ++seq.current;
    let live = true;
    setBusy(true);
    void (async () => {
      try {
        const page = await fetcher({ limit, offset });
        if (!live || ticket !== seq.current) return;
        setItems(page.items);
        setTotal(page.total);
        setStatus('ready');
        setError(null);
        // The page can outlive its rows (something else deleted them, or the
        // user was on the last page of a list that shrank). Step back rather
        // than show an empty table under a "…of 143" label.
        if (page.items.length === 0 && offset > 0 && page.total > 0) {
          const lastOffset = Math.max(0, (Math.ceil(page.total / limit) - 1) * limit);
          if (lastOffset !== offset) setOffset(lastOffset);
        }
      } catch (err) {
        if (!live || ticket !== seq.current) return;
        setStatus('error');
        setError(err instanceof Error && err.message ? err.message : errorMessage);
      } finally {
        if (live && ticket === seq.current) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [fetcher, limit, offset, enabled, nonce, errorMessage]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const setPage = useCallback((page: { limit: number; offset: number }) => {
    setLimit(page.limit);
    setOffset(page.offset);
  }, []);

  const removeLocal = useCallback(
    (ids: ReadonlySet<string> | string[]) => {
      const set = ids instanceof Set ? ids : new Set(ids);
      setItems((prev) => prev.filter((it) => !set.has(it.id)));
      setTotal((t) => Math.max(0, t - set.size));
      reload();
    },
    [reload],
  );

  return { items, total, limit, offset, status, error, busy, setPage, reload, removeLocal };
}
