/**
 * RequireAuth — protects routes. By the time this renders, the initial token
 * hydration in AppRouter has resolved, so `status` is final: 'authenticated'
 * renders the route, anything else redirects to /login (preserving the intended
 * destination so we can return after sign-in).
 *
 * In the local edition there is nothing to protect and nowhere to redirect to —
 * /login is not even a registered route — so it renders its children. The gate
 * stays in the tree rather than being removed at the call sites so that the
 * route table reads the same in both editions, and only one file decides what
 * "signed in" means when there are no accounts.
 *
 * It also enforces email confirmation: an authenticated-but-unverified account
 * may reach nothing here — every protected route bounces it to the confirm-code
 * page until it enters the code. OAuth accounts arrive already verified, so this
 * only ever stops fresh email/password sign-ups.
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@stores/authStore';
import { cloudAccountsEnabled } from '@core/config/edition';

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const status = useAuthStore((s) => s.status);
  const emailVerified = useAuthStore((s) => s.user?.emailVerified ?? false);
  const location = useLocation();

  if (!cloudAccountsEnabled()) return <>{children}</>;

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.hash }} />;
  }
  if (!emailVerified) {
    return <Navigate to="/verify-email" replace />;
  }
  return <>{children}</>;
}

export default RequireAuth;
