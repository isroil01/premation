/**
 * The app shell's Content-Security-Policy, composed at BUILD time.
 *
 * Why this is code and not a literal in `index.html`: the policy has to name
 * every origin the app talks to, and in server mode that set is only known when
 * the build is configured. The hardcoded policy allowed `'self'` plus
 * `http://localhost:*` — correct for dev and for a self-hosted sidecar, and
 * silently fatal for a packaged build pointed at a deployed backend:
 *
 *  • `connect-src` blocked every API call, so the app booted to a login screen
 *    that could never log in.
 *  • `img-src`/`media-src` blocked `res.cloudinary.com`, which is where
 *    motion-back serves user assets from in production — so even with the API
 *    reachable, no imported image or video would ever draw.
 *
 * `connect-src` gets the media origins too, not just `img-src`/`media-src`:
 * asset bytes are fetched, not only tagged. `AudioEngine` does `fetch(src)` and
 * hands the buffer to `decodeAudioData`, and `AppTextureProvider` fetches SVG
 * and image bytes directly. A policy that let an `<img>` load but blocked
 * `fetch` would work for stills and break every audio layer.
 *
 * Localhost stays in the policy unconditionally: it is what the dev server, the
 * Vite proxy and the optional bundled sidecar all use, and dropping it for
 * remote builds would trade one broken configuration for another. CSP is a
 * ceiling on what the app MAY reach, not a description of what it does reach.
 */

export interface CspOptions {
  /**
   * Absolute origin of the backend, e.g. `https://api.example.com`. Empty for
   * a browser build (same-origin `/api` through a proxy) or when the app talks
   * to the default `http://localhost:4000`.
   */
  backendOrigin?: string;
  /**
   * Extra origins that serve user media. Defaults to Cloudinary, motion-back's
   * production storage driver. Comma-separated when it arrives from an env var.
   */
  mediaOrigins?: string | string[];
}

/** motion-back's production storage driver serves assets from here. */
export const DEFAULT_MEDIA_ORIGINS = ['https://res.cloudinary.com'];

const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com';
const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';

/** Origin (scheme + host + port) of a URL, or null if it isn't one. */
export function originOf(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/**
 * The `ws(s)://` twin of an http(s) origin. A remote backend that ever pushes
 * over a socket would otherwise be blocked by a policy that already trusts it
 * over http — and the failure would look like an idle app, not a refusal.
 */
function socketOrigin(origin: string): string | null {
  if (origin.startsWith('https://')) return `wss://${origin.slice('https://'.length)}`;
  if (origin.startsWith('http://')) return `ws://${origin.slice('http://'.length)}`;
  return null;
}

function splitOrigins(value: string | string[] | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  const list = Array.isArray(value) ? value : value.split(',');
  const cleaned = list.map(originOf).filter((o): o is string => Boolean(o));
  // An explicitly empty value means "no extra media origins", which is a valid
  // choice for a local-disk self-host. Only an absent value takes the default.
  return cleaned;
}

/** Preserves order, drops repeats — a policy listing an origin twice is noise. */
function unique(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Builds the policy string for the `Content-Security-Policy` meta tag. */
export function buildAppCsp(options: CspOptions = {}): string {
  const backend = options.backendOrigin ? originOf(options.backendOrigin) : null;
  const media = splitOrigins(options.mediaOrigins, DEFAULT_MEDIA_ORIGINS);

  // Local origins cover the dev server, the Vite proxy target and the bundled
  // sidecar. `localhost:*` is a wildcard PORT, not a wildcard host.
  const local = ['http://localhost:*'];

  const connect = unique([
    "'self'",
    ...local,
    'ws://localhost:*',
    backend,
    backend ? socketOrigin(backend) : null,
    ...media,
    'blob:',
  ]);
  const img = unique(["'self'", ...local, backend, ...media, 'blob:', 'data:']);
  const mediaSrc = unique(["'self'", ...local, backend, ...media, 'blob:', 'data:']);

  return [
    "default-src 'self'",
    `connect-src ${connect.join(' ')}`,
    `img-src ${img.join(' ')}`,
    `media-src ${mediaSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline' ${GOOGLE_FONTS_CSS}`,
    `font-src 'self' ${GOOGLE_FONTS_FILES}`,
    "script-src 'self'",
  ].join('; ');
}
