/**
 * Where generated video, speech, and 3D models come from.
 *
 * Mirrors `aiImage.ts`: server edition → motion-back; local → Electron IPC.
 * Always returns base64 bytes so assets land in the user's library.
 */

import { api, isAuthenticated } from '@core/api/client';
import { aiRunsThroughBackend } from '@core/config/edition';
import type { AiMediaResult } from '@app-types/motionEditor';
import { AiTransportError } from './aiTransport';

export type MediaProviderId = 'fal' | 'elevenlabs' | 'tripo';

export interface GenerateVideoRequest {
  prompt: string;
  durationSec?: number;
}

export interface GenerateSpeechRequest {
  text: string;
  voiceId?: string;
}

export interface Generate3dRequest {
  prompt: string;
}

function shell() {
  return globalThis.window?.motionEditor?.ai;
}

export function localMediaAvailable(): boolean {
  const ai = shell();
  return typeof ai?.video === 'function' && typeof ai?.speech === 'function' && typeof ai?.model3d === 'function';
}

async function viaBackend(path: '/ai/video' | '/ai/speech' | '/ai/3d', body: unknown): Promise<AiMediaResult> {
  if (!isAuthenticated()) {
    throw new AiTransportError('auth', 'Sign in to generate media — it runs through your Motion account.');
  }
  try {
    const call =
      path === '/ai/video' ? api.generateVideo
      : path === '/ai/speech' ? api.generateSpeech
      : api.generate3d;
    const res = await call(body as never);
    if (!res.ok || !res.base64) {
      return { ok: false, code: 'provider_error', message: res.message || 'The media provider returned nothing.' };
    }
    return {
      ok: true,
      base64: res.base64,
      mime: res.mime || 'application/octet-stream',
      extension: res.extension || 'bin',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AiTransportError('network', message);
  }
}

async function viaShell(kind: 'video' | 'speech' | 'model3d', req: unknown): Promise<AiMediaResult> {
  const ai = shell();
  const fn = kind === 'video' ? ai?.video : kind === 'speech' ? ai?.speech : ai?.model3d;
  if (!fn) {
    throw new AiTransportError('unsupported', 'This build cannot generate media locally.');
  }
  return fn(req as never);
}

export async function generateVideoBytes(req: GenerateVideoRequest): Promise<AiMediaResult> {
  if (aiRunsThroughBackend()) return viaBackend('/ai/video', req);
  if (!localMediaAvailable()) {
    throw new AiTransportError(
      'unsupported',
      'Video generation needs the desktop app with a fal.ai key in Settings → Assistant → Media.',
    );
  }
  return viaShell('video', req);
}

export async function generateSpeechBytes(req: GenerateSpeechRequest): Promise<AiMediaResult> {
  if (aiRunsThroughBackend()) return viaBackend('/ai/speech', req);
  if (!localMediaAvailable()) {
    throw new AiTransportError(
      'unsupported',
      'Speech generation needs the desktop app with an ElevenLabs key in Settings → Assistant → Media.',
    );
  }
  return viaShell('speech', req);
}

export async function generate3dBytes(req: Generate3dRequest): Promise<AiMediaResult> {
  if (aiRunsThroughBackend()) return viaBackend('/ai/3d', req);
  if (!localMediaAvailable()) {
    throw new AiTransportError(
      'unsupported',
      '3D generation needs the desktop app with a Tripo key in Settings → Assistant → Media.',
    );
  }
  return viaShell('model3d', req);
}
