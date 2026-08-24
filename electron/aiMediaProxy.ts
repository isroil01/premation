/**
 * Media generation for the local edition — video, speech, and 3D models.
 *
 * Same SSRF rules as `aiProxy`: fixed endpoint allowlists, provider id only,
 * keys never cross to the renderer.
 */

import { handle } from './ipcGuard';
import { getMediaKeyForProvider, type MediaVaultProvider } from './mediaKeyVault';

/** Complete URLs — never built from renderer input. */
const ENDPOINTS = {
  fal: {
    submit: 'https://queue.fal.run/fal-ai/minimax/video-01-live',
    status: 'https://queue.fal.run/fal-ai/minimax/video-01-live/requests',
  },
  elevenlabs: {
    tts: 'https://api.elevenlabs.io/v1/text-to-speech',
  },
  tripo: {
    task: 'https://api.tripo3d.ai/v2/openapi/task',
  },
} as const;

const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // Rachel — ElevenLabs default

export type MediaResult =
  | { ok: true; base64: string; mime: string; extension: string }
  | { ok: false; code: string; message: string };

function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'overloaded';
  return 'provider_error';
}

async function fetchBytes(url: string, init?: RequestInit): Promise<{ ok: true; bytes: Uint8Array; mime: string } | { ok: false; code: string; message: string }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error' });
  } catch {
    return { ok: false, code: 'network', message: 'Could not reach the provider. Check your connection.' };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, code: codeForStatus(res.status), message: text.slice(0, 400) || `Provider refused the request (${res.status}).` };
  }
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  const buf = new Uint8Array(await res.arrayBuffer());
  return { ok: true, bytes: buf, mime };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function pollFalVideo(key: string, requestId: string, maxMs = 180_000): Promise<MediaResult> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${ENDPOINTS.fal.status}/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Key ${key}` },
      redirect: 'error',
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, code: codeForStatus(res.status), message: text.slice(0, 400) || 'Video generation failed.' };
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, code: 'provider_error', message: 'Invalid response while polling video generation.' };
    }
    const status = body.status;
    if (status === 'COMPLETED') {
      const video = (body.response as { video?: { url?: string } } | undefined)?.video?.url
        ?? (body.video as { url?: string } | undefined)?.url;
      if (typeof video !== 'string' || !video) {
        return { ok: false, code: 'provider_error', message: 'Video completed but no download URL was returned.' };
      }
      const dl = await fetchBytes(video);
      if (!dl.ok) return dl;
      return { ok: true, base64: toBase64(dl.bytes), mime: dl.mime || 'video/mp4', extension: 'mp4' };
    }
    if (status === 'FAILED') {
      return { ok: false, code: 'provider_error', message: String(body.error ?? 'Video generation failed.') };
    }
    await sleep(2500);
  }
  return { ok: false, code: 'timeout', message: 'Video generation timed out. Try a shorter clip or try again.' };
}

export async function generateVideoFal(prompt: string, durationSec = 5): Promise<MediaResult> {
  const trimmed = prompt.trim();
  if (trimmed.length < 8 || trimmed.length > 2000) {
    return { ok: false, code: 'bad_request', message: 'Video prompts must be between 8 and 2000 characters.' };
  }
  const key = await getMediaKeyForProvider('fal');
  if (!key) {
    return { ok: false, code: 'no_key', message: 'No fal.ai API key is connected. Add one in Settings → Assistant → Media.' };
  }
  const dur = Math.max(3, Math.min(10, Math.round(durationSec)));
  let res: Response;
  try {
    res = await fetch(ENDPOINTS.fal.submit, {
      method: 'POST',
      headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: trimmed, duration: String(dur) }),
      redirect: 'error',
    });
  } catch {
    return { ok: false, code: 'network', message: 'Could not reach fal.ai.' };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, code: codeForStatus(res.status), message: text.slice(0, 400) || 'fal.ai refused the video request.' };
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'provider_error', message: 'fal.ai returned a non-JSON response.' };
  }
  const requestId = typeof body.request_id === 'string' ? body.request_id : undefined;
  if (!requestId) {
    return { ok: false, code: 'provider_error', message: 'fal.ai did not return a request id.' };
  }
  return pollFalVideo(key, requestId);
}

export async function generateSpeechElevenLabs(text: string, voiceId?: string): Promise<MediaResult> {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 5000) {
    return { ok: false, code: 'bad_request', message: 'Speech text must be between 1 and 5000 characters.' };
  }
  const key = await getMediaKeyForProvider('elevenlabs');
  if (!key) {
    return { ok: false, code: 'no_key', message: 'No ElevenLabs API key is connected. Add one in Settings → Assistant → Media.' };
  }
  const voice = voiceId?.trim() || DEFAULT_VOICE;
  const url = `${ENDPOINTS.elevenlabs.tts}/${encodeURIComponent(voice)}`;
  const dl = await fetchBytes(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: trimmed, model_id: 'eleven_multilingual_v2' }),
  });
  if (!dl.ok) return dl;
  return { ok: true, base64: toBase64(dl.bytes), mime: 'audio/mpeg', extension: 'mp3' };
}

async function pollTripoTask(key: string, taskId: string, maxMs = 300_000): Promise<MediaResult> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${ENDPOINTS.tripo.task}/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'error',
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, code: codeForStatus(res.status), message: text.slice(0, 400) || '3D generation failed.' };
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, code: 'provider_error', message: 'Invalid response while polling 3D generation.' };
    }
    const data = (body.data ?? body) as Record<string, unknown>;
    const status = data.status ?? body.status;
    if (status === 'success' || status === 'completed' || status === 'SUCCEEDED') {
      const output = data.output as Record<string, unknown> | undefined;
      const modelUrl =
        (output?.model as string | undefined)
        ?? (output?.pbr_model as string | undefined)
        ?? (data.model_url as string | undefined);
      if (typeof modelUrl !== 'string' || !modelUrl) {
        return { ok: false, code: 'provider_error', message: '3D task completed but no model URL was returned.' };
      }
      const dl = await fetchBytes(modelUrl);
      if (!dl.ok) return dl;
      const ext = modelUrl.toLowerCase().includes('.glb') ? 'glb' : 'glb';
      return { ok: true, base64: toBase64(dl.bytes), mime: 'model/gltf-binary', extension: ext };
    }
    if (status === 'failed' || status === 'FAILED') {
      return { ok: false, code: 'provider_error', message: String(data.message ?? body.message ?? '3D generation failed.') };
    }
    await sleep(3000);
  }
  return { ok: false, code: 'timeout', message: '3D generation timed out. Try again with a simpler prompt.' };
}

export async function generate3dTripo(prompt: string): Promise<MediaResult> {
  const trimmed = prompt.trim();
  if (trimmed.length < 8 || trimmed.length > 2000) {
    return { ok: false, code: 'bad_request', message: '3D prompts must be between 8 and 2000 characters.' };
  }
  const key = await getMediaKeyForProvider('tripo');
  if (!key) {
    return { ok: false, code: 'no_key', message: 'No Tripo API key is connected. Add one in Settings → Assistant → Media.' };
  }
  let res: Response;
  try {
    res = await fetch(ENDPOINTS.tripo.task, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text_to_model', prompt: trimmed }),
      redirect: 'error',
    });
  } catch {
    return { ok: false, code: 'network', message: 'Could not reach Tripo.' };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, code: codeForStatus(res.status), message: text.slice(0, 400) || 'Tripo refused the 3D request.' };
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'provider_error', message: 'Tripo returned a non-JSON response.' };
  }
  const data = (body.data ?? body) as Record<string, unknown>;
  const taskId = typeof data.task_id === 'string' ? data.task_id : typeof body.task_id === 'string' ? body.task_id : undefined;
  if (!taskId) {
    return { ok: false, code: 'provider_error', message: 'Tripo did not return a task id.' };
  }
  return pollTripoTask(key, taskId);
}

export function registerAiMediaProxyIpc(): void {
  handle('ai:video', async (_event, request: unknown): Promise<MediaResult> => {
    const { prompt, durationSec } = (request ?? {}) as { prompt?: unknown; durationSec?: unknown };
    if (typeof prompt !== 'string') {
      return { ok: false, code: 'bad_request', message: 'A text prompt is required.' };
    }
    return generateVideoFal(prompt, typeof durationSec === 'number' ? durationSec : 5);
  });

  handle('ai:speech', async (_event, request: unknown): Promise<MediaResult> => {
    const { text, voiceId } = (request ?? {}) as { text?: unknown; voiceId?: unknown };
    if (typeof text !== 'string') {
      return { ok: false, code: 'bad_request', message: 'Speech text is required.' };
    }
    return generateSpeechElevenLabs(text, typeof voiceId === 'string' ? voiceId : undefined);
  });

  handle('ai:3d', async (_event, request: unknown): Promise<MediaResult> => {
    const { prompt } = (request ?? {}) as { prompt?: unknown };
    if (typeof prompt !== 'string') {
      return { ok: false, code: 'bad_request', message: 'A text prompt is required.' };
    }
    return generate3dTripo(prompt);
  });
}
