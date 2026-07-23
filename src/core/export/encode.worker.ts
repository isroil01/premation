/// <reference lib="webworker" />
/**
 * Export encode worker — runs the CPU-bound, DOM-free byte crunching (GIF89a +
 * LZW, STORE ZIP assembly) OFF the main thread. These encoders used to run
 * synchronously at the end of a GIF / image-sequence / mp4 export, freezing the
 * whole app (even the OS cursor) for seconds. The GPU per-frame rendering still
 * happens on the main thread (it needs the live scene/animation engine), but the
 * final encode no longer blocks the UI.
 *
 * The pure functions are the single source of truth (also unit-tested and used
 * as the synchronous fallback in encodeClient), so the worker adds no new
 * encoding logic — just an off-thread execution seam.
 */

import { createAnimatedGIFBytes, type GifFrame } from './gifEncoder';
import { zipBytes, type ZipEntry } from './zip';

type EncodeRequest =
  | { id: number; kind: 'gif'; frames: GifFrame[]; fps: number }
  | { id: number; kind: 'zip'; entries: ZipEntry[] };

interface EncodeResponse {
  id: number;
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<EncodeRequest>): void => {
  const msg = e.data;
  try {
    const bytes = msg.kind === 'gif'
      ? createAnimatedGIFBytes(msg.frames, msg.fps)
      : zipBytes(msg.entries);
    const res: EncodeResponse = { id: msg.id, ok: true, bytes };
    // Transfer the result buffer back so the main thread doesn't re-copy it.
    ctx.postMessage(res, [bytes.buffer]);
  } catch (err) {
    const res: EncodeResponse = { id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) };
    ctx.postMessage(res);
  }
};
