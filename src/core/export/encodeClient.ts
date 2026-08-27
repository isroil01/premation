/**
 * Client for the export encode worker (encode.worker.ts).
 *
 * Runs GIF / ZIP encoding off the main thread so a long export doesn't freeze
 * the UI. Buffers are TRANSFERRED to the worker, not structured-cloned — a
 * multi-gigabyte sequence zip used to exist twice at the postMessage boundary,
 * which is exactly the peak that pushed big exports into OOM. The sync
 * fallback still exists for the worker being unavailable (nothing was posted,
 * data intact); after a transfer the caller's buffers are detached, so a
 * worker that dies mid-encode fails the export with a real error instead of
 * silently re-encoding zeroed pixels.
 */

import { createAnimatedGIFBytes, type GifFrame } from './gifEncoder';
import { zipBytes, type ZipEntry } from './zip';

interface EncodeResponse {
  id: number;
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
}

let worker: Worker | null = null;
let workerPromise: Promise<Worker | null> | null = null;
let workerUnavailable = false;
let seq = 0;
const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void }>();

/**
 * Lazily spawn the encode worker. The `new Worker(new URL(...))` call is behind
 * a dynamic import (spawnEncodeWorker) so no statically-parsed module carries
 * `import.meta` — which the Jest transform rejects. Returns null (→ sync
 * fallback) if workers are unavailable or fail to load.
 */
async function getWorker(): Promise<Worker | null> {
  if (worker) return worker;
  if (workerUnavailable || typeof Worker === 'undefined') return null;
  if (!workerPromise) {
    workerPromise = (async (): Promise<Worker | null> => {
      try {
        const { spawnEncodeWorker } = await import('./spawnEncodeWorker');
        const w = spawnEncodeWorker();
        w.onmessage = (e: MessageEvent<EncodeResponse>): void => {
          const { id, ok, bytes, error } = e.data;
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          if (ok && bytes) p.resolve(bytes);
          else p.reject(new Error(error ?? 'encode failed'));
        };
        w.onerror = (): void => {
          // A load/runtime failure fails every in-flight request; callers fall back.
          for (const [, p] of pending) p.reject(new Error('encode worker error'));
          pending.clear();
          worker = null;
          workerUnavailable = true;
        };
        worker = w;
        return w;
      } catch {
        workerUnavailable = true;
        return null;
      }
    })();
  }
  return workerPromise;
}

function post(w: Worker, payload: Record<string, unknown>, transfer: Transferable[]): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, ...payload }, transfer);
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

/**
 * The distinct underlying ArrayBuffers of `views`, for a postMessage transfer
 * list. Deduplicated: two views on one buffer would make postMessage throw a
 * DataCloneError, and a SharedArrayBuffer cannot be transferred at all.
 */
function transferListOf(views: ReadonlyArray<{ buffer: ArrayBufferLike }>): ArrayBuffer[] {
  const seen = new Set<ArrayBufferLike>();
  const out: ArrayBuffer[] = [];
  for (const v of views) {
    const buf = v.buffer;
    if (seen.has(buf)) continue;
    seen.add(buf);
    if (typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer) continue;
    out.push(buf as ArrayBuffer);
  }
  return out;
}

/** Encode an animated GIF, off-thread when possible. */
export async function encodeGifBytes(frames: GifFrame[], fps: number): Promise<Uint8Array> {
  const w = await getWorker();
  if (!w) return createAnimatedGIFBytes(frames, fps);
  const sizes = frames.map((f) => f.pixels.byteLength);
  try {
    return await post(w, { kind: 'gif', frames, fps }, transferListOf(frames.map((f) => f.pixels)));
  } catch (err) {
    // Fall back to the sync encoder ONLY if the buffers survived (postMessage
    // itself failed before transferring). Detached frames read as all-zero
    // pixels — encoding those would ship a blank GIF under a success toast.
    const intact = frames.every((f, i) => f.pixels.byteLength === sizes[i]);
    if (!intact) throw err instanceof Error ? err : new Error('The encode worker failed mid-encode.');
    return createAnimatedGIFBytes(frames, fps);
  }
}

/** Assemble a STORE ZIP, off-thread when possible. */
export async function encodeZipBytes(entries: ZipEntry[]): Promise<Uint8Array> {
  const w = await getWorker();
  if (!w) return zipBytes(entries);
  const sizes = entries.map((e) => e.data.byteLength);
  try {
    return await post(w, { kind: 'zip', entries }, transferListOf(entries.map((e) => e.data)));
  } catch (err) {
    const intact = entries.every((e, i) => e.data.byteLength === sizes[i]);
    if (!intact) throw err instanceof Error ? err : new Error('The encode worker failed mid-encode.');
    return zipBytes(entries);
  }
}
