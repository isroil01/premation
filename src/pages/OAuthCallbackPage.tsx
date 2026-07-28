/**
 * Where a provider sign-in lands.
 *
 * The backend's OAuth callback redirects the browser here with either
 * `?code=<one-time>` or `?error=<message>`. The code is deliberately NOT a
 * session token: it is single-use, expires in a minute, and is exchanged for
 * the real tokens over POST — so nothing durable is ever exposed in a URL,
 * browser history, or a Referer header.
 *
 * This page therefore has exactly one job, and does it once.
 */

import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@core/api/client';
import { setSession } from '@core/api/session';
import { useAuthStore } from '@stores/authStore';
import { LoadingScreen } from '@components/LoadingScreen';
import styles from './AuthPage.module.css';

export function OAuthCallbackPage(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const [error, setError] = useState<string>(() => params.get('error') ?? '');

  const code = params.get('code');

  /**
   * React 18 mounts effects twice in StrictMode, and the code is single-use —
   * the second exchange would fail and show an error over a sign-in that
   * actually succeeded. A ref, not state: it has to be set synchronously,
   * before the second invocation can read it.
   */
  const claimed = useRef(false);

  useEffect(() => {
    if (!code || claimed.current) return;
    claimed.current = true;

    let alive = true;
    api
      .oauthExchange(code)
      .then(async (result) => {
        await setSession(result);
        if (!alive) return;
        useAuthStore.setState({ status: 'authenticated', user: result.user, error: null });
        // `replace`, so Back does not return to a URL holding a spent code.
        navigate('/dashboard', { replace: true });
      })
      .catch((err: Error) => {
        if (alive) setError(err.message || 'Could not complete sign-in.');
      });

    return () => { alive = false; };
  }, [code, navigate]);

  // Already signed in and nothing to do — e.g. a refresh of this URL.
  if (!code && !error && status === 'authenticated') return <Navigate to="/dashboard" replace />;

  if (error || !code) {
    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>Sign-in didn’t complete</h1>
            <p className={styles.subtitle}>{error || 'That sign-in link is missing its code.'}</p>
          </div>
          <button type="button" className={styles.submitBtn} onClick={() => navigate('/login', { replace: true })}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return <LoadingScreen message="Completing sign-in…" fullScreen />;
}

export default OAuthCallbackPage;
