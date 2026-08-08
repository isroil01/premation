/**
 * A plugin's outbound request, made from the main process.
 *
 * ── Why this exists at all, when the renderer already has `fetch` ────────────
 *
 * Because the renderer's `fetch` cannot reach a plugin's hosts, and would not
 * be the right place to reach them from if it could.
 *
 * The app shell ships a Content-Security-Policy whose `connect-src` names our
 * backend, our media origins and localhost — deliberately, and nothing else.
 * `api.acme.com` is not on it. A renderer-side plugin request is therefore
 * refused by the browser before a socket opens, and the only way to "fix" that
 * in the renderer is to widen `connect-src` to every host every installed
 * plugin declared. That would loosen the policy for the WHOLE renderer, not
 * for the plugin: any script that ever runs there — an XSS, a compromised
 * dependency — inherits the widened reach as a side effect of a plugin the user
 * installed for something unrelated.
 *
 * So the request moves instead of the policy. The renderer's ceiling stays
 * exactly where it was, and the one component allowed to talk to a plugin's
 * hosts is this file.
 *
 * ── This is NOT a general fetch bridge ───────────────────────────────────────
 *
 * `apiProxy.ts` says it plainly about its own surface and it holds here: an
 * open relay is the same hole with extra steps. The difference in kind is that
 * this verb attaches no credential — there is no bearer, no cookie, no key to
 * spend, and it is not reachable from a plugin panel (`ipcGuard` refuses every
 * subframe). What is left to protect is the user's own network, and that is
 * protected HERE rather than trusted to the caller:
 *
 *   • https only
 *   • the resolved ADDRESS refused if it is loopback, link-local or private
 *   • one hop only — redirects are returned, never followed
 *   • no credentials, no cookies
 *   • a byte cap counted as bytes arrive, and a timeout
 *
 * The renderer runs its own copy of the address check and owns the parts this
 * process cannot see: which plugin is asking, what it declared, what the user
 * granted, and whether it is inside its budget. Neither side is sufficient
 * alone. This one is the layer that actually opens the socket, so it does not
 * take the destination on trust.
 *
 * ── The redirect split, which is deliberate ──────────────────────────────────
 *
 * Redirects are NOT followed here. A hop is a new destination and has to be
 * re-checked against the plugin's declared hosts — and this process does not
 * know them. So a 3xx comes back as a 3xx with its `Location`, the renderer
 * re-runs the same check it ran on the original, and calls again. The hop
 * budget lives with the loop, in the renderer.
 */

import { lookup } from 'node:dns/promises';
import { handle } from './ipcGuard';

/** Mirrors `NET_TIMEOUT_MS` in `src/core/plugins/pluginNetFetch.ts`. */
const TIMEOUT_MS = 15_000;
/** Mirrors `NET_MAX_BYTES`. Enforced on both sides on purpose. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Response headers the renderer is given.
 *
 * `location` is here and is not in the renderer's own list: the redirect loop
 * needs it, and a plugin never sees this object directly — the renderer builds
 * what the plugin sees from its own narrower allowlist.
 */
const RETURNED_HEADERS = [
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'location',
];

export interface PluginNetResult {
  ok: boolean;
  /** Set when `ok` is false. A reason a log can name, not a stack. */
  reason?: string;
  message?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Address ranges no plugin request may land on.
 *
 * Duplicated from `pluginNetFetch.ts` rather than shared, because the two
 * processes do not share a module graph and a bridge built to import one file
 * would be a worse dependency than the duplication. The ranges are stable — an
 * RFC1918 block does not get renegotiated — and `pluginNetFetch.test.ts` covers
 * the same table on the other side.
 */
function isPrivateAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    );
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    v6 === '::1' || v6 === '::'
    || v6.startsWith('fe80:')
    || v6.startsWith('fc') || v6.startsWith('fd')
    || (v6.startsWith('::ffff:') && isPrivateAddress(v6.slice('::ffff:'.length)))
  );
}

/** Every address a name resolves to, both families. */
export async function resolveAll(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

function refuse(reason: string, message: string): PluginNetResult {
  return { ok: false, reason, message };
}

/**
 * Make one hop.
 *
 * Returns a result rather than throwing, because this crosses an IPC boundary
 * where a thrown error arrives as a string with the stack glued on — and the
 * renderer needs the reason as a value it can act on.
 */
export async function pluginNetRequest(req: unknown): Promise<PluginNetResult> {
  const { url, method, headers, body } = (req ?? {}) as {
    url?: unknown; method?: unknown; headers?: unknown; body?: unknown;
  };

  if (typeof url !== 'string') return refuse('bad-request', 'No URL was given.');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('bad-request', 'That is not a URL.');
  }

  // Re-checked here even though the renderer checks it. This process is the one
  // that opens the socket; it does not take the scheme on trust from a caller.
  if (parsed.protocol !== 'https:') {
    return refuse('insecure-scheme', 'Plugins may only make https requests.');
  }

  // ★ The address, not the name. A host the author controls can point at
  // 127.0.0.1, and the name would pass every check that reads it as text.
  let addresses: string[];
  try {
    addresses = await resolveAll(parsed.hostname);
  } catch {
    return refuse('dns', `${parsed.hostname} could not be resolved.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    return refuse(
      'private-address',
      `${parsed.hostname} resolves to an address on this machine or its local network, which plugins may not reach.`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(parsed.toString(), {
      method: typeof method === 'string' ? method : 'GET',
      ...(headers && typeof headers === 'object'
        ? { headers: headers as Record<string, string> }
        : {}),
      ...(typeof body === 'string' ? { body } : {}),
      // Returned, not followed — the renderer owns the hop budget and is the
      // only side that knows which hosts this plugin declared.
      redirect: 'manual',
      credentials: 'omit',
      signal: controller.signal,
    });

    const out: Record<string, string> = {};
    for (const name of RETURNED_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) out[name] = value;
    }

    const text = await readBounded(response);
    if (text === null) {
      return refuse(
        'too-large',
        `The response is larger than the ${MAX_BYTES / 1024 / 1024} MB a plugin may receive.`,
      );
    }

    return { ok: true, status: response.status, headers: out, body: text };
  } catch (err) {
    // An abort and a connection failure are both "it did not happen", and
    // neither is a security decision. Reported as themselves.
    const aborted = err instanceof Error && err.name === 'AbortError';
    return refuse(
      aborted ? 'timeout' : 'network',
      aborted
        ? `The request to ${parsed.hostname} took longer than ${TIMEOUT_MS / 1000} seconds.`
        : `The request to ${parsed.hostname} failed.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Streamed and counted, because `content-length` is a claim. `null` = too big. */
async function readBounded(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      // Cancelled, not abandoned: an open stream keeps pulling exactly the
      // bytes this limit exists to stop.
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { merged.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export function registerPluginNetIpc(): void {
  handle('plugin:net-request', (_event, req: unknown) => pluginNetRequest(req));
  handle('plugin:net-resolve', async (_event, hostname: unknown): Promise<string[]> => {
    if (typeof hostname !== 'string') return [];
    try {
      return await resolveAll(hostname);
    } catch {
      return [];
    }
  });
}
