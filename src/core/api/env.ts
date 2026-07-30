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

interface BuildEnv {
  VITE_BACKEND_ORIGIN?: string;
  VITE_MOTION_API_URL?: string;
}

const buildEnv: BuildEnv = (import.meta as unknown as { env?: BuildEnv }).env ?? {};

/** Configured backend origin, trailing slash removed. Empty when unset. */
const configuredOrigin = (buildEnv.VITE_BACKEND_ORIGIN ?? '').trim().replace(/\/+$/, '');

/**
 * Absolute origin of the motion-back backend. Set at build time via
 * VITE_BACKEND_ORIGIN so a production build targets a deployed server; defaults
 * to localhost:4000, the port a locally-run or bundled server listens on.
 *
 * The same value feeds the shell's CSP `connect-src` at build time (see
 * csp.ts) — an origin the client uses but the policy does not name is blocked by
 * the browser before a request is ever sent.
 *
 * Empty in the browser unless configured: there the default is a same-origin
 * relative path that the dev server (or a reverse proxy) forwards.
 */
export const BACKEND_ORIGIN: string = IS_ELECTRON
  ? configuredOrigin || 'http://localhost:4000'
  : configuredOrigin;

/**
 * Base URL for API requests.
 *
 *  • Electron → always absolute: there is no proxy behind a file:// renderer.
 *  • Browser → VITE_MOTION_API_URL when set (`/api` in dev, proxied by Vite),
 *    else the configured backend origin, else the same-origin `/api`.
 *
 * A web build served from a different host than the API needs the backend's
 * CORS_ORIGINS to include the page's origin; a same-origin reverse proxy in
 * front of both avoids the question entirely.
 */
export const API_URL: string = IS_ELECTRON
  ? `${BACKEND_ORIGIN}/api`
  : buildEnv.VITE_MOTION_API_URL || (configuredOrigin ? `${configuredOrigin}/api` : '/api');
