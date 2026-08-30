/**
 * AppRouter — top-level client router. Uses HashRouter because the production
 * Electron build loads the renderer from file:// (dist/index.html), where the
 * HTML5 history API has no server to rewrite deep links.
 *
 * On boot it validates any stored token exactly once (authStore.hydrate) and
 * holds routing behind a splash until that resolves, so RequireAuth never has
 * to guess whether a returning user is still signed in.
 *
 * In the local edition none of that applies: there is no backend, so there is no
 * token to validate and no account-bound route to protect. The auth and
 * dashboard routes are not registered at all — absent, rather than present and
 * failing — and the app opens straight into the editor.
 */

import { useEffect, useState, lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';
import { cloudAccountsEnabled, cloudProjectsEnabled } from '@core/config/edition';
import { RequireAuth } from './RequireAuth';
import { TitleBar } from '@layout/TitleBar/TitleBar';
import { ModalHost, ContextMenuHost, NotificationHost } from '@layout/overlays';
import { useAutoUpdate } from '@core/update/useAutoUpdate';
import { applyPasteboardColor } from '@core/theme/pasteboard';
import { applyAccentColor } from '@core/theme/accent';
import { useOAuthDeepLink } from '@hooks/useOAuthDeepLink';

import { LoadingScreen } from '@components/LoadingScreen';

function BootSplash(): JSX.Element {
  return <LoadingScreen message="Loading…" fullScreen />;
}

// ── Route-level code splitting ───────────────────────────────────────
// The EditorPage pulls in the entire renderer, scene graph, animation
// engine, and ~76 store/service imports through Providers.tsx. Lazy-loading
// it keeps the initial bundle (login / dashboard) lean and fast.
const AuthPage = lazy(() => import('../pages/AuthPage').then(m => ({ default: m.AuthPage })));
const DashboardPage = lazy(() => import('../pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const EditorPage = lazy(() => import('../pages/EditorPage').then(m => ({ default: m.EditorPage })));
const PopoutRoute = lazy(() => import('../pages/PopoutRoute').then(m => ({ default: m.PopoutRoute })));
// The headless CLI's route. Lazy like the editor because it pulls the same
// engine in, and because a GUI launch must never pay for it.
const RenderPage = lazy(() => import('../pages/RenderPage').then(m => ({ default: m.RenderPage })));
const VerifyEmailPage = lazy(() =>
  import('../pages/VerifyEmailPage').then(m => ({ default: m.VerifyEmailPage })),
);
const OAuthCallbackPage = lazy(() =>
  import('../pages/OAuthCallbackPage').then(m => ({ default: m.OAuthCallbackPage })),
);

function AppLayout(): JSX.Element {
  const location = useLocation();
  const isEditor = location.pathname.startsWith('/editor') || location.pathname.startsWith('/popout');

  // Desktop: catch the OAuth one-time code the system browser hands back through
  // the premation:// deep link and route it to /oauth. No-op on the web.
  useOAuthDeepLink();

  // Mounted beside NotificationHost, and app-wide rather than editor-only: an
  // update that finished downloading while the user sat on the dashboard is
  // still worth telling them about.
  useAutoUpdate();

  useEffect(() => {
    if (isEditor) {
      document.body.classList.add('editor-active');
      applyPasteboardColor();
      applyAccentColor();
    } else {
      document.body.classList.remove('editor-active');
      const root = document.documentElement;
      root.style.removeProperty('--color-pasteboard');
      root.style.removeProperty('--color-primary');
    }
  }, [isEditor]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <TitleBar />
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <Suspense fallback={<BootSplash />}>
        <Routes>
          {/* The local edition has no dashboard to land on — the editor IS the
              app — so the root goes straight there. */}
          <Route
            path="/"
            element={<Navigate to={cloudProjectsEnabled() ? '/dashboard' : '/editor'} replace />}
          />
          {cloudAccountsEnabled() && (
            <>
              <Route path="/login" element={<AuthPage mode="login" />} />
              <Route path="/register" element={<AuthPage mode="register" />} />
              {/* Both are public: a locked-out user cannot authenticate, and the
                  emailed token is itself the credential. */}
              <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
              <Route path="/reset-password" element={<AuthPage mode="reset" />} />
              {/* Where the backend's OAuth callback drops the browser, carrying a
                  one-time code to exchange for a session. */}
              <Route path="/oauth" element={<OAuthCallbackPage />} />
              {/* The email-confirmation gate. A signed-in but unverified account
                  is sent here by RequireAuth and can reach nothing else until it
                  types the 6-digit code (the page itself requires a session and
                  bounces a verified user on to the dashboard). */}
              <Route path="/verify-email" element={<VerifyEmailPage />} />
            </>
          )}
          <Route path="/popout/:panelId" element={<PopoutRoute />} />
          {cloudProjectsEnabled() && (
            <Route path="/dashboard" element={<RequireAuth><DashboardPage /></RequireAuth>} />
          )}
          <Route path="/editor" element={<RequireAuth><EditorPage /></RequireAuth>} />
          {/* A `:projectId` names a CLOUD project — it is what binds autosave,
              thumbnails and version history to a backend row. Unregistered in
              the local edition so a stale `#/editor/<id>` bookmark falls to the
              catch-all and opens the plain editor, instead of mounting a loader
              that has no server to ask. */}
          {cloudProjectsEnabled() && (
            <Route path="/editor/:projectId" element={<RequireAuth><EditorPage /></RequireAuth>} />
          )}
          {/* No /admin route: the admin console lives in the motion-landing web
              app, not in the desktop app. Anything under /admin falls through to
              the catch-all below. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </div>
      <ModalHost />
      <ContextMenuHost />
      <NotificationHost />
    </div>
  );
}

/**
 * The headless render route, recognised before anything else mounts.
 *
 * `premation render` loads `#/render` into a hidden window, and what it needs
 * is the ENGINE, not the application. Routing it here — above the router, above
 * the auth splash — is what keeps the app shell out of it: no title bar, no
 * modal hosts, no OAuth deep-link listener, and no auto-update poll (which in a
 * headless launch calls an IPC channel that deliberately is not registered, and
 * logged an error on every run). It is also outside RequireAuth on purpose:
 * rendering a project already on this disk is not an account-bound operation,
 * and a build agent cannot answer a sign-in screen.
 *
 * The page itself refuses to act unless the main process really has a job for
 * it, so a stray `#/render` in a dev build renders a line of text and stops.
 */
function isHeadlessRenderRoute(): boolean {
  return typeof window !== 'undefined' && window.location.hash.startsWith('#/render');
}

export function AppRouter(): JSX.Element {
  const hydrate = useAuthStore((s) => s.hydrate);
  const [booted, setBooted] = useState(false);
  // Read once, at first render: the hash cannot change in a headless window,
  // and a hook after the early return would be a conditional hook.
  const [headless] = useState(isHeadlessRenderRoute);

  useEffect(() => {
    // No accounts in the local edition, so there is no stored token to validate
    // — skip the call rather than let it reach for a backend that isn't there.
    // Boot immediately: this splash exists only to hide the token round-trip.
    // A headless render has no session to validate and nothing to gate on it.
    if (headless || !cloudAccountsEnabled()) {
      setBooted(true);
      return;
    }
    let alive = true;
    hydrate().finally(() => { if (alive) setBooted(true); });
    return () => { alive = false; };
  }, [hydrate, headless]);

  if (headless) {
    return (
      <Suspense fallback={null}>
        <RenderPage />
      </Suspense>
    );
  }

  if (!booted) return <BootSplash />;

  return (
    <HashRouter>
      <AppLayout />
    </HashRouter>
  );
}

export default AppRouter;
