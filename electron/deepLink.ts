/**
 * premation:// links: which one this is, decided without touching a window.
 *
 * Split out of main.ts so the decision is a pure function a test can pin. A
 * link is untrusted input — any web page can open one — so it only ever picks a
 * DESTINATION. Nothing in it is executed, and the query string is ignored on
 * every route except `oauth`, whose one-time code is the whole point of it.
 */

/** The URL scheme the app registers itself as the handler for. */
export const DEEP_LINK_SCHEME = 'premation';

export type DeepLinkRoute =
  /** A provider sign-in handing back its one-time code (or an error). */
  | { kind: 'oauth'; code: string | undefined; error: string | undefined }
  /**
   * `premation://connections`: bring the app forward and show the assistant
   * Connections. Main only says so; the page picks the screen
   * (src/hooks/useConnectionsDeepLink.ts).
   */
  | { kind: 'connections' }
  /**
   * `premation://billing`: a checkout in the system browser came back. It says
   * only "look again": the server decides whether anything was bought, so a
   * page that opens this link proves nothing (src/stores/checkoutStore.ts).
   */
  | { kind: 'billing' }
  /** Any other premation:// link: bring the app forward, nothing more. */
  | { kind: 'focus' };

/** Where a premation:// link goes, or null for one to ignore entirely. */
export function routeDeepLink(url: string | undefined): DeepLinkRoute | null {
  if (!url || !url.startsWith(`${DEEP_LINK_SCHEME}://`)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.host === 'oauth') {
    const code = parsed.searchParams.get('code') ?? undefined;
    const error = parsed.searchParams.get('error') ?? undefined;
    // Nothing to hand over: the link is ignored outright, window untouched.
    if (!code && !error) return null;
    return { kind: 'oauth', code, error };
  }

  // `premation://connections`, or `premation://connections/` — browsers and the
  // Windows shell both add the slash. A longer path is not this route; it falls
  // through to the plain focus like any other link we do not know.
  const bare = parsed.pathname === '' || parsed.pathname === '/';
  if (parsed.host.toLowerCase() === 'connections' && bare) return { kind: 'connections' };
  if (parsed.host.toLowerCase() === 'billing' && bare) return { kind: 'billing' };

  return { kind: 'focus' };
}
