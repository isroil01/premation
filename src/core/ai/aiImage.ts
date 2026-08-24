/**
 * Where generated imagery comes from.
 *
 * Same split as `aiTransport`: the renderer is keyless in both editions. The
 * only difference is who holds the key and therefore who makes the HTTPS call.
 *
 *  • **server** — `POST /ai/image` on motion-back (AES-256-GCM key at rest)
 *  • **local**  — `ai:image` IPC → Electron main (`aiProxy.ts` + OS keystore)
 *
 * Returning base64 bytes (never a provider URL) is load-bearing on both paths:
 * the asset has to outlive provider URL expiry and land in the user's library.
 */

import { api, isAuthenticated } from '@core/api/client';
import { aiRunsThroughBackend } from '@core/config/edition';
import type { AiVaultProvider, AiImageResult } from '@app-types/motionEditor';
import { AiTransportError } from './aiTransport';

export interface GenerateImageRequest {
  provider: string;
  prompt: string;
  width?: number;
  height?: number;
}

/** True when the desktop shell can generate images on its own. */
export function localImageAvailable(): boolean {
  return typeof globalThis.window?.motionEditor?.ai?.image === 'function';
}

async function generateViaBackend(req: GenerateImageRequest): Promise<AiImageResult> {
  if (!isAuthenticated()) {
    throw new AiTransportError('auth', 'Sign in to generate images — they run through your Motion account.');
  }
  try {
    const res = await api.generateImage({
      provider: req.provider,
      prompt: req.prompt,
      width: req.width,
      height: req.height,
    });
    if (!res.ok || !res.base64) {
      return { ok: false, code: 'provider_error', message: 'The image provider returned nothing.' };
    }
    return { ok: true, base64: res.base64, mime: res.mime || 'image/png' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AiTransportError('network', message);
  }
}

async function generateViaShell(req: GenerateImageRequest): Promise<AiImageResult> {
  const image = globalThis.window?.motionEditor?.ai?.image;
  if (!image) {
    throw new AiTransportError('unsupported', 'This build cannot generate images locally.');
  }
  return image({
    provider: req.provider as AiVaultProvider,
    prompt: req.prompt,
    width: req.width,
    height: req.height,
  });
}

/**
 * Generate one image for this build.
 *
 * Chosen by capability, not edition name — same rule as `streamProviderBytes`.
 */
export async function generateImageBytes(req: GenerateImageRequest): Promise<AiImageResult> {
  if (aiRunsThroughBackend()) return generateViaBackend(req);
  if (!localImageAvailable()) {
    throw new AiTransportError(
      'unsupported',
      'Image generation needs the desktop app in this edition — it holds your API key in the OS keystore.',
    );
  }
  return generateViaShell(req);
}
