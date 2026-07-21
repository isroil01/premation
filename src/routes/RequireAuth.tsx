/**
 * RequireAuth — protects routes. By the time this renders, the initial token
 * hydration in AppRouter has resolved, so `status` is final: 'authenticated'
 * renders the route, anything else redirects to /login (preserving the intended
 * destination so we can return after sign-in).
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.hash }} />;
  }
  return <>{children}</>;
}

export default RequireAuth;
