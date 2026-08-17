/**
 * Client-side URL checks for automation inputs.
 *
 * The server is the real SSRF gate (private nets, metadata hosts, redirects).
 * This copy exists so the editor can refuse a bad URL before it is saved into
 * a template or posted, with the same rules the backend will apply.
 */

const BLOCKED_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
  'metadata.google',
]);

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0 || a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** True when `url` is a public http(s) asset the automation API may fetch. */
export function isAllowedAssetUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return false;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isPrivateIpv4(host)) return false;
  if (host.includes(':')) return false; // raw IPv6 — treat as internal
  return true;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|ogg)$/i;

export type AutomationAssetKind = 'image' | 'video' | 'audio' | 'unknown';

/** Best-effort kind from a URL path. Query strings are ignored. */
export function guessAssetKind(url: string): AutomationAssetKind {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep raw */
  }
  if (IMAGE_EXT.test(path)) return 'image';
  if (VIDEO_EXT.test(path)) return 'video';
  if (AUDIO_EXT.test(path)) return 'audio';
  return 'unknown';
}
