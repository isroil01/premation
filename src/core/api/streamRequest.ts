/**
 * A streaming call to our own backend, from either build.
 *
 * Two consumers stream today — the assistant gateway and the director pipeline
 * — and both used to build an `Authorization` header by hand from a token this
 * realm held. That token is gone from the renderer on desktop, so the request
 * has to be made in main; but the *shape* the callers depend on must survive
 * exactly, because a stream that arrives as one buffered blob is a stream that
 * stopped being one.
 *
 * So this preserves all of it: the call resolves as soon as the response
 * HEADERS are in (a 401 or a rate limit is known immediately, not at the end),
 * chunks arrive in order afterwards, and aborting the signal aborts the
 * upstream request rather than merely this side's interest in it.
 */

import { IS_ELECTRON } from './env';
import { apiBaseUrl } from './transport';
import { getToken } from './transport';
import type { ApiStreamEvent } from '../../types/motionEditor';

/** Everything the caller learns before the first byte of body. */
export interface StreamHandle {
  status: number;
  headers: Record<string, string>;
  /** Text chunks, in order. Ends normally on `done`, throws on a mid-stream error. */
  chunks: AsyncGenerator<string, void, undefined>;
}

export class StreamStartError extends Error {
  constructor(readonly status: number, message: string, readonly body?: string) {
    super(message);
    this.name = 'StreamStartError';
  }
}

/**
 * Open a stream.
 *
 * Throws `StreamStartError` when the response itself failed — the caller gets
 * the status and the raw body, which is what the gateway's typed error JSON
 * lives in. A failure DURING the stream surfaces from the generator instead,
 * because by then the caller has already been handed a handle.
 */
export async function streamApi(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal,
): Promise<StreamHandle> {
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.api : undefined;

  if (IS_ELECTRON && bridge?.stream && bridge.onStreamEvent) {
    return streamViaMain(bridge, path, init, signal);
  }

  // Browser build: this realm holds the token, because there is nowhere else.
  const token = getToken();
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(signal ? { signal } : {}),
  });

  const headers: Record<string, string> = {};
  res.headers?.forEach?.((v, k) => { headers[k] = v; });

  if (!res.ok || !res.body) {
    throw new StreamStartError(res.status, `Request failed (${res.status}).`, await res.text().catch(() => ''));
  }

  return { status: res.status, headers, chunks: readWebStream(res.body) };
}

async function* readWebStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    // Releasing matters on the abort path: an un-released reader keeps the
    // response alive and the socket with it.
    //
    // Optional call, not decoration: test doubles and some fetch polyfills hand
    // back a reader without it, and throwing from a `finally` would replace the
    // real result — or the real error — with a TypeError about the cleanup.
    reader.releaseLock?.();
  }
}

type ApiBridge = NonNullable<NonNullable<Window['motionEditor']>['api']>;

async function streamViaMain(
  bridge: ApiBridge,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal,
): Promise<StreamHandle> {
  /*
    Subscribe BEFORE invoking.

    Main starts pumping as soon as its invoke resolves, and IPC events are not
    buffered for a listener that has not attached yet. Subscribing afterwards
    drops however many chunks arrive in the gap — which on a fast local backend
    is the first and most visible part of the answer.
  */
  const queue: string[] = [];
  let finished: 'done' | string | null = null;
  let wake: (() => void) | null = null;
  let requestId: string | null = null;

  const unsubscribe = bridge.onStreamEvent!((raw) => {
    const event = raw as ApiStreamEvent;
    // Filter by id: one channel serves every in-flight stream, so a second
    // request's chunks would otherwise be spliced into this one's.
    if (!requestId || event.requestId !== requestId) return;
    if (event.type === 'chunk') queue.push(event.text);
    else if (event.type === 'done') finished = 'done';
    else finished = event.message;
    wake?.();
  });

  let start: Awaited<ReturnType<NonNullable<ApiBridge['stream']>>>;
  try {
    start = await bridge.stream!({
      path,
      method: init.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  } catch (err) {
    unsubscribe();
    throw new StreamStartError(0, (err as Error)?.message || 'Request failed.');
  }

  if (!start.ok) {
    unsubscribe();
    throw new StreamStartError(start.status, start.error, start.body);
  }

  requestId = start.requestId;

  // Events that arrived between subscribing and learning our id were dropped by
  // the filter above — but they cannot have: main only sends events for an id
  // it returned first, and it returns it before the first chunk is emitted.

  const onAbort = (): void => { void bridge.cancel?.(start.ok ? start.requestId : ''); };
  signal?.addEventListener('abort', onAbort, { once: true });

  async function* chunks(): AsyncGenerator<string, void, undefined> {
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (finished === 'done') return;
        if (finished !== null) throw new Error(finished);
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
      }
    } finally {
      // Whatever ends this — completion, an error, or the caller walking away
      // from the loop — the listener goes and the upstream request is told.
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      if (finished === null) void bridge.cancel?.(requestId!);
    }
  }

  return { status: start.status, headers: start.headers, chunks: chunks() };
}
