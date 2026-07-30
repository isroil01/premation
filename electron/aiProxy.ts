/**
 * Provider calls for the local edition, made from the main process.
 *
 * This is the counterpart to `aiKeyVault`: the vault refuses to hand a key to the
 * renderer, so something on the privileged side has to be the thing that spends
 * it. That is this file.
 *
 * ── Why not just widen the CSP and call the provider from the renderer ───────
 *
 * It would have been three lines in `src/core/api/csp.ts` — add `api.openai.com`
 * and friends to `connect-src` — and it would have been the wrong shape:
 *
 *  • The key would have to reach the renderer to go in a header, which means the
 *    vault needs a read-back verb, which means a compromised renderer can
 *    exfiltrate it. The write-only vault is only write-only because of this file.
 *  • `connect-src` is a ceiling on the whole page, not a per-caller grant. Opening
 *    it for the assistant opens it for every plugin panel and every imported
 *    document too, and this app runs third-party plugin code.
 *
 * Main-process `fetch` is not subject to the page CSP, so the policy stays as
 * tight as it is today and the provider hosts never appear in it.
 *
 * ── The endpoint allowlist is the SSRF guard ─────────────────────────────────
 *
 * Same rule as motion-back's gateway, and it matters more here because this
 * process can reach the filesystem: the renderer sends a PROVIDER ID, never a
 * URL. A per-request base URL would let a malicious document point this at
 * anything — including `file://` or a LAN address — with the user's own key
 * attached. If a custom endpoint for local models is ever wanted, it belongs in
 * a settings file read by main, not in a message from the renderer.
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { getKeyForProvider, VAULT_PROVIDERS, type VaultProvider } from './aiKeyVault';

/** Complete URLs, one per provider. Never concatenated from a request. */
const ENDPOINTS: Record<VaultProvider, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  // Gemini names the model in the path, so this is a base — see `urlFor`, which
  // is the only place allowed to extend it, and only with an encoded model name.
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};

/** Anthropic requires an explicit API version; omitting it is a 400. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Model names come from the renderer, so they are treated as untrusted text. */
const SAFE_MODEL = /^[A-Za-z0-9._:-]{1,128}$/;

const isVaultProvider = (v: unknown): v is VaultProvider =>
  typeof v === 'string' && (VAULT_PROVIDERS as readonly string[]).includes(v);

/** In-flight streams, so `ai:cancel` has something to abort. */
const inFlight = new Map<string, AbortController>();

export type StreamEvent =
  | { requestId: string; type: 'chunk'; text: string }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; code: string; message: string };

function urlFor(provider: VaultProvider, model: string | undefined, key: string): string {
  if (provider !== 'gemini') return ENDPOINTS[provider];
  const m = encodeURIComponent(model && SAFE_MODEL.test(model) ? model : 'gemini-2.0-flash');
  // Gemini carries the key as a query parameter — its API offers no header form.
  // Worth knowing: this URL must never be logged, which is why nothing in this
  // file logs a URL, only a provider id and a status.
  return `${ENDPOINTS.gemini}/${m}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
}

function headersFor(provider: VaultProvider, key: string): Record<string, string> {
  const base = { 'content-type': 'application/json' };
  switch (provider) {
    case 'openai':
      return { ...base, authorization: `Bearer ${key}` };
    case 'anthropic':
      return { ...base, 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
    case 'gemini':
      // Key is in the URL; sending it twice would be a second place to leak it.
      return base;
  }
}

/** Map a provider status onto the codes the renderer already renders. */
function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'overloaded';
  return 'provider_error';
}

/**
 * Stream a completion.
 *
 * Resolves as soon as the provider's response headers are in, so the renderer
 * learns about an auth failure immediately rather than through the event
 * channel. Body chunks then arrive as `ai:stream:event` messages.
 */
async function startStream(
  sender: WebContents,
  provider: VaultProvider,
  model: string | undefined,
  body: unknown,
): Promise<{ ok: true; requestId: string } | { ok: false; code: string; message: string }> {
  const key = await getKeyForProvider(provider);
  if (!key) {
    return {
      ok: false,
      code: 'no_key',
      message: `No ${provider} API key is connected. Add one in Settings → Assistant.`,
    };
  }

  const controller = new AbortController();
  let res: Response;
  try {
    res = await fetch(urlFor(provider, model, key), {
      method: 'POST',
      headers: headersFor(provider, key),
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      return { ok: false, code: 'cancelled', message: 'Cancelled.' };
    }
    return {
      ok: false,
      code: 'network',
      message: `Could not reach ${provider}. Check your connection and try again.`,
    };
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    return {
      ok: false,
      code: codeForStatus(res.status),
      // The provider's own body is the most useful thing here and it is the
      // user's own account being described, so it is worth passing along —
      // truncated, because some providers return an HTML error page.
      message: detail.slice(0, 400) || `${provider} refused the request (${res.status}).`,
    };
  }

  const requestId = randomUUID();
  inFlight.set(requestId, controller);

  // Pump in the background. Deliberately not awaited: the invoke returns now so
  // the renderer can start listening, and every later outcome is an event.
  void (async () => {
    const emit = (event: StreamEvent): void => {
      // A window closed mid-stream destroys its WebContents; sending to it throws
      // and would surface as an unhandled rejection in main.
      if (!sender.isDestroyed()) sender.send('ai:stream:event', event);
    };

    try {
      const decoder = new TextDecoder();
      // `res.body` is a web ReadableStream in Electron's main process, which is
      // async-iterable — no reader plumbing needed.
      for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
        emit({ requestId, type: 'chunk', text: decoder.decode(bytes, { stream: true }) });
      }
      // Flush whatever the decoder is holding from a split multi-byte character.
      const tail = decoder.decode();
      if (tail) emit({ requestId, type: 'chunk', text: tail });
      emit({ requestId, type: 'done' });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        emit({ requestId, type: 'done' });
      } else {
        emit({
          requestId,
          type: 'error',
          code: 'network',
          message: 'The connection to the provider dropped mid-response.',
        });
      }
    } finally {
      inFlight.delete(requestId);
    }
  })();

  return { ok: true, requestId };
}

export function registerAiProxyIpc(): void {
  ipcMain.handle(
    'ai:stream',
    async (
      event: IpcMainInvokeEvent,
      request: unknown,
    ): Promise<{ ok: true; requestId: string } | { ok: false; code: string; message: string }> => {
      const { provider, model, body } = (request ?? {}) as {
        provider?: unknown;
        model?: unknown;
        body?: unknown;
      };

      if (!isVaultProvider(provider)) {
        return { ok: false, code: 'unsupported', message: 'Unknown AI provider.' };
      }
      if (model !== undefined && (typeof model !== 'string' || !SAFE_MODEL.test(model))) {
        return { ok: false, code: 'bad_request', message: 'That model name is not valid.' };
      }

      return startStream(event.sender, provider, model as string | undefined, body);
    },
  );

  ipcMain.handle('ai:cancel', (_event, requestId: unknown): boolean => {
    if (typeof requestId !== 'string') return false;
    const controller = inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    inFlight.delete(requestId);
    return true;
  });
}

/** Abort everything in flight — called on quit so no fetch outlives the app. */
export function abortAllStreams(): void {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
}
