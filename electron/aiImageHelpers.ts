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
