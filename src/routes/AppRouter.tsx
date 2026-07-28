/**
 * AppRouter — top-level client router. Uses HashRouter because the production
 * Electron build loads the renderer from file:// (dist/index.html), where the
 * HTML5 history API has no server to rewrite deep links.
 *
 * On boot it validates any stored token exactly once (authStore.hydrate) and
 * holds routing behind a splash until that resolves, so RequireAuth never has
 * to guess whether a returning user is still signed in.
 */

import { useEffect, useState, lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';
import { RequireAuth } from './RequireAuth';
import { TitleBar } from '@layout/TitleBar/TitleBar';
import { ModalHost, ContextMenuHost, NotificationHost } from '@layout/overlays';
import { applyPasteboardColor } from '@core/theme/pasteboard';
import { applyAccentColor } from '@core/theme/accent';

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
const OAuthCallbackPage = lazy(() =>
  import('../pages/OAuthCallbackPage').then(m => ({ default: m.OAuthCallbackPage })),
);

function AppLayout(): JSX.Element {
  const location = useLocation();
  const isEditor = location.pathname.startsWith('/editor') || location.pathname.startsWith('/popout');

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
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          {/* Both are public: a locked-out user cannot authenticate, and the
              emailed token is itself the credential. */}
          <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
          <Route path="/reset-password" element={<AuthPage mode="reset" />} />
          {/* Where the backend's OAuth callback drops the browser, carrying a
              one-time code to exchange for a session. */}
          <Route path="/oauth" element={<OAuthCallbackPage />} />
          <Route path="/popout/:panelId" element={<PopoutRoute />} />
          <Route path="/dashboard" element={<RequireAuth><DashboardPage /></RequireAuth>} />
          <Route path="/editor" element={<RequireAuth><EditorPage /></RequireAuth>} />
          <Route path="/editor/:projectId" element={<RequireAuth><EditorPage /></RequireAuth>} />
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

export function AppRouter(): JSX.Element {
  const hydrate = useAuthStore((s) => s.hydrate);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let alive = true;
    hydrate().finally(() => { if (alive) setBooted(true); });
    return () => { alive = false; };
  }, [hydrate]);

  if (!booted) return <BootSplash />;

  return (
    <HashRouter>
      <AppLayout />
    </HashRouter>
  );
}

export default AppRouter;
