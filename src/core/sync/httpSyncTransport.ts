/**
 * HttpSyncTransport — the real `SyncTransport`, talking to motion-back's
 * `/api/sync/*` vault over the authenticated fetch client. Bytes cross as base64
 * (JSON), matching the backend contract; the engine seals/opens them, so what
 * travels here is already ciphertext.
 *
 * Thin I/O adapter — the reconcile/CAS logic lives in `SyncEngine`, tested
 * against a mock transport. This layer is verified on-device against the server.
 */

import { request, type ApiError } from '@core/api/client';
import type { RemoteState, SyncTransport } from './SyncEngine';

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * One sync call.
 *
 * Goes through the shared `request` helper rather than a hand-built fetch,
 * which is what moved the bearer out of this file: on desktop the header is
 * attached in the main process and this realm never sees the token. The 404 →
 * null translation stays here, because "the vault has no copy of this project"
 * is a normal answer to `getRemote`, not a failure.
 */
async function req<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    return (await request<T>(path, init)) ?? null;
  } catch (err) {
    if ((err as ApiError)?.status === 404) return null;
    throw new Error(`sync request failed: ${(err as ApiError)?.status ?? 0}`);
  }
}

export class HttpSyncTransport implements SyncTransport {
  async getRemote(projectId: string): Promise<RemoteState | null> {
    const body = await req<{ rev: number; manifest: string }>(`/sync/${encodeURIComponent(projectId)}`);
    return body ? { rev: body.rev, manifest: b64ToBytes(body.manifest) } : null;
  }

  async hasChunk(projectId: string, hash: string): Promise<boolean> {
    const body = await req<{ exists: boolean }>(
      `/sync/${encodeURIComponent(projectId)}/chunks/${encodeURIComponent(hash)}/exists`,
    );
    return body?.exists ?? false;
  }

  async getChunk(projectId: string, hash: string): Promise<Uint8Array | null> {
    const body = await req<{ data: string }>(
      `/sync/${encodeURIComponent(projectId)}/chunks/${encodeURIComponent(hash)}`,
    );
    return body ? b64ToBytes(body.data) : null;
  }

  async putChunk(projectId: string, hash: string, sealed: Uint8Array): Promise<void> {
    await req(`/sync/${encodeURIComponent(projectId)}/chunks/${encodeURIComponent(hash)}`, {
      method: 'PUT',
      body: JSON.stringify({ data: bytesToB64(sealed) }),
    });
  }

  async putRemote(
    projectId: string,
    expectedRev: number,
    manifest: Uint8Array,
  ): Promise<{ ok: true; rev: number } | { ok: false; rev: number }> {
    const body = await req<{ ok: boolean; rev: number }>(`/sync/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ expectedRev, manifest: bytesToB64(manifest) }),
    });
    // A null/failed response is treated as a stale rev so the caller retries.
    if (!body) return { ok: false, rev: expectedRev };
    return body.ok ? { ok: true, rev: body.rev } : { ok: false, rev: body.rev };
  }
}
