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

/**
 * The backend origin, resolved in MAIN rather than taken from the renderer.
 *
 * Deliberately not an IPC parameter. A base URL the renderer could set is a
 * base URL a compromised renderer could point at its own server, and every
 * request after that would arrive there with a valid bearer token attached.
 */
export function backendOrigin(): string {
  const configured = (process.env.MOTION_BACKEND_ORIGIN ?? '').trim().replace(/\/+$/, '');
  return configured || `http://localhost:${Number(process.env.MOTION_BACKEND_PORT || 4000)}`;
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
