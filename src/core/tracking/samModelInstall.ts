/**
 * Installing the Object Matte model — the last mile of neural rotoscoping.
 *
 * Everything else has been in the tree since the tracking column shipped: the
 * segmenter (`samSegment.ts`), the ONNX wrapper (`samOnnxLoader.ts`),
 * `onnxruntime-web` in the dependency list, and a boot hook reading
 * `VITE_SAM_MODEL_URL`. What was missing was a MODEL — and a build-time
 * environment variable is not a way for a person to get one.
 *
 * ── Never automatic ────────────────────────────────────────────────────
 * The local edition's claim is that it does not reach the network unless you
 * ask it to, and that claim is worth more than the convenience of a silent
 * download. So nothing here runs on its own: a person types or accepts a URL
 * and presses a button, the host is stated before the request, and a build with
 * no cached model behaves exactly as it does today — clicks fall back to
 * classical GrabCut, which is a real matte and not an error state.
 *
 * Once installed the model is cached (`samModelCache.ts`) and restored at boot
 * with no network at all.
 */

import { create } from 'zustand';
import { ModelCache, SAM_MODEL_KEY, type CachedModel } from './samModelCache';
import { tryRegisterSamOnnxFromBytes, unregisterSamOnnx } from './samOnnxLoader';

/**
 * A suggested model, not a bundled one.
 *
 * Offered as a default in the field so the common case is one click, and
 * editable because the right model is a moving target and nobody should have to
 * wait for a release to try a better one. Any ONNX file whose first input takes
 * NCHW float RGB will load; see `wrapSession`.
 */
export const SUGGESTED_MODEL = {
  label: 'MobileSAM (decoder, ONNX)',
  url: 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/model_quantized.onnx',
  approxBytes: 40 * 1024 * 1024,
} as const;

/** The largest file this will accept, so a wrong URL cannot fill the disk. */
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

export type ModelStatus =
  | { kind: 'absent' }
  | { kind: 'downloading'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'ready'; sourceUrl: string; bytes: number; installedAt: number }
  | { kind: 'failed'; message: string };

interface SamModelState {
  status: ModelStatus;
  /** Restore a cached model and register it. Safe to call repeatedly. */
  restore: () => Promise<void>;
  /** Fetch, cache and register. Rejects nothing — the status carries failure. */
  install: (url: string) => Promise<void>;
  /** Forget the cached model and unregister the session. */
  remove: () => Promise<void>;
  /** Abort a download in flight. */
  cancel: () => void;
}

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

const statusFor = (model: CachedModel): ModelStatus => ({
  kind: 'ready',
  sourceUrl: model.sourceUrl,
  bytes: model.bytes,
  installedAt: model.installedAt,
});

export const useSamModelStore = create<SamModelState>((set) => ({
  status: { kind: 'absent' },

  async restore() {
    const cached = await ModelCache.get();
    if (!cached) return;
    const bytes = new Uint8Array(await cached.data.arrayBuffer());
    const result = await tryRegisterSamOnnxFromBytes(bytes);
    if (result.status === 'ok') {
      set({ status: statusFor(cached) });
      return;
    }
    // Cached but unusable — a runtime that is no longer installed, or a model
    // this build cannot read. Reported rather than silently discarded: deleting
    // someone's 40 MB download because it did not load today is not this
    // module's decision to make.
    set({ status: { kind: 'failed', message: result.reason } });
  },

  async install(url) {
    const trimmed = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      set({ status: { kind: 'failed', message: 'That is not a valid URL.' } });
      return;
    }
    if (parsed.protocol !== 'https:') {
      // Plain HTTP would let anything on the path substitute the model that is
      // about to be run on the user's footage.
      set({ status: { kind: 'failed', message: 'Only https:// model URLs are accepted.' } });
      return;
    }

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    set({ status: { kind: 'downloading', receivedBytes: 0, totalBytes: null } });

    try {
      const response = await fetch(trimmed, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) {
        throw new Error(`The host answered ${response.status} ${response.statusText || ''}`.trim());
      }
      const bytes = await readWithProgress(
        response,
        (receivedBytes, totalBytes) => set({ status: { kind: 'downloading', receivedBytes, totalBytes } }),
        controller.signal,
      );

      if (!looksLikeOnnx(bytes)) {
        throw new Error('That URL did not return an ONNX model — check it points at the .onnx file itself.');
      }

      const registered = await tryRegisterSamOnnxFromBytes(bytes);
      if (registered.status !== 'ok') {
        // NOT cached on failure. Keeping bytes that cannot be loaded would give
        // every future boot a "failed" state to report over a file nothing can
        // use, which is worse than having to download again.
        throw new Error(registered.reason);
      }

      const model: CachedModel = {
        id: SAM_MODEL_KEY,
        // Copied into a fresh ArrayBuffer: a Uint8Array can be backed by a
        // SharedArrayBuffer, which Blob does not accept, and the copy is also
        // what detaches the cached bytes from the download buffer.
        data: new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: 'application/octet-stream' }),
        sourceUrl: trimmed,
        installedAt: Date.now(),
        bytes: bytes.byteLength,
      };
      await ModelCache.put(model);
      set({ status: statusFor(model) });
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      set({
        status: aborted
          ? { kind: 'absent' }
          : { kind: 'failed', message: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  },

  async remove() {
    inFlight?.abort();
    unregisterSamOnnx();
    await ModelCache.remove();
    set({ status: { kind: 'absent' } });
  },

  cancel() {
    inFlight?.abort();
  },
}));

/**
 * Restore a cached model at boot, if there is one.
 *
 * Fire-and-forget and completely silent when nothing is cached: a build that
 * has never installed a model must not pay for this, log about it, or touch the
 * network because of it.
 */
export function restoreSamModelAtBoot(): void {
  void ModelCache.get().then((cached) => {
    if (cached) void useSamModelStore.getState().restore();
  });
}
