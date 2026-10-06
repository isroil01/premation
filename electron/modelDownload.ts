/**
 * The Object Matte model download, made from the main process.
 *
 * The Settings install flow lets a person paste any https URL and press
 * Install. That fetch cannot run in the renderer: the page's `connect-src`
 * names no model host, and it must not start to — Hugging Face resolves
 * `/resolve/` URLs through rotating CDN hostnames, so an allowlist would be
 * both wide and stale within a release. Main-process `fetch` is not subject to
 * the page CSP (the same reasoning as `aiProxy.ts`), so the policy stays
 * exactly as tight as it is and the download still happens only when the user
 * presses the button — the local edition's no-network-unless-asked claim is
 * about who initiates, not which process carries the bytes.
 *
 * ── What keeps this from being an open relay ─────────────────────────────
 * Unlike `api:request` (which attaches the user's bearer) and `ai:stream`
 * (which spends a vaulted key), this channel attaches NOTHING — no token, no
 * cookie, no key — and returns the bytes to the same renderer that asked. What
 * still needs defending is the user's own network position: https only, and no
 * literal-IP or localhost targets, so a compromised renderer cannot use it to
 * probe machines that only this host can reach. Redirects are followed because
 * model hosts require it; a host the user typed choosing where to bounce is
 * that host's prerogative.
 */

import { handle } from './ipcGuard';

/** Mirrors the renderer-side cap in samModelInstall.ts — a wrong URL must not
 *  fill the disk, and the renderer's copy of the check cannot be trusted. */
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

/** Progress messages are per-chunk upstream; the renderer needs far fewer. */
const PROGRESS_STRIDE = 256 * 1024;

/** In-flight downloads, so `objectMatte:cancelDownload` has a target. */
const inFlight = new Map<string, AbortController>();

/** Renderer-minted correlation ids — opaque, but bounded and printable. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface ModelDownloadProgress {
  requestId: string;
  receivedBytes: number;
  totalBytes: number | null;
}

export type ModelDownloadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; message: string };

/**
 * Why a URL is not downloadable, or null when it is.
 *
 * Exported for the test suite — this predicate is the whole security story of
 * the channel, so it is checked as a table rather than through the handler.
 */
export function checkModelUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return 'A model URL is required.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'That is not a valid URL.';
  }
  if (parsed.protocol !== 'https:') return 'Only https:// model URLs are accepted.';
  const host = parsed.hostname.toLowerCase();
  // No names for THIS machine or bare addresses: a hostname is what ties the
  // https certificate to a party who can be asked "which model is this".
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return 'Model downloads must come from a public host, not this machine.';
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) {
    return 'Model downloads must name a host, not an IP address.';
  }
  return null;
}

/**
 * Fetch `url` fully into memory, reporting progress through `emit`.
 *
 * Separated from the IPC handler so the byte-cap and progress behaviour are
 * testable against a stubbed fetch, without an Electron event in the picture.
 */
export async function downloadModelBytes(
  url: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
): Promise<ModelDownloadResult> {
  let res: Response;
  try {
    res = await fetch(url, { signal, redirect: 'follow' });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { ok: false, message: 'Cancelled.' };
    return { ok: false, message: 'Could not reach that host. Check the URL and your connection.' };
  }
  if (!res.ok) {
    return { ok: false, message: `The host answered ${res.status} ${res.statusText || ''}`.trim() };
  }

  const header = res.headers.get('content-length');
  const total = header ? Number(header) : null;
  if (total !== null && total > MAX_MODEL_BYTES) {
    return {
      ok: false,
      message: `That file is ${Math.round(total / 1024 / 1024)} MB, which is larger than this will accept.`,
    };
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastEmitted = 0;
  try {
    // Checked as it arrives, not only from the header: a server that reports
    // no length can still send gigabytes, and this is the only place that
    // notices before they are all in memory.
    for await (const chunk of (res.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      received += chunk.byteLength;
      if (received > MAX_MODEL_BYTES) {
        return { ok: false, message: 'The download exceeded the size this will accept and was stopped.' };
      }
      if (received - lastEmitted >= PROGRESS_STRIDE || lastEmitted === 0) {
        lastEmitted = received;
        emit(received, total);
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { ok: false, message: 'Cancelled.' };
    return { ok: false, message: 'The connection dropped mid-download.' };
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  emit(received, total);
  return { ok: true, bytes: out };
}

/**
 * Claim `requestId` for one download: an AbortController the cancel channel
 * can reach, and `done()` to release it. Null when the id is already running
 * (a reused id would let one call's Cancel abort another).
 */
export function registerDownloadCancel(requestId: string): { signal: AbortSignal; done: () => void } | null {
  if (!SAFE_REQUEST_ID.test(requestId) || inFlight.has(requestId)) return null;
  const controller = new AbortController();
  inFlight.set(requestId, controller);
  return { signal: controller.signal, done: () => void inFlight.delete(requestId) };
}

/**
 * The cancel channel. The download itself is `objectMatte:install`
 * (objectMatteModel.ts): main fetches the model and saves it where the engine
 * reads it; the bytes never go to the renderer.
 */
export function registerModelDownloadIpc(): void {
  handle('objectMatte:cancelDownload', (_event, requestId: unknown): boolean => {
    if (typeof requestId !== 'string') return false;
    const controller = inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    inFlight.delete(requestId);
    return true;
  });
}

/** Abort everything in flight — called on quit so no fetch outlives the app. */
export function abortAllModelDownloads(): void {
  for (const controller of inFlight.values()) controller.abort();
  inFlight.clear();
}
