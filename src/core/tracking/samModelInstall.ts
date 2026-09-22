/**
 * Installing the Object Matte model — the last mile of neural rotoscoping.
 *
 * A build already ships a working pair (`samBundled.ts`); this flow exists for
 * the person who wants a DIFFERENT model — a bigger SAM export, a fine-tune —
 * without waiting for a release. SAM-class checkpoints ship as an
 * encoder/decoder pair (see `samPipeline.ts`), so that is what this installs:
 * two ONNX files, cached together, registered together.
 *
 * ── Never automatic ────────────────────────────────────────────────────
 * The local edition's claim is that it does not reach the network unless you
 * ask it to, and that claim is worth more than the convenience of a silent
 * download. So nothing here runs on its own: a person types or accepts URLs
 * and presses a button, the hosts are stated before the request, and a build
 * with nothing installed falls back to the bundled pair, then to classical
 * GrabCut — a real matte, not an error state.
 *
 * ── Who carries the bytes ──────────────────────────────────────────────
 * In the desktop app the fetch itself runs in the MAIN process
 * (`electron/modelDownload.ts`): the page CSP names no model host, and it must
 * not start to — Hugging Face bounces `/resolve/` URLs through rotating CDN
 * hostnames, so a `connect-src` allowlist would be wide AND stale. Outside
 * Electron (a browser tab, a dev server) the renderer fetch remains, and works
 * exactly where the page's own policy allows it to.
 *
 * Once installed the pair is cached (`samModelCache.ts`) and restored at boot
 * with no network at all.
 *
 * ── Where the state lives ──────────────────────────────────────────────
 * This module does the work and reports through a `(status) => void`
 * callback; the zustand store the UI subscribes to is
 * `@stores/samModelStore`. `src/core` does not import zustand
 * (docs/NATIVE_CORE_PLAN.md §4 T0).
 */

import { ModelCache, SAM_MODEL_KEY, type CachedModel } from './samModelCache';
import { tryRegisterSamPipeline, unregisterSamOnnx } from './samOnnxLoader';

/**
 * A suggested model, not a bundled one.
 *
 * The same SlimSAM pair the app bundles — offered as the field default so the
 * common case is one click, and editable because the right model is a moving
 * target. Both halves of the transformers.js export layout are needed; a
 * single-file URL cannot work, because no published SAM export answers
 * "image in, mask out" in one session (see `samPipeline.ts`).
 */
export const SUGGESTED_MODEL = {
  label: 'SlimSAM-77 (encoder + decoder, ONNX)',
  encoderUrl: 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx',
  decoderUrl: 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx',
  approxBytes: 14 * 1024 * 1024,
} as const;

/** The largest file this will accept, so a wrong URL cannot fill the disk.
 *  The main-process downloader enforces the same cap on its side. */
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

export type ModelStatus =
  | { kind: 'absent' }
  | { kind: 'downloading'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'ready'; sourceUrl: string; decoderUrl?: string; bytes: number; installedAt: number }
  /** The encoder/decoder pair that ships inside the app (samBundled.ts) is
   *  registered. Nothing was downloaded and there is nothing to remove —
   *  installing a custom model overrides it for the session. */
  | { kind: 'bundled'; bytes: number }
  | { kind: 'failed'; message: string };

let inFlight: AbortController | null = null;

/**
 * Read a response body with progress.
 *
 * `Content-Length` is absent on a chunked response, which is common enough on
 * model hosts that "no total" has to be a normal state rather than a failure —
 * the UI shows megabytes received instead of a percentage.
 */
async function readWithProgress(
  response: Response,
  onProgress: (received: number, total: number | null) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const header = response.headers.get('content-length');
  const total = header ? Number(header) : null;
  if (total !== null && total > MAX_MODEL_BYTES) {
    throw new Error(`That file is ${Math.round(total / 1024 / 1024)} MB, which is larger than this will accept.`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onProgress(buffer.byteLength, buffer.byteLength);
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    // Checked as it arrives, not only from the header: a server that reports no
    // length can still send gigabytes, and this is the only place that notices.
    if (received > MAX_MODEL_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The download exceeded the size this will accept and was stopped.');
    }
    onProgress(received, total);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** ONNX files are protobuf; the first field tag is a reliable, cheap check. */
export function looksLikeOnnx(bytes: Uint8Array): boolean {
  // A wrong URL usually returns HTML — an error page, a login wall, a redirect
  // notice — and handing that to the ONNX runtime produces an unreadable
  // exception several layers down. Rejecting it here says what happened.
  if (bytes.byteLength < 16) return false;
  const head = String.fromCharCode(...bytes.slice(0, 16)).toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html')) return false;
  // Protobuf field 1 (ir_version), varint: 0x08.
  return bytes[0] === 0x08;
}

/** The main-process downloader, when the desktop bridge offers one. */
interface DownloadBridge {
  download: (request: { url: string; requestId: string }) => Promise<
    { ok: true; bytes: Uint8Array } | { ok: false; message: string }
  >;
  cancelDownload: (requestId: string) => Promise<boolean>;
  onDownloadProgress: (handler: (event: unknown) => void) => () => void;
}

function downloadBridge(): DownloadBridge | null {
  const om = window.motionEditor?.objectMatte;
  if (om?.download && om.cancelDownload && om.onDownloadProgress) return om as DownloadBridge;
  return null;
}

/**
 * Fetch one model file, preferring the main-process downloader.
 *
 * Same contract either way: bytes on success, a thrown Error naming what went
 * wrong, an AbortError when `signal` fired, and progress along the way. The
 * bridge path exists because the page CSP blocks model hosts (see module doc);
 * the fetch path keeps a plain browser tab working where its policy allows.
 */
async function fetchModelBytes(
  url: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number | null) => void,
): Promise<Uint8Array> {
  const bridge = downloadBridge();
  if (!bridge) {
    const response = await fetch(url, { signal, redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`The host answered ${response.status} ${response.statusText || ''}`.trim());
    }
    return readWithProgress(response, onProgress, signal);
  }

  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  const unsubscribe = bridge.onDownloadProgress((event) => {
    const p = event as { requestId?: unknown; receivedBytes?: unknown; totalBytes?: unknown };
    if (p?.requestId !== requestId || typeof p.receivedBytes !== 'number') return;
    onProgress(p.receivedBytes, typeof p.totalBytes === 'number' ? p.totalBytes : null);
  });
  // Main owns the fetch, so Cancel must cross the bridge to reach it.
  const onAbort = (): void => void bridge.cancelDownload(requestId);
  signal.addEventListener('abort', onAbort);
  try {
    const result = await bridge.download({ url, requestId });
    if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
    if (!result?.ok) throw new Error(result?.message || 'The download failed.');
    // Structured clone can deliver a Buffer-backed view; normalise.
    return new Uint8Array(result.bytes);
  } finally {
    signal.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}

const statusFor = (model: CachedModel): ModelStatus => ({
  kind: 'ready',
  sourceUrl: model.sourceUrl,
  ...(model.decoderUrl ? { decoderUrl: model.decoderUrl } : {}),
  bytes: model.bytes,
  installedAt: model.installedAt,
});

/** Both files must be https; the reason names which one is wrong. */
function checkUrls(encoderUrl: string, decoderUrl: string): string | null {
  for (const [label, value] of [['encoder', encoderUrl], ['decoder', decoderUrl]] as const) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return `The ${label} URL is not a valid URL.`;
    }
    if (parsed.protocol !== 'https:') {
      // Plain HTTP would let anything on the path substitute the model that is
      // about to be run on the user's footage.
      return `Only https:// model URLs are accepted (the ${label} URL is not).`;
    }
  }
  return null;
}

/** How the install flow reports: every state change goes through here. */
export type StatusReporter = (status: ModelStatus) => void;

/** Restore a cached pair and register it. Safe to call repeatedly. */
export async function restoreSamModel(set: StatusReporter): Promise<void> {
  const cached = await ModelCache.get();
  if (!cached) return;
  if (!cached.decoderData) {
    // A record from before the install flow spoke the real SAM protocol: one
    // file, loadable only by the legacy naive wrapper, which no published SAM
    // export answers. Registering it would look like success while every
    // click fell through — worse, it would take precedence over the bundled
    // pair that actually works. Reported, not deleted: discarding someone's
    // download is not this module's decision to make.
    set({
      kind: 'failed',
      message:
        'The installed model is a single file from an earlier version, which the segmenter '
        + 'no longer uses. Install again to fetch an encoder/decoder pair.',
    });
    return;
  }
  const [encoder, decoder] = await Promise.all([
    cached.data.arrayBuffer().then((b) => new Uint8Array(b)),
    cached.decoderData.arrayBuffer().then((b) => new Uint8Array(b)),
  ]);
  const result = await tryRegisterSamPipeline(encoder, decoder);
  if (result.status === 'ok') {
    set(statusFor(cached));
    return;
  }
  // Cached but unusable — a runtime that is no longer installed, or a model
  // this build cannot read. Reported rather than silently discarded, for the
  // same reason as above.
  set({ kind: 'failed', message: result.reason });
}

/** Fetch, cache and register. Rejects nothing — the status carries failure. */
export async function installSamModel(encoderUrl: string, decoderUrl: string, set: StatusReporter): Promise<void> {
  const encTrimmed = encoderUrl.trim();
  const decTrimmed = decoderUrl.trim();
  const refusal = checkUrls(encTrimmed, decTrimmed);
  if (refusal) {
    set({ kind: 'failed', message: refusal });
    return;
  }

  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;
  set({ kind: 'downloading', receivedBytes: 0, totalBytes: null });

  try {
    // One progress envelope across both files. The combined total is only
    // claimed once both are known — a percentage over half the bytes would
    // be a lie, so until then the UI shows megabytes received.
    let encReceived = 0;
    let encTotal: number | null = null;
    let decReceived = 0;
    let decTotal: number | null = null;
    const report = (): void =>
      set({
        kind: 'downloading',
        receivedBytes: encReceived + decReceived,
        totalBytes: encTotal !== null && decTotal !== null ? encTotal + decTotal : null,
      });

    const encoder = await fetchModelBytes(encTrimmed, controller.signal, (received, total) => {
      encReceived = received;
      encTotal = total;
      report();
    });
    encReceived = encoder.byteLength;
    encTotal = encoder.byteLength;
    const decoder = await fetchModelBytes(decTrimmed, controller.signal, (received, total) => {
      decReceived = received;
      decTotal = total;
      report();
    });

    if (!looksLikeOnnx(encoder)) {
      throw new Error('The encoder URL did not return an ONNX model — check it points at the .onnx file itself.');
    }
    if (!looksLikeOnnx(decoder)) {
      throw new Error('The decoder URL did not return an ONNX model — check it points at the .onnx file itself.');
    }

    const registered = await tryRegisterSamPipeline(encoder, decoder);
    if (registered.status !== 'ok') {
      // NOT cached on failure. Keeping bytes that cannot be loaded would give
      // every future boot a "failed" state to report over files nothing can
      // use, which is worse than having to download again.
      throw new Error(registered.reason);
    }

    // Copied into fresh ArrayBuffers: a Uint8Array can be backed by a
    // SharedArrayBuffer, which Blob does not accept, and the copy is also
    // what detaches the cached bytes from the download buffers.
    const asBlob = (bytes: Uint8Array): Blob =>
      new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const model: CachedModel = {
      id: SAM_MODEL_KEY,
      data: asBlob(encoder),
      sourceUrl: encTrimmed,
      decoderData: asBlob(decoder),
      decoderUrl: decTrimmed,
      installedAt: Date.now(),
      bytes: encoder.byteLength + decoder.byteLength,
    };
    await ModelCache.put(model);
    set(statusFor(model));
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    set(
      aborted
        ? { kind: 'absent' }
        : { kind: 'failed', message: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

/** Forget the cached model and unregister the session. */
export async function removeSamModel(set: StatusReporter): Promise<void> {
  inFlight?.abort();
  unregisterSamOnnx();
  await ModelCache.remove();
  set({ kind: 'absent' });
}

/** Abort a download in flight. */
export function cancelSamDownload(): void {
  inFlight?.abort();
}
