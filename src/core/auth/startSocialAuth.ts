import { api } from '@core/api/client';

/**
 * Begin a provider (Google/GitHub) sign-in.
 *
 * Two paths, picked by whether we are inside the desktop shell:
 *
 *  - **Desktop** — the consent screen cannot run inside an Electron window
 *    (Google refuses embedded webviews), so we hand the start URL to the shell,
 *    which opens it in the SYSTEM browser. The one-time code returns through the
 *    premation:// deep link and is routed to `/oauth` by `useOAuthDeepLink`.
 *  - **Web** — a normal full-page navigation to the backend start URL. The
 *    consent screen is a page the user interacts with and it refuses framing;
 *    we come back at `#/oauth` with the code (see OAuthCallbackPage).
 */
export function startSocialAuth(provider: 'google' | 'github'): void {
  const desktopOAuth = typeof window !== 'undefined' ? window.motionEditor?.oauth : undefined;
  if (desktopOAuth) {
    void desktopOAuth.openExternal(api.oauthStartUrl(provider, 'desktop'));
    return;
  }
  window.location.href = api.oauthStartUrl(provider);
}
