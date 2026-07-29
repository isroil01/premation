/**
 * Read-through cache for GET endpoints: dedupe, serve stale, revalidate.
 *
 * The dashboard and the account panel both re-fetch the same
 * handful of URLs constantly — on mount, on tab switch, on window focus, after
 * every mutation. Without this, going Dashboard → Editor → Dashboard is three
 * full round trips for data that has not changed, and the UI blanks to a
 * spinner every time.
 *
 * Three mechanisms, in the order they pay off:
 *
 *  1. **Single-flight.** Two components asking for the same URL in the same
 *     tick share one request. This is the one that matters most on mount,
 *     where a page and its header both want `/auth/me`.
 *  2. **Stale-while-revalidate.** A cached value is returned immediately, even
 *     when past its TTL, and refreshed in the background. Navigation renders
 *     real data on the first frame; the correction arrives a moment later.
 *  3. **Conditional GET.** The revalidation carries `If-None-Match`, so when
 *     nothing changed the server answers 304 with no body — and, importantly,
 *     the cached value keeps its object identity, so subscribers are not
 *     notified and React does not re-render a list that is byte-identical.
 *
 * Correctness rests on invalidation, not on the TTL: every mutation in
 * `client.ts` declares which tags it dirties. The TTL only bounds how long a
 * change made *elsewhere* (another device, an operator, a webhook) stays
 * invisible.
 */

import { conditionalGet } from './transport';

/** Cache scopes. A mutation names the ones it invalidates. */
export type CacheTag =
  | 'account'
  | 'projects'
  | 'trash'
  | 'versions'
  | 'assets'
  | 'renders'
  | 'billing'
  | 'conversations';

/**
 * Every tag, as a value.
 *
 * `satisfies` makes the compiler check this against the union above, so adding
 * a `CacheTag` without adding it here is a build error rather than a subtle
 * gap in `clear`.
 */
const ALL_TAGS = [
  'account',
  'projects',
  'trash',
  'versions',
  'assets',
  'renders',
  'billing',
  'conversations',
] as const satisfies readonly CacheTag[];

interface Entry<T = unknown> {
  data: T;
  etag?: string;
  /** When the data was last confirmed current (a 304 counts). */
  freshAt: number;
  tags: CacheTag[];
}

export interface CachedGetOptions {
  /** How long the value is served without a background refresh. */
  ttlMs?: number;
  tags?: CacheTag[];
  /** Skip the cache entirely and replace it with the result. */
  force?: boolean;
}

/** Long enough to cover a navigation round trip, short enough to feel live. */
const DEFAULT_TTL_MS = 30_000;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<(tags: CacheTag[]) => void>();

/**
 * Subscribe to cache changes. Called with the tags that changed, so a listener
 * interested in `projects` can ignore an `assets` update.
 */
export function subscribe(fn: (tags: CacheTag[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(tags: CacheTag[]): void {
  for (const fn of listeners) fn(tags);
}

/**
 * Read through the cache.
 *
 * Returns cached data synchronously-ish (a resolved promise) when it is fresh;
 * otherwise returns what it has and refreshes behind the scenes. Only a cold
 * miss actually waits for the network.
 */
export async function cachedGet<T>(path: string, opts: CachedGetOptions = {}): Promise<T> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const tags = opts.tags ?? [];
  const existing = entries.get(path) as Entry<T> | undefined;

  if (!opts.force && existing) {
    if (Date.now() - existing.freshAt < ttl) return existing.data;
    // Stale: hand back what we have and correct it in the background. The
    // rejection is swallowed — a failed background refresh must not surface as
    // an unhandled rejection on a screen that is rendering fine.
    void revalidate<T>(path, tags).catch(() => undefined);
    return existing.data;
  }

  return revalidate<T>(path, tags, opts.force);
}

/** Fetch (conditionally, when we hold an ETag), store, and notify on change. */
function revalidate<T>(path: string, tags: CacheTag[], force = false): Promise<T> {
  const pending = inflight.get(path) as Promise<T> | undefined;
  if (pending) return pending;

  const existing = entries.get(path) as Entry<T> | undefined;

  const promise = conditionalGet<T>(path, force ? undefined : existing?.etag)
    .then((res) => {
      if (res.notModified && existing) {
        // Still current. Bump the clock, keep the value — same reference, so
        // nothing downstream re-renders.
        existing.freshAt = Date.now();
        return existing.data;
      }
      const data = res.data as T;
      entries.set(path, { data, etag: res.etag, freshAt: Date.now(), tags });
      notify(tags);
      return data;
    })
    .catch((err) => {
      // A 401 means the session is gone; every cached response was fetched
      // under it, so none of it may be shown to whoever signs in next.
      if ((err as { status?: number }).status === 401) clear();
      throw err;
    })
    .finally(() => inflight.delete(path));

  inflight.set(path, promise);
  return promise;
}

/**
 * Drop everything under these tags and tell subscribers.
 *
 * Called by every mutation. Dropping rather than refetching is deliberate: the
 * screen that cares will ask again on its next render, and screens that don't
 * should not be issuing requests because something they aren't showing changed.
 */
export function invalidate(...tags: CacheTag[]): void {
  if (!tags.length) return;
  const set = new Set(tags);
  for (const [key, entry] of entries) {
    if (entry.tags.some((t) => set.has(t))) entries.delete(key);
  }
  notify(tags);
}

/** Drop a single URL, e.g. one project after it is renamed. */
export function invalidatePath(path: string): void {
  const entry = entries.get(path);
  if (!entry) return;
  entries.delete(path);
  notify(entry.tags);
}

/**
 * Write a value straight into the cache.
 *
 * Used when a mutation already returns the updated resource: the server just
 * told us the answer, so re-fetching it would be asking a question we have
 * been handed. No ETag is stored — the next read revalidates unconditionally,
 * which is the honest thing to do for a value we did not receive with one.
 */
export function put<T>(path: string, data: T, tags: CacheTag[] = []): void {
  entries.set(path, { data, freshAt: Date.now(), tags });
  notify(tags);
}

/** Everything. Called on sign-out and on any 401. */
export function clear(): void {
  entries.clear();
  inflight.clear();
  // Every tag, so nothing stays subscribed to a value from the old session.
  // Taken from ALL_TAGS rather than written out again: a second hand-written
  // list silently stops covering a tag the moment one is added, and the symptom
  // is a stale panel after sign-out that nobody traces back to this line.
  notify([...ALL_TAGS]);
}

/** Cache occupancy, for diagnostics. */
export function stats(): { entries: number; inflight: number } {
  return { entries: entries.size, inflight: inflight.size };
}
