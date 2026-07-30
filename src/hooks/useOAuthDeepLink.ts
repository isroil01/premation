import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Bridge the desktop OAuth deep link into the router.
 *
 * When the system browser finishes a provider sign-in, electron/main forwards
 * the one-time code (or an error) here via `window.motionEditor.oauth.onResult`.
 * We route it to `/oauth?code=…` so the existing OAuthCallbackPage runs the
 * exchange — the identical path a web redirect takes, so there is one place that
 * knows how to spend a handoff code. No-op on the web (no shell bridge).
 *
 * Mounted once at the router root so the code is caught no matter which screen
 * is showing when the browser hands it back.
 */
export function useOAuthDeepLink(): void {
  const navigate = useNavigate();
  // A one-time code must be routed once. The OS can, in rare cases, deliver the
  // deep link twice; without this the second delivery would navigate back to
  // /oauth with an already-spent code and show a spurious error over the
  // now-signed-in app.
  const handledCode = useRef<string | null>(null);
  useEffect(() => {
    const oauth = window.motionEditor?.oauth;
    if (!oauth) return;
    return oauth.onResult(({ code, error }) => {
      if (code) {
        if (handledCode.current === code) return;
        handledCode.current = code;
      }
      const params = new URLSearchParams();
      if (code) params.set('code', code);
      else if (error) params.set('error', error);
      navigate(`/oauth?${params.toString()}`);
    });
  }, [navigate]);
}
