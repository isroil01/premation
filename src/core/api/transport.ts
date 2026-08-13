/**
 * The wire layer: URL, auth header, error shape, conditional GET.
 *
 * Split out of `client.ts` so the cache (`./cache`) can issue conditional
 * requests without importing the endpoint catalog that is itself built on the
 * cache — the two would otherwise be a circular import, which in an ES module
 * graph fails as an undefined function at the least convenient moment.
 *
 * `client.ts` re-exports everything public here, so nothing outside this
 * directory needs to know the split exists.
 */

import { API_URL, IS_ELECTRON } from './env';
import { isLocalEdition } from '@core/config/edition';
import {
  accessTokenExpired,
  clearSession,
  getAccessToken,
  hasSession,
  refreshSession,
  setSession,
} from './session';

const BASE_URL: string = API_URL || 'http://localhost:4000/api';

/** Absolute/relative API base — for callers that need a raw fetch (AI stream). */
export const apiBaseUrl = (): string => BASE_URL;

/**
 * The current bearer, in the BROWSER build only.
 *
 * Always null on desktop, where the token lives in the main process and is
 * attached there. Callers that used to build an `Authorization` header from
 * this go through `send` instead; the two remaining direct consumers (the AI
 * gateway stream and the sync transport) each pick a path by capability. A
 * caller that requires this to be non-null on desktop is a caller that has
 * reintroduced the problem Track A removed.
 */
export function getToken(): string | null {
  return getAccessToken();
}

/**
 * Adopt a session.
 *
 * Kept for the one caller that legitimately has a bare token and no refresh
 * token: the test suite. Passing null signs out. Real sign-in flows go through
 * `setSession` with the full pair, so the refresh token is stored where it
 * belongs (the OS keystore on desktop) rather than smuggled through here.
 */
export function setToken(token: string | null): void {
  if (!token) {
    void clearSession();
    return;
  }
  void setSession({ token, refreshToken: '', expiresIn: 3600 });
}

/** True when the user has a session — gates cloud features. */
export function isAuthenticated(): boolean {
  return hasSession();
}

export interface ApiError extends Error {
  status: number;
  body?: unknown;
  /**
   * The server's `X-Request-Id` for the failed call.
   *
   * The same id appears in the backend log line for this request, so a bug
   * report that quotes it can be traced to the exact failure instead of a
   * time range.
   */
  requestId?: string;
}

/**
 * A page of a list endpoint.
 *
 * These used to return bare arrays of everything the account owned. `total` is
 * the count ignoring paging, so a UI can say "showing 20 of 143" rather than
 * pretending 20 is all there is.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PageQuery {
  limit?: number;
  offset?: number;
}

/** `{limit, offset, q}` → "?limit=20&offset=40&q=promo", omitting what's unset. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

/**
 * Everything except the bearer.
 *
 * The Authorization header is added later, by `withAuth`, at the instant the
 * request is sent — because a retry after a silent refresh must carry the NEW
 * token, and a header object built up front would carry the one that just
 * failed.
 */
function headersFor(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body && !(init.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Read a response header defensively.
 *
 * Tests (and some fetch polyfills) hand back plain objects with no `headers`,
 * and a hard `res.headers.get(...)` turns every one of those into a TypeError
 * inside the client rather than a failed assertion in the test.
 */
function header(res: Response, name: string): string | undefined {
  return res.headers?.get?.(name) ?? undefined;
}

/**
 * Notified whenever the server refuses a write with `code: 'read_only'`.
 *
 * A callback rather than a direct call to the entitlement store, so transport
 * stays dependency-free — the store imports the API client, which imports this,
 * and a direct import here would close that cycle. The store registers itself
 * once at startup.
 */
type WriteDeniedListener = (detail: { reason?: string; message?: string }) => void;
let writeDeniedListener: WriteDeniedListener | null = null;

export function onWriteDenied(listener: WriteDeniedListener | null): void {
  writeDeniedListener = listener;
}

/**
 * The server's typed 403 body, whether the code sits at the top or nested.
 *
 * Exported for tests: NestJS is inconsistent about where a thrown `{ code, … }`
 * lands — flat on the body, or wrapped under `message` — and this is the exact
 * shape-handling that decides whether the read-only signal fires at all. A
 * regression here is silent: the paywall still works (the guard returns 403), but
 * the editor stops noticing, so the read-only bar never appears and autosave
 * hammers 403s forever.
 */
export function readOnlyDetail(status: number, body: unknown): { reason?: string; message?: string } | null {
  if (status !== 403 || !body || typeof body !== 'object') return null;
  // NestJS wraps a thrown `{ code, ... }` under `message` on some paths and
  // leaves it flat on others; accept either so the signal is not lost to shape.
  const flat = body as { code?: string; reason?: string; message?: string };
  const nested = (flat.message ?? null) as { code?: string; reason?: string; message?: string } | string | null;
  const code = flat.code ?? (typeof nested === 'object' ? nested?.code : undefined);
  if (code !== 'read_only') return null;
  const reason = flat.reason ?? (typeof nested === 'object' ? nested?.reason : undefined);
  const message =
    typeof nested === 'object' ? nested?.message : typeof flat.message === 'string' ? flat.message : undefined;
  return { reason, message };
}

async function toError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => undefined);
  }
  const err = new Error(
    (body as { message?: string })?.message || `Request failed (${res.status})`,
  ) as ApiError;
  err.status = res.status;
  err.body = body;
  err.requestId = header(res, 'X-Request-Id');

  // A write the server refused because this account may no longer make one. The
  // client's cached entitlement has gone stale mid-session — a trial that lapsed
  // while the editor was open — so tell the store immediately rather than waiting
  // for the next poll to notice.
  const denied = readOnlyDetail(res.status, body);
  if (denied) writeDeniedListener?.(denied);

  return err;
}

/**
 * Send a request, renewing the session first if it is about to expire and
 * once more if the server says it already has.
 *
 * The proactive check costs nothing (it is a clock comparison) and turns the
 * common case — an app left open past the access token's hour — into a normal
 * request instead of a 401 and a retry. The reactive retry covers the rest: a
 * token revoked server-side, a clock further out than the slack window.
 *
 * Exactly one retry. A second 401 after a *successful* refresh is not a
 * session problem, it is a genuine authorization failure, and retrying it
 * forever is how a client turns one bad request into a request loop.
 */
/**
 * Rebuild a real `Response` from what main sent back.
 *
 * Worth the small ceremony: everything downstream — `toError`, the 204 case,
 * the 304 case, the ETag read — keeps working against a genuine `Response`, so
 * this migration changed one function instead of every call site.
 */
function responseFrom(proxied: { status: number; headers: Record<string, string>; body: string }): Response {
  // 204 and 304 must be constructed with a null body; `new Response('')` with
  // either status throws.
  const bodyless = proxied.status === 204 || proxied.status === 304;
  return new Response(bodyless ? null : proxied.body, {
    status: proxied.status,
    headers: proxied.headers,
  });
}

/** Encode a body for IPC. FormData is serialised HERE — main stays format-blind. */
async function encodeBody(body: BodyInit | null | undefined): Promise<{
  body?: string | Uint8Array;
  contentType?: string;
}> {
  if (body === null || body === undefined) return {};
  if (typeof body === 'string') return { body };
  if (body instanceof FormData) {
    // `Response` does the multipart encoding, boundary and all, and hands back
    // the exact `Content-Type` that goes with it. Doing this on the renderer
    // side keeps the File objects where they already are.
    const encoded = new Response(body);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    return { body: bytes, contentType: encoded.headers.get('Content-Type') ?? undefined };
  }
  if (body instanceof Uint8Array) return { body };
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) };
  // A Blob, a stream, a URLSearchParams. Read it as text rather than silently
  // dropping it — an unsent body is a much worse failure than a re-encoded one.
  return { body: await new Response(body as BodyInit).text() };
}

async function send(path: string, init: RequestInit, headers: Record<string, string>) {
  // The local edition has no backend. Every UI surface that used to call one is
  // gated off, so reaching here means a path was missed — fail here, at the one
  // function `request` and `conditionalGet` share, rather than let a build that
  // advertises itself as offline quietly attempt a connection. Same reasoning as
  // the tripwire in core/project/networkFreeSavePath.test.ts, enforced at
  // runtime instead of in a test.
  if (isLocalEdition()) {
    const err = new Error(
      `This is the local edition — there is no backend to call (${path}).`,
    ) as ApiError;
    err.status = 0;
    throw err;
  }

  /*
    Desktop: the whole request happens in main.
    The bearer is attached there and never comes back here, so there is nothing
    on this side to expire, refresh or race — main serialises its own refresh,
    which is also what fixed the concurrent-401 stampede this function used to
    guard against by hand.
  */
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.api : undefined;
  if (IS_ELECTRON && bridge?.request) {
    const encoded = await encodeBody(init.body as BodyInit | null | undefined);
    const result = await bridge.request({
      path,
      method: (init.method ?? 'GET') as string,
      headers: {
        ...headers,
        ...(encoded.contentType ? { 'Content-Type': encoded.contentType } : {}),
      },
      ...(encoded.body === undefined ? {} : { body: encoded.body }),
    });

    if (result.status === 0) {
      // Never reached the network: a refused path, or a dead socket. Thrown as
      // a network error rather than returned as a Response, because there is no
      // response — and a fabricated 502 would look like the server answered.
      const err = new Error((result as { error?: string }).error || 'Request failed.') as ApiError;
      err.status = 0;
      throw err;
    }
    return responseFrom(result as { status: number; headers: Record<string, string>; body: string });
  }

  // Browser build: this realm holds the token, because there is nowhere else.
  if (accessTokenExpired() && isAuthenticated()) await refreshSession();

  let res = await fetch(`${BASE_URL}${path}`, { ...init, headers: withAuth(headers) });

  if (res.status === 401 && isAuthenticated()) {
    if (await refreshSession()) {
      res = await fetch(`${BASE_URL}${path}`, { ...init, headers: withAuth(headers) });
    }
  }
  return res;
}

/** Stamp the current bearer on, at the moment of sending, never before. */
function withAuth(headers: Record<string, string>): Record<string, string> {
  const token = getToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init ?? {}, headersFor(init));
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface ConditionalResult<T> {
  /** Undefined exactly when `notModified` is true. */
  data?: T;
  etag?: string;
  /** The server confirmed the cached copy is still current. */
  notModified: boolean;
}

/**
 * A GET that can come back as "you already have this".
 *
 * Sends `If-None-Match` when we hold an ETag; a 304 means the cached value is
 * still current, so the caller keeps the object it already had — same
 * reference, so React skips re-rendering the list entirely — and no body
 * crosses the network.
 */
export async function conditionalGet<T>(path: string, etag?: string): Promise<ConditionalResult<T>> {
  const headers = headersFor();
  if (etag) headers['If-None-Match'] = etag;

  const res = await send(path, {}, headers);

  if (res.status === 304) return { notModified: true, etag };
  if (!res.ok) throw await toError(res);

  return {
    data: (res.status === 204 ? undefined : await res.json()) as T,
    etag: header(res, 'ETag'),
    notModified: false,
  };
}
