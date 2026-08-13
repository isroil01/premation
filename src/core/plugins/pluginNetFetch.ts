/**
 * `motion.net.fetch` — the host makes the request, never the plugin.
 *
 * ── Why the plugin never receives a `fetch` ──────────────────────────────────
 *
 * The worker's `fetch` stays replaced with a throwing stub. This is not a
 * relaxation of the lockdown; it is a narrow, mediated verb beside it. The
 * plugin names a URL, the host decides whether that URL is one the user
 * approved, and only then does a request happen.
 *
 * Handing over a real `fetch` scoped by some wrapper would be the same mistake
 * `credentials:get` was: a capability that looks bounded and is bounded only by
 * the wrapper nobody re-reads. A verb that takes a URL and returns bytes has
 * exactly one place to check, and it is here.
 *
 * ── What is checked, and in what order ───────────────────────────────────────
 *
 *   1. The permission was granted.            (`METHOD_PERMISSIONS`, upstream)
 *   2. The host is one the plugin DECLARED.   — and therefore one the user saw
 *   3. The scheme is https.
 *   4. The address is not on the user's own network.
 *   5. The plugin is inside its request budget.
 *   6. The response fits, and arrives in time.
 *
 * Order matters: the cheap refusals come first, and nothing that touches the
 * network happens until the destination has been approved.
 *
 * ── Redirects are re-checked, every hop ──────────────────────────────────────
 *
 * A declared host that answers `302 https://elsewhere/` would otherwise be a
 * way to reach an undeclared destination while passing every check at the front
 * door. So redirects are followed MANUALLY and each hop goes through the same
 * host check as the original — a redirect off the list is refused, not followed.
 */

import { isDeclaredHost, type NetContribution } from './netSchema';

/** How long a plugin's request may take, end to end. */
export const NET_TIMEOUT_MS = 15_000;
/** How much a plugin may receive in one response. */
export const NET_MAX_BYTES = 8 * 1024 * 1024;
/** Requests per plugin, per rolling minute. */
export const NET_REQUESTS_PER_MINUTE = 60;
/** Redirect hops followed before giving up. */
export const NET_MAX_REDIRECTS = 4;

export interface NetResponse {
  status: number;
  /** Lowercased header names. Deliberately not the whole set — see `SAFE_HEADERS`. */
  headers: Record<string, string>;
  /** The body as text. Binary is out of scope for this verb. */
  body: string;
}

/**
 * Response headers a plugin may see.
 *
 * An allowlist rather than the whole set. `set-cookie` is the obvious one to
 * withhold, but the reasoning is broader: response headers carry
 * infrastructure detail the plugin has no use for and every reason not to be
 * able to report back, and a plugin that can read the project should not also
 * be told what CDN the user is behind.
 */
const SAFE_HEADERS = ['content-type', 'content-length', 'etag', 'last-modified'];

/**
 * Address ranges a plugin may never reach, whatever the DNS says.
 *
 * ★ This is the DNS-rebinding defence, and it only works where the host can be
 * RESOLVED before connecting. See `resolveHost` below.
 *
 * The declared-host check already refuses `localhost` and IP literals — a
 * declared host must have an alphabetic TLD, so `https://127.0.0.1/` is not
 * expressible. What it cannot refuse is `api.example.com` resolving to
 * `192.168.1.1`, which is a public name pointing at the user's router.
 */
function isPrivateAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0                                  // "this network"
      || a === 10                              // RFC1918
      || a === 127                             // loopback
      || (a === 100 && b >= 64 && b <= 127)    // RFC6598 carrier-grade NAT
      || (a === 169 && b === 254)              // link-local, incl. cloud metadata
      || (a === 172 && b >= 16 && b <= 31)     // RFC1918
      || (a === 192 && b === 168)              // RFC1918
      || (a === 198 && (b === 18 || b === 19)) // benchmarking
      || a >= 224                              // multicast and reserved
    );
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    v6 === '::1' || v6 === '::'
    || v6.startsWith('fe80:')                  // link-local
    || v6.startsWith('fc') || v6.startsWith('fd') // unique-local
    // IPv4-mapped: ::ffff:192.168.1.1 is the same private address wearing a hat.
    || (v6.startsWith('::ffff:') && isPrivateAddress(v6.slice('::ffff:'.length)))
  );
}

/**
 * Resolve a hostname to addresses, when something can.
 *
 * ★ Injected, and absent by default. A renderer cannot resolve DNS — there is
 * no API for it — so the rebinding check can only run where Node can, which on
 * the desktop build is the main process.
 *
 * Left as an explicit hole rather than quietly skipped: `netGuardStatus()`
 * reports whether the check is active, so a surface can say so and this is not
 * a protection everyone assumes is on.
 */
let resolveHost: ((hostname: string) => Promise<string[]>) | null = null;

export function setHostResolver(fn: ((hostname: string) => Promise<string[]>) | null): void {
  resolveHost = fn;
}

/** Whether the private-address check can actually run in this build. */
export function netGuardStatus(): { rebindingCheck: boolean } {
  return { rebindingCheck: resolveHost !== null };
}

/** Per-plugin request timestamps, for the rolling budget. */
const recent = new Map<string, number[]>();

function withinBudget(pluginId: string): boolean {
  const now = Date.now();
  const times = (recent.get(pluginId) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= NET_REQUESTS_PER_MINUTE) {
    recent.set(pluginId, times);
    return false;
  }
  times.push(now);
  recent.set(pluginId, times);
  return true;
}

export class NetRefused extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'NetRefused';
  }
}

/**
 * Check a destination. Throws `NetRefused` with a reason a log can name.
 *
 * Separated from the request so the redirect path runs exactly the same check
 * as the front door — a second implementation for hops is how a redirect ends
 * up held to a weaker rule than the original.
 */
async function assertAllowed(url: string, net: NetContribution | null): Promise<void> {
  if (!isDeclaredHost(url, net)) {
    throw new NetRefused(
      'undeclared-host',
      `This plugin did not declare ${safeHostOf(url)} as a host it contacts, so the request was refused.`,
    );
  }

  if (!resolveHost) return;

  const hostname = new URL(url).hostname;
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    // A name that does not resolve is not a security decision — let the request
    // fail on its own terms rather than reporting it as a refusal.
    return;
  }

  if (addresses.some(isPrivateAddress)) {
    throw new NetRefused(
      'private-address',
      `${hostname} resolves to an address on this machine or its local network, which plugins may not reach.`,
    );
  }
}

/** The host part, for a message, without echoing a whole attacker-chosen URL. */
function safeHostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'that address';
  }
}

/**
 * Perform a plugin's request.
 *
 * `fetchImpl` is injected so this is testable without a network and so the
 * desktop build can route it through the main process — the same shape
 * `apiProxy` uses, and for the same reason.
 */
export async function pluginNetFetch(
  pluginId: string,
  net: NetContribution | null,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<NetResponse> {
  if (!withinBudget(pluginId)) {
    throw new NetRefused(
      'rate-limited',
      `This plugin has made more than ${NET_REQUESTS_PER_MINUTE} requests in a minute.`,
    );
  }

  let current = url;
  for (let hop = 0; hop <= NET_MAX_REDIRECTS; hop++) {
    // EVERY hop, including the first. A redirect is a new destination and gets
    // the same question asked of it.
    await assertAllowed(current, net);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: init.method ?? 'GET',
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        // Manual, so a redirect cannot carry the request somewhere the user
        // never approved while the browser follows it for us.
        redirect: 'manual',
        // No cookies, ever. A plugin's request must not carry the user's
        // session with it — that would make "reach this host" mean "act as the
        // user at this host".
        credentials: 'omit',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new NetRefused('bad-redirect', 'The server sent a redirect with no destination.');
      }
      // Resolved against the current URL, because a `Location` may be relative.
      current = new URL(location, current).toString();
      continue;
    }

    return readBounded(response);
  }

  throw new NetRefused('too-many-redirects', 'The request was redirected too many times.');
}

/**
 * Read a response, refusing one that is too large.
 *
 * Streamed and counted rather than `await response.text()`, because a
 * `content-length` is a claim by the server and a body that ignores it is the
 * whole attack. The cap has to hold against a server that lies.
 */
async function readBounded(response: Response): Promise<NetResponse> {
  const headers: Record<string, string> = {};
  for (const name of SAFE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { status: response.status, headers, body: '' };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > NET_MAX_BYTES) {
      // Cancelled, not merely abandoned: leaving the stream open would keep
      // pulling exactly the bytes this limit exists to stop.
      await reader.cancel();
      throw new NetRefused(
        'too-large',
        `The response is larger than the ${NET_MAX_BYTES / 1024 / 1024} MB a plugin may receive.`,
      );
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { merged.set(chunk, at); at += chunk.byteLength; }

  return { status: response.status, headers, body: new TextDecoder().decode(merged) };
}

/** Test seam. Never called by the app. */
export function resetNetBudgetForTests(): void {
  recent.clear();
  resolveHost = null;
}
