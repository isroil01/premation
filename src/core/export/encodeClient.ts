/**
 * Client for the export encode worker (encode.worker.ts).
 *
 * Runs GIF / ZIP encoding off the main thread so a long export doesn't freeze
 * the UI. Structured-clone (no transfer on the way IN) keeps the caller's data
 * intact, so if the worker is unavailable or errors we transparently fall back
 * to the SAME pure encoder synchronously — correctness never depends on the
 * worker actually being there.
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

function post(w: Worker, payload: Record<string, unknown>): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...payload });
  });
}

/** Encode an animated GIF, off-thread when possible. */
export async function encodeGifBytes(frames: GifFrame[], fps: number): Promise<Uint8Array> {
  const w = await getWorker();
  if (!w) return createAnimatedGIFBytes(frames, fps);
  try {
    return await post(w, { kind: 'gif', frames, fps });
  } catch {
    // Worker died mid-flight — the caller's frames are untouched (no transfer in).
    return createAnimatedGIFBytes(frames, fps);
  }
}

/** Assemble a STORE ZIP, off-thread when possible. */
export async function encodeZipBytes(entries: ZipEntry[]): Promise<Uint8Array> {
  const w = await getWorker();
  if (!w) return zipBytes(entries);
  try {
    return await post(w, { kind: 'zip', entries });
  } catch {
    return zipBytes(entries);
  }
}
