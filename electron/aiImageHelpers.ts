/**
 * Pure image-provider helpers — size mapping and response parsing.
 *
 * Kept free of Electron imports so unit tests can load them without a
 * working Electron binary (CI installs Electron for packaging jobs, not
 * for every Jest worker that touches `electron/*.test.ts`).
 */

/** Clamp a requested size onto a DALL·E 3 size the API accepts. */
export function openaiImageSize(width: number, height: number): '1024x1024' | '1792x1024' | '1024x1792' {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.2) return '1792x1024';
  if (ratio < 0.8) return '1024x1792';
  return '1024x1024';
}

/** Map width/height onto an Imagen aspect ratio string. */
export function geminiAspectRatio(width: number, height: number): string {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.5) return '16:9';
  if (ratio > 1.1) return '4:3';
  if (ratio < 0.67) return '9:16';
  if (ratio < 0.9) return '3:4';
  return '1:1';
}

/** Pull base64 + mime out of an OpenAI images response body. */
export function parseOpenAiImageBody(raw: unknown): { base64: string; mime: string } | null {
  const data = (raw as { data?: Array<{ b64_json?: string }> })?.data;
  const b64 = data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) return null;
  return { base64: b64, mime: 'image/png' };
}

/** Pull base64 + mime out of an Imagen predict response body. */
export function parseGeminiImageBody(raw: unknown): { base64: string; mime: string } | null {
  const preds = (raw as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> })
    ?.predictions;
  const first = preds?.[0];
  const b64 = first?.bytesBase64Encoded;
  if (typeof b64 !== 'string' || !b64) return null;
  const mime = typeof first?.mimeType === 'string' && first.mimeType ? first.mimeType : 'image/png';
  return { base64: b64, mime };
}

/**
 * Image models per provider, best first. Fixed here — never taken from the
 * renderer — so the Gemini path concat stays closed (see IMAGE_ENDPOINTS).
 *
 * A ladder rather than one id: `gpt-image-1` needs a verified OpenAI
 * organisation and `imagen-4.0` is not on every Gemini key, so an account
 * without the newer model steps down to the one it has instead of failing.
 */
export const IMAGE_MODEL_LADDER = {
  openai: ['gpt-image-1', 'dall-e-3'],
  gemini: ['imagen-4.0-generate-001', 'imagen-3.0-generate-002'],
} as const;

/** Clamp a requested size onto a size `gpt-image-1` accepts. */
export function gptImageSize(width: number, height: number): '1024x1024' | '1536x1024' | '1024x1536' {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.2) return '1536x1024';
  if (ratio < 0.8) return '1024x1536';
  return '1024x1024';
}

/** The OpenAI images request body for one model of the ladder. */
export function openaiImageBody(model: string, prompt: string, width: number, height: number): Record<string, unknown> {
  // gpt-image-1 always returns base64 and rejects `response_format`; DALL·E 3
  // needs it to return bytes rather than a URL.
  return model === 'dall-e-3'
    ? { model, prompt, n: 1, size: openaiImageSize(width, height), response_format: 'b64_json' }
    : { model, prompt, n: 1, size: gptImageSize(width, height) };
}

/**
 * Whether a failed image request should try the next model down.
 *
 * Only for "this model is not available to this key": a 404, a 403 (an
 * unverified organisation for gpt-image-1), or a 400 that names the model. An
 * auth failure, a rate limit or an outage would fail the same way on the next
 * model and cost a second request to learn it.
 */
export function stepDownImageModel(status: number, body: string): boolean {
  if (status === 404 || status === 403) return true;
  return status === 400 && /model|verif|not (?:found|available|supported)|does not exist/i.test(body);
}
