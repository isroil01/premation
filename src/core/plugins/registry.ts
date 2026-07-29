/**
 * The plugin registry, client side.
 *
 * The important part of this file is not the fetching — it is
 * `verifyPackageSignature`, which runs HERE, on the user's machine, over the
 * exact bytes that are about to be installed. That check is what makes the
 * registry's promise mean anything: a compromised server, a proxy, or a
 * modified download is detectable locally, without trusting the thing that
 * served it.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *   1. **The key is pinned by the client, not chosen by the response.** For an
 *      update, the key to verify against is the one stored with the copy the
 *      user already has. A server that could hand over both the package and the
 *      key it should be checked with is a server that can hand over anything.
 *   2. **Nothing is installed before verification.** The bytes are checked
 *      before they are parsed, and parsed before the consent screen — so an
 *      unverified package never reaches the zip reader.
 *
 * Update checks happen only when the user opens the plugin manager. Plugins
 * themselves still have no network path whatsoever; this is the app talking,
 * about plugins, at a moment the user is already looking at them.
 */

import { request } from '@core/api/client';
import type { PluginPermission } from './manifest';

/** What browse returns for one plugin. Never includes package bytes. */
export interface RegistryPlugin {
  id: string;
  name: string;
  description: string;
  homepage: string | null;
  latestVersion: string;
  permissions: PluginPermission[];
  apiVersion: number;
  hasPanel: boolean;
  installs: number;
  /** SPKI, base64. Pinned on install so later updates can be checked against it. */
  publisherKey: string;
}

export interface RegistryUpdate {
  id: string;
  latestVersion: string;
  publisherKey: string;
  blocked: boolean;
  blockedReason: string | null;
}

/**
 * Base64 → bytes, without a dependency.
 *
 * Backed by an explicit `ArrayBuffer` because WebCrypto's `BufferSource` will
 * not take a view over a `SharedArrayBuffer`, and TypeScript is right to insist:
 * a shared buffer can be mutated by another thread between the signature check
 * and the read that follows it.
 */
function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Verify a detached signature over `bytes`.
 *
 * ECDSA P-256 / SHA-256, signature as IEEE-P1363 (r||s), key as SPKI — the same
 * three choices the backend spells out in `plugin-signature.ts`. They have to
 * match exactly; there is no negotiation and no fallback, because a verifier
 * that falls back is a verifier that can be talked out of checking.
 */
export async function verifyPackageSignature(
  bytes: Uint8Array,
  signatureBase64: string,
  publicKeySpkiBase64: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      decodeBase64(publicKeySpkiBase64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const signature = decodeBase64(signatureBase64);
    if (signature.length !== 64) return false;
    // Copied into a non-shared buffer for the same reason as above; the caller
    // may hand us a view over anything.
    const data = new Uint8Array(bytes);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
  } catch {
    // A malformed key or signature is a refusal, not a crash: from here it is
    // the same answer either way — do not install this.
    return false;
  }
}

/** Search the registry. */
export async function browseRegistry(q?: string): Promise<RegistryPlugin[]> {
  const query = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  // `request` and not a bare fetch: it carries the bearer, refreshes it when it
  // has expired, and turns an error body into a message. A hand-rolled fetch
  // here would send a stale token an hour into a session.
  const body = await request<{ items: RegistryPlugin[] }>(`/plugins${query}`);
  return body.items ?? [];
}

/**
 * Fetch and verify a package.
 *
 * `expectedKey` is the pin. Pass the key stored with an installed copy when
 * updating; pass the key from the browse listing the user is looking at when
 * installing fresh (that is the trust-on-first-use moment, and it is the same
 * decision the consent screen is about to make explicit).
 */
export async function fetchRegistryPackage(
  id: string,
  version: string,
  expectedKey: string,
): Promise<{ bytes: Uint8Array; publisherKey: string }> {
  const body = await request<{
    package: string;
    signature: string;
    publisherKey: string;
    sha256: string;
  }>(`/plugins/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/download`);

  if (body.publisherKey !== expectedKey) {
    throw new Error(
      'This download is signed by a different publisher key than the one this plugin is known by. '
      + 'It has NOT been installed. Either the plugin changed hands, or something is impersonating it.',
    );
  }

  const bytes = decodeBase64(body.package);
  const ok = await verifyPackageSignature(bytes, body.signature, expectedKey);
  if (!ok) {
    throw new Error(
      'The downloaded package does not match its signature. It has NOT been installed — '
      + 'the file was modified after the publisher signed it.',
    );
  }

  return { bytes, publisherKey: body.publisherKey };
}

/**
 * Which installed plugins have a newer version — or have been withdrawn.
 *
 * Failure is deliberately quiet: the registry being unreachable is not an
 * error the user needs to see while opening a panel, and treating it as one
 * would put an error toast in front of anyone working offline.
 */
export async function checkForUpdates(
  installed: ReadonlyArray<{ id: string; version: string }>,
): Promise<RegistryUpdate[]> {
  if (installed.length === 0) return [];
  try {
    return await request<RegistryUpdate[]>('/plugins/updates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installed: installed.map((i) => ({ id: i.id, version: i.version })) }),
    });
  } catch {
    return [];
  }
}
