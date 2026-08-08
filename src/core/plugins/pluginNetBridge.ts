/**
 * Connecting `pluginNetFetch` to the process that can actually make the request.
 *
 * `pluginNetFetch.ts` owns the policy — which plugin is asking, what it
 * declared, what the user granted, the redirect loop, the budget. It does not
 * own a socket, and on the desktop build it cannot: the app shell's
 * `connect-src` names our backend and our media origins, never a plugin's
 * hosts. A renderer-side request to `api.acme.com` is refused by the browser
 * before it leaves.
 *
 * So this file supplies the two things the renderer cannot do for itself, both
 * from the main process:
 *
 *   • **A transport.** `electron/pluginNet.ts` makes the request outside the
 *     renderer's policy, and its result is rebuilt here into a real `Response`.
 *     Rebuilt, not faked — `new Response(body, { status, headers })` is a
 *     genuine response with a genuine stream, so the caller's size counting and
 *     header reads run against the same shapes they do in a browser.
 *
 *   • **DNS.** Without a resolver the rebinding check cannot run at all, and a
 *     declared host pointing at `127.0.0.1` would pass every check that reads
 *     the name as text.
 *
 * ── Why the checks still run on both sides ───────────────────────────────────
 *
 * Main re-checks the scheme and the resolved address, and this file does not
 * treat that as redundant. Main is where the socket opens, so it does not take
 * a destination on trust from a caller. The renderer is where the manifest and
 * the grant live, so main cannot know whether a host was declared. Neither side
 * is sufficient alone, which is why neither side skips its half.
 *
 * ── In a browser build there is no bridge, and that is reported ──────────────
 *
 * Nothing here runs without `window.motionEditor`. `netGuardStatus()` then
 * reports `rebindingCheck: false` rather than implying a protection that is not
 * running — see `pluginNetFetch.ts`.
 */

import { setHostResolver } from './pluginNetFetch';

interface PluginNetResult {
  ok: boolean;
  reason?: string;
  message?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

interface PluginNetBridge {
  request(req: unknown): Promise<PluginNetResult>;
  resolve(hostname: string): Promise<string[]>;
}

function bridge(): PluginNetBridge | null {
  const w = window as unknown as { motionEditor?: { pluginNet?: PluginNetBridge } };
  return w.motionEditor?.pluginNet ?? null;
}

/**
 * A `fetch`-shaped transport backed by the main process.
 *
 * Returned as `typeof fetch` because that is the seam `pluginNetFetch` takes,
 * and every property it reads — `status`, `headers.get`, `body.getReader()` —
 * is real on the `Response` built below.
 *
 * A refusal from main is thrown rather than returned as a response. It is not
 * an HTTP result; turning `private-address` into a synthetic 403 would put a
 * security decision into the same channel as a server's own answer, where a
 * plugin could not tell them apart and neither could a log.
 */
export function mainProcessFetch(): typeof fetch {
  // No bridge means a browser build, where there is no other process to ask.
  // The renderer's own `fetch` is then the only transport there is — and it
  // will be refused by the app's `connect-src`, which is the truthful outcome
  // rather than a fabricated one. This runs per request — `net.fetch` calls
  // `mainProcessFetch()` each time — so a bridge is never captured from before
  // boot finished.
  const api = bridge();
  if (!api) return fetch;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const result = await api.request({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string> | undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (!result.ok) {
      const err = new Error(result.message ?? 'The request was refused.');
      err.name = result.reason ?? 'NetError';
      throw err;
    }

    return new Response(result.body ?? '', {
      status: result.status ?? 200,
      headers: result.headers ?? {},
    });
  }) as typeof fetch;
}

/**
 * Turn the DNS-rebinding check on, where something can resolve.
 *
 * Called once at boot. In a browser build there is no bridge and the resolver
 * stays null, which `netGuardStatus()` reports honestly.
 */
export function installPluginNetBridge(): void {
  const api = bridge();
  if (!api) return;
  setHostResolver((hostname) => api.resolve(hostname));
}
