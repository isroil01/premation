/**
 * Every authenticated call to our own backend, made from the main process.
 *
 * This is the operation-shaped replacement for `credentials:get`. The renderer
 * asks for a REQUEST to be made; it does not ask for the credential that makes
 * the request possible. The `Authorization` header is attached here and the
 * token never crosses back — which is the entire point, and the reason this is
 * `api.request(path, init)` rather than `fetch(url, init)`.
 *
 * A general fetch bridge would have been easier and would have been the same
 * hole with extra steps: an open relay with the user's bearer attached,
 * callable by anything running in the renderer. So `path` is validated by
 * `resolveApiUrl` against a base URL that main resolves for itself, and a
 * request that would land anywhere else never becomes a request.
 *
 * ── Two shapes, because the renderer has two needs ───────────────────────────
 *
 *   `api:request` — buffered. Returns status, headers and body text, from which
 *   the renderer reconstructs a real `Response`. That keeps `transport.ts`'s
 *   error handling, 204s, 304s and ETag reads working unchanged, which is why
 *   this migration touches one function there rather than every call site.
 *
 *   `api:stream` — chunked, mirroring `aiProxy`'s shape exactly: the invoke
 *   resolves once the response headers are in, so the renderer learns about a
 *   401 immediately rather than through the event channel, and body chunks
 *   follow as events. Cancellation aborts the upstream request, not just the
 *   renderer's interest in it.
 */

import { type IpcMainInvokeEvent, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { handle } from './ipcGuard';
import { resolveApiUrl } from './apiBase';
import {
  accessTokenExpired,
  currentAccessToken,
  hasSession,
  loadSession,
  refreshSession,
  signIn,
  signOut,
  status,
  adoptLegacyRefreshToken,
} from './apiSession';

/** What the renderer may set on a request. Anything else is dropped. */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/**
 * Headers the renderer may NOT set.
 *
 * `Authorization` most obviously — a renderer that could set it could send a
 * token of its choosing, or overwrite ours with one from elsewhere. `Cookie`
 * for the same reason. The rest are set by the fetch implementation and a
 * renderer-supplied value is either ignored or actively confusing.
 */
const FORBIDDEN_HEADERS = new Set([
  'authorization', 'cookie', 'host', 'content-length', 'connection',
]);

export interface ProxyRequest {
  path?: unknown;
  method?: unknown;
  headers?: unknown;
  /** Text, or bytes for a multipart body the renderer already encoded. */
  body?: unknown;
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  /** Empty string for 204/304, which must be reconstructed with a null body. */
  body: string;
}

export type ProxyFailure = { ok: false; status: 0; error: string; reason?: string };

/** In-flight streams, so `api:cancel` has something to abort. */
const inFlight = new Map<string, AbortController>();

export type ApiStreamEvent =
  | { requestId: string; type: 'chunk'; text: string }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; message: string };

function sanitiseHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    if (FORBIDDEN_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function methodOf(raw: unknown): string {
  const m = typeof raw === 'string' ? raw.toUpperCase() : 'GET';
  return ALLOWED_METHODS.has(m) ? m : 'GET';
}

function bodyOf(raw: unknown): BodyInit | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw;
  // A multipart upload: the renderer encoded the FormData itself (it is the
  // side that holds the File objects) and sent the bytes plus the boundary in
  // Content-Type. Main stays dumb about the format.
  //
  // Copied into a fresh ArrayBuffer rather than passed through: the value
  // arrived over structured clone and may be a view over a larger buffer, and
  // `BodyInit` will not take a view whose backing store it cannot prove.
  if (raw instanceof Uint8Array) return new Uint8Array(raw).buffer;
  if (raw instanceof ArrayBuffer) return raw;
  return undefined;
}

/**
 * Send, refreshing the session first if it is about to expire and once more if
 * the server says it already has.
 *
 * Exactly one retry. A second 401 after a SUCCESSFUL refresh is not a session
 * problem, it is a genuine authorization failure, and retrying it forever is
 * how a client turns one bad request into a request loop.
 */
async function sendWithAuth(url: string, init: RequestInit): Promise<Response> {
  await loadSession();
  if (accessTokenExpired() && hasSession()) await refreshSession();

  const withAuth = (): RequestInit => {
    const token = currentAccessToken();
    return {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
  };

  let res = await fetch(url, withAuth());
  if (res.status === 401 && hasSession()) {
    if (await refreshSession()) res = await fetch(url, withAuth());
  }
  return res;
}

/**
 * Send an authenticated multipart POST from MAIN, for callers in this process.
 *
 * Exported for exactly one reason: `pluginPublish` uploads a package with the
 * user's session attached, and the session lives here. Routing it through the
 * renderer's proxy instead would mean the renderer assembling the body — and
 * the point of that module is that neither the access token nor the signing key
 * is ever in the renderer.
 *
 * Not a general escape hatch. It takes a `FormData` and returns status plus
 * text, and no route whose response is a credential is a multipart POST.
 */
export async function postMultipartFromMain(
  path: string,
  form: FormData,
): Promise<{ status: number; text: string }> {
  const resolved = resolveApiUrl(path);
  if (!resolved.ok) throw new Error('That path is not part of this backend.');
  // Deliberately no Content-Type header: `fetch` derives the multipart boundary
  // from the FormData, and setting it by hand yields a body the server cannot
  // parse — with a 400 that names nothing.
  const res = await sendWithAuth(resolved.url, { method: 'POST', body: form });
  return { status: res.status, text: await res.text() };
}

/**
 * Routes whose RESPONSE is a credential.
 *
 * These cannot go through the generic proxy, because the proxy hands the body
 * back to the renderer — which would return the tokens Track A just moved out
 * of it, through the very channel built to keep them in. They go through
 * `auth:signIn` instead, where main keeps what it minted and answers with a
 * status. Refusing them here is what stops a future caller quietly routing
 * around that.
 */
const MINTS_A_SESSION = new Set([
  '/auth/login', '/auth/register', '/auth/refresh', '/auth/oauth/exchange',
  // Spending a reset link issues a session exactly like a login does, and this
  // set did not say so: on desktop it went through the generic proxy, so the
  // refresh token came back into the renderer AND main never adopted it — the
  // renderer marked itself signed in while holding no session at all.
  '/auth/reset-password',
]);

function mintsASession(path: string): boolean {
  const [pathname = ''] = path.split(/[?#]/);
  return MINTS_A_SESSION.has(pathname.replace(/\/+$/, ''));
}

async function doRequest(req: ProxyRequest): Promise<ProxyResponse | ProxyFailure> {
  const resolved = resolveApiUrl(req.path);
  if (!resolved.ok) {
    return { ok: false, status: 0, error: 'That path is not part of this backend.', reason: resolved.reason };
  }
  if (typeof req.path === 'string' && mintsASession(req.path)) {
    return {
      ok: false,
      status: 0,
      error: 'Session routes go through auth.signIn, which keeps the tokens in this process.',
      reason: 'escapes-base',
    };
  }

  const method = methodOf(req.method);
  const body = method === 'GET' || method === 'HEAD' ? undefined : bodyOf(req.body);

  let res: Response;
  try {
    res = await sendWithAuth(resolved.url, {
      method,
      headers: sanitiseHeaders(req.headers),
      ...(body === undefined ? {} : { body }),
    });
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error)?.message || 'Network request failed.' };
  }

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });

  // 204 and 304 carry no body and `res.text()` on them is an empty string
  // anyway; being explicit keeps the renderer's reconstruction honest, since
  // `new Response('')` with either status throws.
  const text = res.status === 204 || res.status === 304 ? '' : await res.text().catch(() => '');

  return { ok: res.ok, status: res.status, headers, body: text };
}

async function startStream(
  sender: WebContents,
  req: ProxyRequest,
): Promise<
  | { ok: true; requestId: string; status: number; headers: Record<string, string> }
  | { ok: false; status: number; error: string; body?: string }
> {
  const resolved = resolveApiUrl(req.path);
  if (!resolved.ok) return { ok: false, status: 0, error: 'That path is not part of this backend.' };

  const controller = new AbortController();
  const method = methodOf(req.method);

  let res: Response;
  try {
    res = await sendWithAuth(resolved.url, {
      method,
      headers: sanitiseHeaders(req.headers),
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: bodyOf(req.body) }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { ok: false, status: 0, error: 'Cancelled.' };
    return { ok: false, status: 0, error: (err as Error)?.message || 'Network request failed.' };
  }

  if (!res.ok || !res.body) {
    // The failure body is the useful part for a stream: the gateway answers
    // with typed JSON the renderer already knows how to render.
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `Request failed (${res.status}).`, body: detail };
  }

  const requestId = randomUUID();
  inFlight.set(requestId, controller);

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });

  // Pump in the background. Deliberately not awaited: the invoke returns now so
  // the renderer can start listening, and every later outcome is an event.
  void (async () => {
    const emit = (event: ApiStreamEvent): void => {
      // A window closed mid-stream destroys its WebContents; sending to it
      // throws and would surface as an unhandled rejection in main.
      if (!sender.isDestroyed()) sender.send('api:stream:event', event);
    };
    try {
      const decoder = new TextDecoder();
      for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
        emit({ requestId, type: 'chunk', text: decoder.decode(bytes, { stream: true }) });
      }
      const tail = decoder.decode();
      if (tail) emit({ requestId, type: 'chunk', text: tail });
      emit({ requestId, type: 'done' });
    } catch (err) {
      // An abort is a completed stream from the renderer's point of view — it
      // asked for this — so it ends rather than errors.
      if ((err as Error)?.name === 'AbortError') emit({ requestId, type: 'done' });
      else emit({ requestId, type: 'error', message: 'The connection dropped mid-response.' });
    } finally {
      inFlight.delete(requestId);
    }
  })();

  return { ok: true, requestId, status: res.status, headers };
}

export function registerApiProxyIpc(): void {
  handle('api:request', (_event, req: ProxyRequest) => doRequest(req ?? {}));

  handle('api:stream', (event: IpcMainInvokeEvent, req: ProxyRequest) =>
    startStream(event.sender, req ?? {}));

  handle('api:cancel', (_event, requestId: unknown): boolean => {
    if (typeof requestId !== 'string') return false;
    const controller = inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    inFlight.delete(requestId);
    return true;
  });

  // ── auth: operations, never the credential ────────────────────────────────

  handle('auth:status', async () => { await loadSession(); return status(); });

  handle('auth:signIn', async (_event, payload: unknown) => {
    const { path, body, clientName } = (payload ?? {}) as {
      path?: unknown; body?: unknown; clientName?: unknown;
    };
    if (typeof path !== 'string') return { ok: false, status: 400, body: { message: 'Missing route.' } };
    return signIn(path, body, typeof clientName === 'string' ? clientName : undefined);
  });

  handle('auth:signOut', () => signOut());

  // One-way, and only ever used once per install: see adoptLegacyRefreshToken.
  handle('auth:adoptLegacy', (_event, token: unknown) => adoptLegacyRefreshToken(token));
}

/** Abort everything in flight — called on quit so no fetch outlives the app. */
export function abortAllApiStreams(): void {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
}
