import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCheckoutStore } from '@stores/checkoutStore';

/**
 * Whether `premation://billing` shows the Plan page. Only over the dashboard:
 * leaving the editor cancels a pending cloud autosave, and a web page must not
 * be able to do that to an open project (useConnectionsDeepLink has the long
 * version). Over the editor the news arrives as a toast instead.
 */
export function checkoutReturnShowsPlan(route: string): boolean {
  return route === '/' || route === '/dashboard' || route === '/dashboard/';
}

/**
 * Bridge `premation://billing` into the app. Electron main has already restored
 * and focused the window. Mounted once at the router root, so the link is caught
 * on every page. No-op on the web, which returns through the address bar.
 */
export function useCheckoutReturn(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Read when the link arrives, not when the subscription was made.
  const route = useRef(pathname);
  useEffect(() => {
    route.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const deepLink = window.motionEditor?.deepLink;
    if (!deepLink) return undefined;
    return deepLink.onCheckoutReturn(() => {
      void useCheckoutStore.getState().noteReturned();
      if (checkoutReturnShowsPlan(route.current)) navigate('/dashboard?tab=billing');
    });
  }, [navigate]);
}
