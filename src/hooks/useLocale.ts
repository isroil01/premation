/**
 * Re-render when the UI language changes.
 *
 * `t()` returns plain strings, so a component that renders translated text and
 * must redraw on a switch reads the locale through one of these hooks.
 */

import { useSyncExternalStore } from 'react';
import { getCatalogueRevision, getLocale, subscribeLocale, type LocaleCode } from '@core/i18n';

/**
 * Bumped by every catalogue load. THE dependency for a `useMemo` that caches
 * `t()` output — not the locale code, which stays the same when a catalogue is
 * reloaded under it (a retried load, a dev hot-swap), and a memo keyed on the
 * code would keep serving the old strings.
 */
export function useCatalogueRevision(): number {
  return useSyncExternalStore(subscribeLocale, getCatalogueRevision);
}

/** The active locale code; re-renders on every catalogue load. */
export function useLocale(): LocaleCode {
  useCatalogueRevision();
  return getLocale();
}
