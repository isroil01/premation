/**
 * Demux off the main thread, with the same contract as demuxing on it.
 *
 * ## What is actually being moved
 *
 * Not a decode. mp4box parses the whole sample table synchronously off
 * `appendBuffer`/`flush`, and for a 300 MB file that is a noticeable beat of
 * frozen UI — arriving exactly when the user has dropped footage in and is
 * watching for something to happen. The demuxers are pure JS over an
 * ArrayBuffer, so moving them needs no change to what they do, only to where.
 *
 * ## The fallback is not decoration
 *
 * Jest has no `Worker`, the render-test harness and the headless CLI run in
 * contexts where spawning one buys nothing, and a worker can simply fail to
 * load. All of those fall back to demuxing inline — the same function, the same
 * result, on this thread. A caller cannot tell which ran, which is what lets
 * every existing test keep exercising the pure functions directly.
 *
 * The failure that matters is the OTHER one: the buffer is TRANSFERRED, so a
 * worker that dies mid-demux leaves the caller holding a detached ArrayBuffer
 * it cannot retry with. That is why the transfer happens only once a worker is
 * confirmed live, and why a post-transfer failure rejects rather than quietly
 * retrying inline — re-demuxing a detached buffer would produce "0 samples"
 * rather than an error, and an index built over half a sample table produces
 * frame numbers that lie.
 */

import { demuxMp4, type DemuxedVideo } from './mp4Demuxer';
import { demuxWebm, isWebmMagic } from './webmDemuxer';
import { fromWire, type WireDemux } from './demuxWire';

interface DemuxResponse {
  id: number;
  ok: boolean;
  wire?: WireDemux;
  error?: string;
}

let worker: Worker | null = null;
let workerPromise: Promise<Worker | null> | null = null;
let workerUnavailable = false;
let seq = 0;
const pending = new Map<number, { resolve: (d: WireDemux) => void; reject: (e: unknown) => void }>();

/** Demux on THIS thread. The contract, and the fallback. */
export function demuxInline(bytes: ArrayBuffer): Promise<DemuxedVideo & { hasAlpha?: boolean }> {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return isWebmMagic(head) ? demuxWebm(bytes) : demuxMp4(bytes);
}

async function getWorker(): Promise<Worker | null> {
  if (worker) return worker;
  if (workerUnavailable || typeof Worker === 'undefined') return null;
  if (!workerPromise) {
    workerPromise = (async (): Promise<Worker | null> => {
      try {
        const { spawnDemuxWorker } = await import('./spawnDemuxWorker');
        const w = spawnDemuxWorker();
        w.onmessage = (e: MessageEvent<DemuxResponse>): void => {
          const { id, ok, wire, error } = e.data;
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          if (ok && wire) p.resolve(wire);
          else p.reject(new Error(error ?? 'demux failed'));
        };
        w.onerror = (): void => {
          // Every in-flight request already transferred its buffer, so none of
          // them can be retried inline. Fail them honestly.
          for (const [, p] of pending) p.reject(new Error('demux worker error'));
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

/**
 * Demux a whole file, off the main thread when one is available.
 *
 * The buffer is TRANSFERRED on the worker path: it is detached on return and
 * the caller must not read it again. Every current caller reads its magic bytes
 * before this and never touches the buffer after, which is what makes the
 * transfer safe rather than merely fast.
 */
export async function demuxFile(bytes: ArrayBuffer): Promise<DemuxedVideo & { hasAlpha?: boolean }> {
  const w = await getWorker();
  if (!w) return demuxInline(bytes);
  const id = ++seq;
  const wire = await new Promise<WireDemux>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, bytes }, [bytes]);
    } catch (err) {
      // The post itself failed, so nothing was transferred and the buffer is
      // still intact — this is the one failure that can safely fall back.
      pending.delete(id);
      reject(err);
    }
  }).catch(async (err: unknown) => {
    if (bytesDetached(bytes)) throw err;
    return null;
  });
  if (wire === null) return demuxInline(bytes);
  return fromWire(wire);
}

/** True once a buffer has been handed over and can no longer be read. */
function bytesDetached(b: ArrayBuffer): boolean {
  // A detached ArrayBuffer reports byteLength 0. Checking rather than tracking
  // a flag keeps this honest about what the platform actually did with it.
  return b.byteLength === 0;
}

/** Drop the worker (teardown, and the test seam). */
export function resetDemuxWorker(): void {
  try {
    worker?.terminate();
  } catch {
    /* already gone */
  }
  worker = null;
  workerPromise = null;
  workerUnavailable = false;
  pending.clear();
}
