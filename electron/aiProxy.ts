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

import { type IpcMainInvokeEvent, type WebContents } from 'electron';
import { handle } from './ipcGuard';
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

/**
 * Image endpoints — a SEPARATE allowlist from chat on purpose.
 *
 * Reusing the chat map and appending a path is exactly the shape SSRF guards
 * fail at: a renderer that somehow got a custom model string into a path
 * concat would reach hosts the chat allowlist never intended. Flat complete
 * URLs (or a Gemini base that only `imageUrlFor` may extend with a fixed model
 * id) keep the image surface as tight as chat.
 *
 * Anthropic has no image-generation API; it is absent here deliberately so a
 * request naming it fails closed rather than inventing a fake endpoint.
 */
const IMAGE_ENDPOINTS = {
  openai: 'https://api.openai.com/v1/images/generations',
  // Model is fixed in `imageUrlFor` — never taken from the renderer.
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
} as const;

/**
 * Speech-to-text endpoint — a THIRD allowlist, for the third reason.
 *
 * OpenAI only, and not because the others are worse. Anthropic has no audio
 * API at all, and Gemini's audio understanding returns prose rather than
 * timestamped segments — and a caption track without timings is not a caption
 * track. A request naming either fails closed with that explanation instead of
 * inventing an endpoint, exactly as image generation does for Anthropic.
 */
const TRANSCRIBE_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * The transcription model, fixed here rather than taken from the renderer.
 *
 * whisper-1 specifically: it is the only OpenAI transcription model that
 * returns SEGMENTS with start and end times (`verbose_json`). The newer
 * gpt-4o-transcribe models are better at words and return no timings, which
 * makes them useless for this — captions are timings.
 */
const TRANSCRIBE_MODEL = 'whisper-1';

/**
 * OpenAI refuses an upload over 25 MB. Checked here so the failure is
 * immediate and explains itself, rather than being a 413 after a long upload.
 * At 16 kHz mono (what the renderer sends) this is about 13 minutes.
 */
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

/** Stable Imagen model — not renderer-chosen, so the path concat stays closed. */
const GEMINI_IMAGE_MODEL = 'imagen-3.0-generate-002';

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

export type ImageResult =
  | { ok: true; base64: string; mime: string }
  | { ok: false; code: string; message: string };

export {
  openaiImageSize,
  geminiAspectRatio,
  parseOpenAiImageBody,
  parseGeminiImageBody,
} from './aiImageHelpers';
import {
  openaiImageSize,
  geminiAspectRatio,
  parseOpenAiImageBody,
  parseGeminiImageBody,
} from './aiImageHelpers';

function imageUrlFor(provider: 'openai' | 'gemini', key: string): string {
  if (provider === 'openai') return IMAGE_ENDPOINTS.openai;
  return `${IMAGE_ENDPOINTS.gemini}/${GEMINI_IMAGE_MODEL}:predict?key=${encodeURIComponent(key)}`;
}

/**
 * Generate one image via the user's own key.
 *
 * Same custody as `ai:stream`: the renderer sends a provider id and a prompt,
 * never a URL or a key. Bytes come back as base64 so the asset outlives any
 * provider URL expiry and the user's IP never reaches a CDN the renderer would
 * have to fetch.
 */
async function generateImage(
  provider: VaultProvider,
  prompt: string,
  width: number,
  height: number,
): Promise<ImageResult> {
  if (provider === 'anthropic') {
    return {
      ok: false,
      code: 'unsupported',
      message:
        'Anthropic does not generate images. Switch the assistant to OpenAI or Gemini ' +
        '(or connect one of those keys) and try again.',
    };
  }

  const trimmed = prompt.trim();
  if (trimmed.length < 8 || trimmed.length > 2000) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'Image prompts must be between 8 and 2000 characters.',
    };
  }

  const w = Number.isFinite(width) && width > 0 ? Math.round(width) : 1024;
  const h = Number.isFinite(height) && height > 0 ? Math.round(height) : 1024;

  const key = await getKeyForProvider(provider);
  if (!key) {
    return {
      ok: false,
      code: 'no_key',
      message: `No ${provider} API key is connected. Add one in Settings → Assistant.`,
    };
  }

  const url = imageUrlFor(provider, key);
  const headers = headersFor(provider, key);
  const body =
    provider === 'openai'
      ? {
          model: 'dall-e-3',
          prompt: trimmed,
          n: 1,
          size: openaiImageSize(w, h),
          response_format: 'b64_json',
        }
      : {
          instances: [{ prompt: trimmed }],
          parameters: { sampleCount: 1, aspectRatio: geminiAspectRatio(w, h) },
        };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
    });
  } catch {
    return {
      ok: false,
      code: 'network',
      message: `Could not reach ${provider}. Check your connection and try again.`,
    };
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return {
      ok: false,
      code: codeForStatus(res.status),
      message: text.slice(0, 400) || `${provider} refused the image request (${res.status}).`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, code: 'provider_error', message: `${provider} returned a non-JSON image response.` };
  }

  const image = provider === 'openai' ? parseOpenAiImageBody(parsed) : parseGeminiImageBody(parsed);
  if (!image) {
    return { ok: false, code: 'provider_error', message: `${provider} returned no image bytes.` };
  }
  return { ok: true, base64: image.base64, mime: image.mime };
}

/** One timed span of speech — a segment or a single word. */
export interface TimedSpan {
  start: number;
  end: number;
  text: string;
}

export type TranscribeResult =
  | {
      ok: true;
      cues: TimedSpan[];
      /**
       * Per-WORD timings, when the model returned them.
       *
       * Absent (or empty) when it did not, which the renderer treats as
       * "estimate them from the segments" — the behaviour that shipped. Never
       * a substitute for `cues`: captions are segments, and a caption per word
       * is a stroboscope.
       */
      words?: TimedSpan[];
      language?: string;
    }
  | { ok: false; code: string; message: string };

/** A `verbose_json` segment list, defended against a response that is not one. */
export function parseWhisperSegments(parsed: unknown): TimedSpan[] | null {
  const body = parsed as { segments?: unknown; text?: unknown };
  if (!Array.isArray(body?.segments)) return null;
  const cues: TimedSpan[] = [];
  for (const raw of body.segments) {
    const seg = raw as { start?: unknown; end?: unknown; text?: unknown };
    if (typeof seg.start !== 'number' || typeof seg.end !== 'number' || typeof seg.text !== 'string') continue;
    const text = seg.text.trim();
    if (text === '') continue;
    cues.push({ start: seg.start, end: seg.end, text });
  }
  return cues;
}

/**
 * The `words` array of a `verbose_json` response, or [] when there is none.
 *
 * Separate from the segments and non-fatal by design: word granularity is a
 * bonus, not a requirement. A model or an account that returns segments and no
 * words still produces captions — the renderer falls back to estimating word
 * times inside each segment, which is what it did before this was asked for.
 *
 * The field is named `word` (not `text`) in the response, which is the one
 * detail that makes a copy of the segment parser wrong here.
 */
export function parseWhisperWords(parsed: unknown): TimedSpan[] {
  const body = parsed as { words?: unknown };
  if (!Array.isArray(body?.words)) return [];
  const out: TimedSpan[] = [];
  for (const raw of body.words) {
    const w = raw as { start?: unknown; end?: unknown; word?: unknown; text?: unknown };
    // `text` is accepted as well: it is what a couple of whisper-compatible
    // servers emit, and reading both costs one `??`.
    const token = typeof w.word === 'string' ? w.word : typeof w.text === 'string' ? w.text : null;
    if (typeof w.start !== 'number' || typeof w.end !== 'number' || token === null) continue;
    const text = token.trim();
    if (text === '') continue;
    out.push({ start: w.start, end: Math.max(w.start, w.end), text });
  }
  return out;
}

/**
 * Transcribe audio bytes into timed segments.
 *
 * The bytes arrive over IPC and go straight into a multipart body — never to
 * disk. A temp file would be a second copy of someone's audio living outside
 * the app's own storage, and nothing here needs one: unlike ffprobe (which
 * needs to seek), an HTTP upload is a stream.
 */
async function transcribeAudio(
  provider: VaultProvider,
  bytes: Uint8Array,
  filename: string,
  language: string | undefined,
): Promise<TranscribeResult> {
  if (provider !== 'openai') {
    return {
      ok: false,
      code: 'unsupported',
      message:
        provider === 'anthropic'
          ? 'Anthropic has no speech-to-text API. Connect an OpenAI key in Settings → Assistant to generate captions.'
          : 'Gemini returns transcripts without timings, which cannot become captions. '
            + 'Connect an OpenAI key in Settings → Assistant to generate captions.',
    };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, code: 'bad_request', message: 'There is no audio to transcribe.' };
  }
  if (bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
    return {
      ok: false,
      code: 'bad_request',
      message: `That is ${Math.round(bytes.byteLength / (1024 * 1024))} MB of audio; the limit is 25 MB `
        + '(about 13 minutes). Set a work area over the part you want captioned and try again.',
    };
  }

  const key = await getKeyForProvider(provider);
  if (!key) {
    return {
      ok: false,
      code: 'no_key',
      message: 'No OpenAI API key is connected. Add one in Settings → Assistant.',
    };
  }

  const form = new FormData();
  // Copied into a fresh ArrayBuffer: the IPC-delivered view may be a slice of a
  // larger buffer, and Blob would otherwise send the whole thing.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.append('file', new Blob([copy], { type: 'audio/wav' }), filename || 'audio.wav');
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'verbose_json');
  /*
   * BOTH granularities, and segment is not optional.
   *
   * Segments are what turn a transcript into captions — one time range per
   * sentence, which is what a caption is. Words are what the Transcript
   * panel's chips want: asking for segments alone left it dividing each
   * segment's duration across its words by character count, chips that look
   * exact and are not.
   *
   * Asking for `word` ALONE would be the trap: whisper then returns no
   * `segments` array at all and captions would break. Asking for both is one
   * request and one price.
   */
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  // A declared language is a real accuracy gain and stops the model guessing;
  // absent, whisper detects one. Validated as a short code so it cannot smuggle
  // anything into the body.
  if (language && /^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$/.test(language)) form.append('language', language);

  let res: Response;
  try {
    res = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      // No content-type: `fetch` sets the multipart boundary itself, and
      // setting it by hand is the classic way to make the body unparseable.
      headers: { authorization: `Bearer ${key}` },
      body: form,
      redirect: 'error',
    });
  } catch {
    return { ok: false, code: 'network', message: 'Could not reach OpenAI. Check your connection and try again.' };
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return {
      ok: false,
      code: codeForStatus(res.status),
      message: text.slice(0, 400) || `OpenAI refused the transcription (${res.status}).`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, code: 'provider_error', message: 'OpenAI returned a non-JSON transcription.' };
  }

  const cues = parseWhisperSegments(parsed);
  if (!cues) {
    return { ok: false, code: 'provider_error', message: 'OpenAI returned a transcription with no timed segments.' };
  }
  if (cues.length === 0) {
    return { ok: false, code: 'empty', message: 'No speech was found in that audio.' };
  }
  const words = parseWhisperWords(parsed);
  const language_ = (parsed as { language?: unknown }).language;
  return {
    ok: true,
    cues,
    // Omitted rather than sent empty, so "the model gave no word timings" and
    // "it gave an empty list" are the same thing to the renderer.
    ...(words.length > 0 ? { words } : {}),
    ...(typeof language_ === 'string' ? { language: language_ } : {}),
  };
}

export function registerAiProxyIpc(): void {
  handle(
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

  handle('ai:cancel', (_event, requestId: unknown): boolean => {
    if (typeof requestId !== 'string') return false;
    const controller = inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    inFlight.delete(requestId);
    return true;
  });

  handle('ai:transcribe', async (_event, request: unknown): Promise<TranscribeResult> => {
    const { provider, bytes, filename, language } = (request ?? {}) as {
      provider?: unknown;
      bytes?: unknown;
      filename?: unknown;
      language?: unknown;
    };

    if (!isVaultProvider(provider)) {
      return { ok: false, code: 'unsupported', message: 'Unknown AI provider.' };
    }
    if (!(bytes instanceof Uint8Array)) {
      return { ok: false, code: 'bad_request', message: 'Audio bytes are required.' };
    }
    return transcribeAudio(
      provider,
      bytes,
      typeof filename === 'string' ? filename : 'audio.wav',
      typeof language === 'string' ? language : undefined,
    );
  });

  handle('ai:image', async (_event, request: unknown): Promise<ImageResult> => {
    const { provider, prompt, width, height } = (request ?? {}) as {
      provider?: unknown;
      prompt?: unknown;
      width?: unknown;
      height?: unknown;
    };

    if (!isVaultProvider(provider)) {
      return { ok: false, code: 'unsupported', message: 'Unknown AI provider.' };
    }
    if (typeof prompt !== 'string') {
      return { ok: false, code: 'bad_request', message: 'A text prompt is required.' };
    }
    return generateImage(
      provider,
      prompt,
      typeof width === 'number' ? width : 1024,
      typeof height === 'number' ? height : 1024,
    );
  });
}

/** Abort everything in flight — called on quit so no fetch outlives the app. */
export function abortAllStreams(): void {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
}
