/**
 * Where "our backend" is, and what counts as a path into it.
 *
 * This is the SSRF guard for `api.request`, and it is the reason that bridge is
 * not simply `fetch(url, init)` with a token attached. A general fetch bridge
 * would be an open relay carrying the user's credentials, reachable by anything
 * running in the renderer — which is `credentials:get` with extra steps, and the
 * whole point of this change is to remove that.
 *
 * So the renderer sends a PATH, never a URL. Everything that could redirect the
 * request somewhere else is refused here, before a request object exists:
 *
 *   • absolute URLs, of any scheme, including `file:` and `http:`
 *   • scheme-relative URLs (`//evil.test/x`), which are absolute in disguise and
 *     the single most-missed case in path validators
 *   • backslash variants (`\\evil.test\x`, `/\evil.test`), which several URL
 *     parsers normalise INTO scheme-relative
 *   • `..` traversal, which can climb out of `/api` onto sibling routes
 *   • anything that, once joined, does not still sit under the base URL
 *
 * The last check is the backstop: whatever the first four miss, the result must
 * still be on our origin and under our base path, or it does not go out.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The origin baked into the packaged app, written by electron-builder's
 * `extraMetadata` at package time. Same mechanism `edition.ts` uses, and for
 * the same reason: main cannot read `import.meta.env`, so a build-time value it
 * needs has to arrive through the packaged manifest.
 *
 * Located from `__dirname` rather than `app.getAppPath()` on purpose. This
 * module's whole design note is that it stays free of Electron so the path
 * rejection table can be tested without one — and importing `electron` here
 * would also fail CI outright, where `npm ci --ignore-scripts` leaves the
 * package without the `path.txt` its postinstall writes.
 *
 * Compiled main lives at `<root>/dist-electron/main.js`, so the manifest is one
 * level up in both worlds: inside the asar when packaged, and the repo's own
 * package.json in a dev run — which carries no `backendOrigin`, so a dev run
 * falls through to localhost exactly as it did before.
 */
function bakedOrigin(): string | undefined {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { backendOrigin?: unknown };
    return typeof pkg.backendOrigin === 'string' ? pkg.backendOrigin : undefined;
  } catch {
    // Unreadable or absent. Fall through to localhost, exactly as before this
    // field existed — an unreadable manifest must not decide where the app talks.
    return undefined;
  }
}

/**
 * The backend origin, resolved in MAIN rather than taken from the renderer.
 *
 * Deliberately not an IPC parameter. A base URL the renderer could set is a
 * base URL a compromised renderer could point at its own server, and every
 * request after that would arrive there with a valid bearer token attached.
 *
 * ── ★ Why this reads a baked value, and what broke without one ──────────────
 *
 * This used to be `MOTION_BACKEND_ORIGIN` or localhost, and NOTHING ever set
 * that variable — not the release workflow, not electron-builder, not main. It
 * appears in this repo only in its own test. So every packaged build resolved
 * to `http://localhost:4000`, on the END USER's machine, where nothing is
 * listening.
 *
 * That shipped in 0.3.1 as "login is broken". Sign-in is the visible symptom
 * rather than the scope: `authRequest` routes desktop sign-in through main
 * precisely so tokens never enter the renderer, and every other call goes
 * through `api.request`, which is also main — so the whole backend was
 * unreachable and sign-in was merely the first thing anyone tried.
 *
 * The trap was that it LOOKED configured. `VITE_BACKEND_ORIGIN` is set at build
 * time and is genuinely correct — for the renderer, and for the CSP built from
 * it. `main.ts` even says the app "talks to a deployed motion-back at the origin
 * baked in by VITE_BACKEND_ORIGIN". Main never read it. Two resolvers for one
 * question, one of them wired to nothing, and the half that was wired is the
 * half a developer sees working because their dev server IS on localhost:4000.
 *
 * Order is deliberate: an explicit env var still wins, so a developer can point
 * a packaged build at a staging server without rebuilding it.
 */
export function backendOrigin(): string {
  const configured = (process.env.MOTION_BACKEND_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const baked = (bakedOrigin() ?? '').trim().replace(/\/+$/, '');
  if (baked) return baked;
  return `http://localhost:${Number(process.env.MOTION_BACKEND_PORT || 4000)}`;
}

/** Everything the renderer may reach, as one absolute prefix. */
export function apiBaseUrl(): string {
  return `${backendOrigin()}/api`;
}

/** Why a path was refused. Named so the failure is readable in a log or a test. */
export type PathRejection =
  | 'not-a-string'
  | 'empty'
  | 'absolute-url'
  | 'scheme-relative'
  | 'backslash'
  | 'traversal'
  | 'escapes-base';

export type ResolvedPath =
  | { ok: true; url: string }
  | { ok: false; reason: PathRejection };

/**
 * Turn a renderer-supplied path into an absolute URL, or refuse it.
 *
 * Pure and exported so the rejection table can be tested exhaustively without
 * an Electron process — the interesting cases here are all string-shaped.
 */
export function resolveApiUrl(path: unknown, base = apiBaseUrl()): ResolvedPath {
  if (typeof path !== 'string') return { ok: false, reason: 'not-a-string' };
  if (path.length === 0) return { ok: false, reason: 'empty' };

  // Backslashes first: `/\evil.test` and `\\evil.test\x` are normalised into
  // scheme-relative URLs by WHATWG parsers, so checking for `//` alone misses
  // them. There is no legitimate backslash in one of our paths.
  if (path.includes('\\')) return { ok: false, reason: 'backslash' };

  // A scheme means an absolute URL. Checked before the `//` test so
  // `http://evil.test` is reported as what it is.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return { ok: false, reason: 'absolute-url' };

  if (path.startsWith('//')) return { ok: false, reason: 'scheme-relative' };
  if (!path.startsWith('/')) return { ok: false, reason: 'empty' };

  // Segment-wise, so `/projects/..%2f` and `/a/../../auth` are both caught and
  // a legitimate `/files/my..name` is not.
  const [pathname = ''] = path.split(/[?#]/);
  if (pathname.split('/').some((seg) => seg === '..' || seg === '%2e%2e' || seg.toLowerCase() === '%2e%2e')) {
    return { ok: false, reason: 'traversal' };
  }

  let url: URL;
  try {
    url = new URL(base + path);
  } catch {
    return { ok: false, reason: 'escapes-base' };
  }

  // The backstop. Whatever slipped past the shape checks, the result has to
  // still be our origin and still be under our base path.
  const baseUrl = new URL(base);
  const samePrefix = url.pathname === baseUrl.pathname || url.pathname.startsWith(`${baseUrl.pathname}/`);
  if (url.origin !== baseUrl.origin || !samePrefix) return { ok: false, reason: 'escapes-base' };

  return { ok: true, url: url.toString() };
}
