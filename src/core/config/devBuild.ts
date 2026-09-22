/**
 * Is this a development build (`import.meta.env.DEV`)?
 *
 * Set once at boot from `main.tsx`, which owns the `import.meta` read — it
 * trips Jest under this repo's CJS transform, the same reason `./edition` and
 * `./uiPlatform` are configured from there. Unset (tests, a route that renders
 * before boot) reads as a PRODUCTION build: developer-only chrome is opt-in.
 */

let devBuild = false;

export function setDevBuild(isDev: boolean): void {
  devBuild = isDev;
}

export function isDevBuild(): boolean {
  return devBuild;
}
