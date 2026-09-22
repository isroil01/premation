/**
 * The raw pixel pipe — how a rendered frame's RGBA bytes cross IPC into the
 * ffmpeg child that the main process holds open (`render:openStream`).
 *
 * ── Why chunks ──────────────────────────────────────────────────────────────
 *
 * One IPC message per frame was the first version. Electron copies a message
 * through structured clone into main's heap BEFORE the handler runs, so a
 * 4K frame (33 MB) is 33 MB parked in main with nothing able to say "not
 * yet"; a burst of them, or a renderer that outpaces the encoder, grew main
 * until it died. Chunks fix both halves: the copy is bounded by the chunk,
 * and the renderer awaits each chunk's ack — the handler resolving only once
 * the bytes have drained into ffmpeg's stdin — before sending the next, so the
 * encoder's speed is the render's speed.
 *
 * ── The numbers ─────────────────────────────────────────────────────────────
 *
 * Chunk: 4 MiB. A 1080p frame (8,294,400 B) is 2 chunks (1 full + 1 of 3.9
 * MiB); 4K UHD (33,177,600 B) is 8. An IPC round trip in Electron 32 measured
 * 0.15–0.3 ms plus the clone at ~5 GB/s, so the ack cadence costs ≈ 0.5 ms
 * per 1080p frame and ≈ 2 ms per 4K frame — under 1 % of either frame's
 * encode. Smaller chunks (1 MiB) quadrupled the round trips for no memory a
 * user would notice; larger ones (16 MiB) put a 4K frame back to two copies
 * of 16 MB, which is what the change exists to remove. Main refuses anything
 * over `RAW_PIPE_MAX_CHUNK_BYTES` (8 MiB, electron/ffmpegStream.ts); a test
 * pins the two constants against each other.
 *
 * Ack: per chunk. The ack is the resolution of `streamChunk`, which main
 * answers after `stdin.write` reports drained. Nothing is acked in bulk, so
 * no frame is ever "sent" from the renderer's view before every byte of it is
 * in the encoder's pipe.
 *
 * Memory bound: the renderer holds at most `STREAM_MAX_QUEUED` (2) frames
 * waiting behind the one on the wire plus the one being read back — 3 frames,
 * 25 MB at 1080p, 100 MB at 4K — see `SequentialWriter` in videoSink.ts. Main
 * holds one chunk plus the OS pipe buffer (64 KB). Both are independent of
 * the comp's length and of how far behind the encoder falls.
 *
 * ── Bytes ───────────────────────────────────────────────────────────────────
 *
 * What is sent is exactly what `getImageData` returns through the shared 2D
 * scratch (`readCanvasPixels`): straight-alpha 8-bit sRGB RGBA, top-down,
 * no padding. That is the same readback the staged path's PNG encoder
 * consumes and, before its lossy step, the JPEG encoder too — so for every
 * format the two pipelines hand ffmpeg the same pixels; the staged JPEG path
 * merely lost a generation on the way. `rawPipeEquivalence.test.ts` holds the
 * two side by side.
 *
 * Pure: no DOM, no Electron — the bridge is an interface, so the protocol is
 * tested against a fake.
 */

/** Bytes per IPC message. See the module comment before changing it. */
export const RAW_PIPE_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * The encoder for an H.264/HEVC MP4. `libx264` is the software default;
 * the rest are opt-in hardware encoders, probed by main and falling back to
 * libx264 (with a warning on the result) when the machine cannot run them.
 */
export type VideoEncoderId = 'libx264' | 'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv' | 'h264_videotoolbox';

export const VIDEO_ENCODER_LABELS: Record<VideoEncoderId, string> = {
  libx264: 'Software (libx264)',
  h264_nvenc: 'NVIDIA NVENC (H.264)',
  hevc_nvenc: 'NVIDIA NVENC (HEVC)',
  h264_qsv: 'Intel Quick Sync (H.264)',
  h264_videotoolbox: 'Apple VideoToolbox (H.264)',
};

export function isVideoEncoderId(v: unknown): v is VideoEncoderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(VIDEO_ENCODER_LABELS, v);
}

/** The one bridge call the protocol needs. */
export interface RawPipeBridge {
  streamChunk(jobId: string, index: number, offset: number, bytes: Uint8Array, last: boolean): Promise<void>;
}

export interface FrameChunk {
  offset: number;
  /** A VIEW into the frame, never a copy — IPC makes the one copy that is needed. */
  bytes: Uint8Array;
  last: boolean;
}

/** Split a frame into consecutive views of at most `chunkBytes`. */
export function* frameChunks(frame: Uint8Array, chunkBytes = RAW_PIPE_CHUNK_BYTES): Generator<FrameChunk> {
  if (!(chunkBytes > 0)) throw new Error('chunk size must be positive');
  const total = frame.byteLength;
  if (total === 0) throw new Error('an empty frame cannot be streamed');
  for (let offset = 0; offset < total; offset += chunkBytes) {
    const end = Math.min(total, offset + chunkBytes);
    yield { offset, bytes: frame.subarray(offset, end), last: end === total };
  }
}

/**
 * Send one frame, chunk by chunk, awaiting the ack for each. Resolves once the
 * last chunk has been acked — i.e. once the whole frame is in the encoder's
 * pipe — with the number of chunks it took. Rejects on the first refused
 * chunk and sends nothing after it: a frame with a hole must not be followed
 * by frames that would land at the wrong offset.
 */
export async function streamFrameChunked(
  bridge: RawPipeBridge,
  jobId: string,
  index: number,
  frame: Uint8Array,
  chunkBytes = RAW_PIPE_CHUNK_BYTES,
): Promise<number> {
  let sent = 0;
  for (const chunk of frameChunks(frame, chunkBytes)) {
    await bridge.streamChunk(jobId, index, chunk.offset, chunk.bytes, chunk.last);
    sent += 1;
  }
  return sent;
}
