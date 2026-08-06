/**
 * Where the provider bytes come from.
 *
 * Both editions are bring-your-own-key and both speak the provider's native wire
 * format — so the SSE parsing, the adapters, the tool loop and every error code
 * are identical. The ONLY thing that differs is who holds the key and therefore
 * who makes the HTTPS call:
 *
 *  • **server** — motion-back holds the key (encrypted at rest with
 *    AI_KEY_SECRET) and proxies `POST /ai/stream`, piping the provider's bytes
 *    straight back. The renderer sends a bearer token, never a key.
 *
 *  • **local** — there is no backend, so the Electron main process holds the key
 *    in the OS keystore and makes the call itself (electron/aiKeyVault.ts,
 *    electron/aiProxy.ts). The renderer sends a provider id and receives bytes
 *    over IPC; it never holds the key either.
 *
 * Note that the renderer is keyless in BOTH cases. That is not a coincidence, it
 * is the design: whichever edition you are in, a compromised renderer can spend
 * the user's key but cannot read it.
 *
 * This module exists so `streamTurn` has one parse loop instead of two. The
 * previous shape — refuse early when `!aiEnabled()` — is gone, because the local
 * edition now has a real path and "coming soon" would be the false statement.
 */

import { isAuthenticated } from '@core/api/client';
import { streamApi, StreamStartError } from '@core/api/streamRequest';
import { aiRunsThroughBackend } from '@core/config/edition';
import type { AiVaultProvider, AiStreamEvent } from '@app-types/motionEditor';

/** Thrown by both transports, with the codes the UI already renders. */
export class AiTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiTransportError';
  }
}

export interface TransportRequest {
  /** Whose key to use. In the local edition this is also the wire format. */
  provider: string;
  model: string;
  /** The provider's own request body, already built by the adapter. */
  body: unknown;
  /** Set when the caller wants structured output (the director pipeline). */
  isPipeline?: boolean;
}

/**
 * A stream of raw provider text, in order.
 *
 * Text rather than bytes: the local transport decodes in the main process (it has
 * to, because IPC does not carry a live stream), so making the server transport
 * decode too means both yield the same type and the parser needs no branch.
 * Multi-byte characters split across chunks are handled on each side with a
 * streaming TextDecoder.
 */
export type ChunkStream = AsyncGenerator<string, void, undefined>;

/** True when the desktop shell can run the assistant on its own. */
export function localAiAvailable(): boolean {
  const ai = globalThis.window?.motionEditor?.ai;
  return typeof ai?.stream === 'function' && typeof ai?.onStreamEvent === 'function';
}

/**
 * Stream from motion-back's gateway.
 *
 * Aborting the signal aborts this fetch; the gateway sees the request close and
 * aborts its upstream provider call, so cancel truly stops the tokens.
 */
async function* streamViaBackend(req: TransportRequest, signal: AbortSignal): ChunkStream {
  // A claim about the session, not a token: the renderer holds no bearer on
  // desktop, but it still knows whether anyone is signed in — and saying so
  // here is better than a 401 after the request has gone out.
  if (!isAuthenticated()) {
    throw new AiTransportError('auth', 'Sign in to use the assistant — AI runs through your Motion account.');
  }

  let handle;
  try {
    handle = await streamApi(
      '/ai/stream',
      {
        method: 'POST',
        body: JSON.stringify({
          provider: req.provider,
          model: req.model,
          isPipeline: req.isPipeline ?? false,
          body: req.body,
        }),
      },
      signal,
    );
  } catch (err) {
    if (signal.aborted) throw new AiTransportError('cancelled', 'Cancelled.');
    if (err instanceof StreamStartError) {
      // The gateway answers failures with typed JSON: { code, message,
      // retryAfterMs }. Preserved exactly — the renderer already renders these
      // codes, and losing them would turn every gateway refusal into "network".
      let body: { code?: string; message?: string; retryAfterMs?: number } = {};
      try {
        body = JSON.parse(err.body ?? '{}') as typeof body;
      } catch {
        /* non-JSON error body — fall through to the status-based default */
      }
      // A 0 means the request never left: on desktop that is main refusing the
      // path, on web a dead socket. Neither is an auth problem.
      if (err.status === 0) throw new AiTransportError('network', body.message ?? err.message);
      throw new AiTransportError(
        body.code ?? (err.status === 401 ? 'auth' : 'network'),
        body.message ?? `AI gateway returned ${err.status}.`,
        body.retryAfterMs,
      );
    }
    throw new AiTransportError('network', err instanceof Error ? err.message : 'Could not reach the AI gateway.');
  }

  try {
    for await (const text of handle.chunks) yield text;
  } catch (err) {
    if (signal.aborted) throw new AiTransportError('cancelled', 'Cancelled.');
    throw new AiTransportError('network', err instanceof Error ? err.message : 'The stream failed.');
  }
}

/**
 * Stream from the Electron main process.
 *
 * IPC cannot carry a live stream, so main pushes `ai:stream:event` messages and
 * this bridges them back into an async generator. The queue matters: events
 * arrive whether or not the consumer is currently awaiting, and dropping the ones
 * that land between `next()` calls would silently truncate a response.
 */
async function* streamViaShell(req: TransportRequest, signal: AbortSignal): ChunkStream {
  const ai = globalThis.window?.motionEditor?.ai;
  if (!ai?.stream || !ai.onStreamEvent) {
    throw new AiTransportError('unsupported', 'This build cannot run the assistant locally.');
  }

  const queue: string[] = [];
  let finished = false;
  let failure: AiTransportError | null = null;
  /** Resolved whenever state changes, so the generator can stop waiting. */
  let wake: (() => void) | null = null;
  const notify = (): void => {
    wake?.();
    wake = null;
  };

  let requestId: string | null = null;
  /**
   * Cancel is sent at most once.
   *
   * Both the abort handler and the `finally` block want to cancel, and without
   * this they both do — the abort path fires, then the generator unwinds with
   * `finished` still false and fires again. Harmless in main (the second lookup
   * finds nothing) but it means "how many times did we cancel" is not a question
   * with a stable answer, which makes the behaviour untestable.
   */
  let cancelSent = false;
  const requestCancel = (): void => {
    if (cancelSent || !requestId) return;
    cancelSent = true;
    void ai.cancel?.(requestId);
  };

  // Subscribe BEFORE starting: main can emit a chunk the instant the provider
  // answers, and a listener attached after the invoke resolves would miss it.
  const unsubscribe = ai.onStreamEvent((event: AiStreamEvent) => {
    if (!requestId || event.requestId !== requestId) return;
    if (event.type === 'chunk') queue.push(event.text);
    else if (event.type === 'done') finished = true;
    else failure = new AiTransportError(event.code, event.message);
    notify();
  });

  const onAbort = (): void => {
    requestCancel();
    failure = new AiTransportError('cancelled', 'Cancelled.');
    notify();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const started = await ai.stream({
      provider: req.provider as AiVaultProvider,
      model: req.model,
      body: req.body,
    });
    if (!started.ok) throw new AiTransportError(started.code, started.message);
    requestId = started.requestId;

    // The signal may have aborted while the invoke was in flight, in which case
    // nothing has cancelled the stream yet — `onAbort` ran before there was a
    // requestId to cancel.
    if (signal.aborted) {
      requestCancel();
      throw new AiTransportError('cancelled', 'Cancelled.');
    }

    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (failure) throw failure;
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
    // The early-exit path: a consumer that breaks out of its `for await` lands
    // here with neither flag set, and the provider call would otherwise keep
    // streaming tokens the user pays for into a queue nobody reads.
    if (!finished) requestCancel();
  }
}

/**
 * The transport for this build.
 *
 * Chosen by capability, not by edition name: `aiRunsThroughBackend()` says WHY,
 * and a build with a backend that somehow lacks a shell bridge still works.
 */
export function streamProviderBytes(req: TransportRequest, signal: AbortSignal): ChunkStream {
  if (aiRunsThroughBackend()) return streamViaBackend(req, signal);
  if (!localAiAvailable()) {
    // A browser build of the local edition — no Electron bridge at all. Say the
    // true thing rather than "coming soon": the desktop app is the local edition.
    // Throws on the first next() by design, so this failure reaches the caller
    // through the stream it already handles rather than a second, separate path.
    // eslint-disable-next-line require-yield
    return (async function* (): ChunkStream {
      throw new AiTransportError(
        'unsupported',
        'The assistant needs the desktop app in this edition — it holds your API key in the OS keystore.',
      );
    })();
  }
  return streamViaShell(req, signal);
}
