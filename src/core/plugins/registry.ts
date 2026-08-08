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
 * Update checks happen only when the user opens the plugin manager. This is the
 * app talking to the registry, about plugins, at a moment the user is already
 * looking at them — not a plugin reaching anywhere.
 *
 * A plugin's own network path, where it has one at all, is a separate thing
 * that does not run through this file: `motion.net.fetch`, restricted to the
 * hosts the plugin declared in its manifest and the user approved by name. See
 * `pluginNetFetch.ts`.
 */

import { request, apiBaseUrl } from '@core/api/client';
import { pluginRegistryEnabled } from '@core/config/edition';
import { HOST_API_VERSION, type PluginPermission } from './manifest';
import type { ReportCategory } from './reportCategories';

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
  /** Namespace identity. Empty strings for a plugin published before namespaces. */
  publisher: { namespace: string; displayName: string; verified: boolean };
  categories: string[];
  license: string | null;
  /** Registry-relative path, or null. Resolve with `registryMediaUrl`. */
  iconUrl: string | null;
  contributes: { commands: unknown[]; panels: unknown[] };
  updatedAt: string;
}

/** What the detail endpoint adds. */
export interface RegistryDetail extends RegistryPlugin {
  /** Server-rendered and sanitised. Never rendered from Markdown on this side. */
  readmeHtml: string;
  /** The Markdown SOURCE, so a publisher editing their listing round-trips it
   *  rather than being handed back the HTML we generated from it. */
  readme: string;
  changelog: string;
  screenshots: Array<{ id: string; url: string; width: number; height: number }>;
  versionHistory: Array<{ version: string; apiVersion: number; size: number; createdAt: string }>;
  contributesDetail: {
    commands: Array<{ id: string; label: string; icon?: string; needsSelection?: boolean }>;
    panels: Array<{ id: string; title: string }>;
  };
  blocked: boolean;
  blockedReason: string | null;
}

/**
 * A browse result that can say WHY it is empty.
 *
 * The local edition ships no hosted registry, and the previous version of this
 * returned `[]` for that case — indistinguishable from "nothing matched your
 * search". So the Browse pane told a self-hosted user "Nothing published yet",
 * which is both false and unactionable: there is nothing they can do, because
 * the feature is not in their build. The two states are separated HERE, in the
 * data layer, rather than guessed at from an empty array by the UI.
 */
export type BrowseResult =
  | { available: false }
  | { available: true; items: RegistryPlugin[]; total: number };

export interface BrowseQuery {
  q?: string;
  category?: string;
  sort?: 'installs' | 'updated' | 'new';
  /** Filter to what THIS editor can run. Defaults to the host API version. */
  apiVersion?: number;
  limit?: number;
  offset?: number;
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

/**
 * Search the registry.
 *
 * Returns `{ available: false }` in the local edition rather than an empty
 * list, so the UI can say "not available in this edition" instead of "nothing
 * published yet". Those are different facts and only one of them is true.
 */
export async function browseRegistry(query: BrowseQuery = {}): Promise<BrowseResult> {
  if (!pluginRegistryEnabled()) return { available: false };

  const params = new URLSearchParams();
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.category) params.set('category', query.category);
  if (query.sort) params.set('sort', query.sort);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  // Always sent. Without it a user finds a package their editor refuses, and
  // that reads as a broken marketplace rather than a version mismatch.
  params.set('apiVersion', String(query.apiVersion ?? HOST_API_VERSION));

  // `request` and not a bare fetch: it carries the bearer, refreshes it when it
  // has expired, and turns an error body into a message. A hand-rolled fetch
  // here would send a stale token an hour into a session. Browse is public
  // now, but the same client still handles the signed-in calls beside it.
  const body = await request<{ items: RegistryPlugin[]; total: number }>(
    `/plugins?${params.toString()}`,
  );
  return { available: true, items: body.items ?? [], total: body.total ?? 0 };
}

/** One plugin's full listing. `null` when the registry has no such plugin. */
export async function fetchRegistryDetail(id: string): Promise<RegistryDetail | null> {
  if (!pluginRegistryEnabled()) return null;
  if (!REGISTRY_ID_RE.test(id)) return null;
  try {
    return await request<RegistryDetail>(`/plugins/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

/**
 * Absolute URL for a registry-relative media path.
 *
 * The path comes from the registry, so it is checked against the shape we
 * issue rather than concatenated blindly — a value that reached an <img src>
 * unchecked would be a redirect primitive pointed at whatever the response
 * said.
 */
export function registryMediaUrl(path: string | null | undefined): string | null {
  if (!path || !/^\/plugins\/media\/[A-Za-z0-9-]+$/.test(path)) return null;
  return `${apiBaseUrl()}${path}`;
}

/**
 * Plugin ids that may be routed on.
 *
 * Deep links and tab state both carry one, and both are untrusted input by the
 * time they arrive: a link is whatever was in the URL bar, and tab state
 * survived a reload in localStorage. Validated before it reaches a fetch or a
 * store lookup.
 */
export const REGISTRY_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

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
  // Unreachable through the UI in the local edition (`browseRegistry` returns
  // nothing to install and `checkForUpdates` nothing to update), but this is the
  // function that would fetch bytes and run them — so it refuses on its own
  // rather than trusting its callers to have been gated.
  if (!pluginRegistryEnabled()) {
    throw new Error('The plugin registry is not available in this edition.');
  }
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
  if (!pluginRegistryEnabled()) return [];
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

// ── Publishing, from inside the editor ────────────────────────────────────

/**
 * A publisher identity the signed-in user owns.
 *
 * `verified` is granted by an operator, never self-served. A publisher cannot
 * award themselves the badge, which is the only thing that makes it worth
 * anything to a reader.
 */
export interface PublisherRecord {
  id: string;
  namespace: string;
  displayName: string;
  verified: boolean;
  verifiedDomain: string | null;
}

/**
 * Everything the signed-in user has published.
 *
 * `[]` in the local edition rather than an error: there is no registry to have
 * published to, and the caller's empty state already reads correctly.
 */
export async function myPublishedPlugins(): Promise<RegistryPlugin[]> {
  if (!pluginRegistryEnabled()) return [];
  return request<RegistryPlugin[]>('/plugins/mine/list');
}

export async function myPublishers(): Promise<PublisherRecord[]> {
  if (!pluginRegistryEnabled()) return [];
  return request<PublisherRecord[]>('/publishers/mine');
}

export async function registerPublisher(
  namespace: string,
  displayName: string,
): Promise<PublisherRecord> {
  return request<PublisherRecord>('/publishers', {
    method: 'POST',
    body: JSON.stringify({ namespace, displayName }),
  });
}

/** The category vocabulary the registry accepts. Served at `/plugins/categories`. */
export const REGISTRY_CATEGORIES = [
  'animation', 'effects', 'text', 'shapes', 'import-export', 'workflow',
  'rigging', '3d', 'color', 'audio', 'developer', 'other',
] as const;

/**
 * Edit a listing WITHOUT publishing a version.
 *
 * The whole reason this exists separately from `publish`: a typo in a README is
 * a typo, and fixing it should not mean cutting a new signed version and asking
 * every installed copy to update.
 *
 * Note what is NOT here: `name` and `description`. Those are read out of the
 * SIGNED package at publish time, so a listing cannot claim something the
 * package does not say. To change them, change `plugin.json` and publish.
 */
export async function updateListing(
  id: string,
  patch: { readme?: string; changelog?: string; categories?: string[]; license?: string },
): Promise<void> {
  await request<unknown>(`/plugins/${encodeURIComponent(id)}/listing`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/**
 * Report a plugin.
 *
 * No account required — the endpoint takes an identity if the caller has one
 * and refuses nobody. That is deliberate on the server, and it matters here
 * too: the moment worth reporting is often *before* installing, and a dialog
 * that demanded a sign-in first would simply lose the report.
 *
 * Errors are thrown rather than swallowed. This is the one registry call where
 * a silent failure is unacceptable — a reporter told "thank you" who was not
 * heard has been actively misled, and will not bother a second time.
 */
export async function reportPlugin(
  id: string,
  input: { category: ReportCategory; version?: string; message?: string },
): Promise<{ caseId: string; reportCount: number }> {
  return request<{ caseId: string; reportCount: number }>(
    `/plugins/${encodeURIComponent(id)}/report`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/**
 * The signed revocation list.
 *
 * A plain GET with no body and no auth — see `revocation.ts` for why that is a
 * requirement rather than a convenience. Returns null in the local edition and
 * on any failure, because a client that cannot reach the list keeps enforcing
 * the last one it verified.
 */
export async function fetchRevocationList(): Promise<{ payload: string; signature: string } | null> {
  if (!pluginRegistryEnabled()) return null;
  try {
    const res = await fetch(`${apiBaseUrl()}/plugins/revocations`);
    if (!res.ok) return null;
    const body = (await res.json()) as { payload?: string; signature?: string };
    return body?.payload && body?.signature
      ? { payload: body.payload, signature: body.signature }
      : null;
  } catch {
    return null;
  }
}
