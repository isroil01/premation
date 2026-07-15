/**
 * API environment resolution — bridges the two runtimes this app ships in.
 *
 *  • Browser / Vite dev: requests go to same-origin relative paths (`/api`,
 *    `/files`) which the Vite dev server proxies to the backend. The page CSP
 *    (`default-src 'self'`) is satisfied because it's same-origin.
 *  • Electron desktop: the renderer is loaded from a local file/protocol, so
 *    there is NO proxy — requests must target the backend's ABSOLUTE origin.
 *
 * We detect Electron at runtime via the preload bridge (env vars are baked at
 * build time and can't tell the two apart), and expose one backend origin that
 * both the API client and the asset-URL helper build on.
 */

/** True when running inside the Electron shell (preload bridge present). */
export const IS_ELECTRON =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as { electronAPI?: unknown }).electronAPI ||
    (window as unknown as { motionEditor?: unknown }).motionEditor);

/**
 * Absolute origin of the motion-back backend, used ONLY in Electron (where
 * there is no dev proxy). Overridable at build time via VITE_BACKEND_ORIGIN so
 * a packaged build can point at a deployed backend instead of localhost.
 */
export const BACKEND_ORIGIN: string = IS_ELECTRON
  ? ((import.meta as unknown as { env?: { VITE_BACKEND_ORIGIN?: string } }).env?.VITE_BACKEND_ORIGIN ||
      'http://localhost:4000')
  : '';

/**
 * Base URL for API requests. Electron → absolute `${origin}/api`; browser →
 * the proxied relative path from env (`/api`).
 */
export const API_URL: string = IS_ELECTRON
  ? `${BACKEND_ORIGIN}/api`
  : ((import.meta as unknown as { env?: { VITE_MOTION_API_URL?: string } }).env?.VITE_MOTION_API_URL || '/api');
