/**
 * Video sinks — where a rendered frame goes on its way to becoming a file.
 *
 * The deterministic renderer (offlineRenderer) hands one canvas per frame to a
 * sink; the sink encodes it. There are two implementations, picked by
 * environment, and neither accumulates the whole render in memory:
 *
 *  - `FfmpegSink` (desktop / Electron) — writes each frame to a temp dir through
 *    the preload bridge and lets ffmpeg encode it in a CHILD PROCESS. This is the
 *    path that keeps the app responsive during an export and the only one that
 *    can produce H.264 MP4, ProRes, and properly palettised GIF.
 *
 *  - `WebCodecsSink` (browser) — `VideoEncoder` straight from the canvas, muxed
 *    to WebM by webmMuxer. Deterministic and fast, but limited to what the
 *    browser will encode (VP9/VP8/AV1 in WebM).
 *
 * What both replaced: `MediaRecorder` on a `captureStream` canvas. That path
 * paced the render at wall-clock speed (a 60-second comp took 60 seconds of
 * `sleep`), could not report how many frames it had captured, and when it
 * captured none — which happens routinely for an off-screen canvas — it still
 * resolved successfully with a header-only file. Users got a black video and a
 * green "Export complete" toast. Every sink here reports a real frame count and
 * refuses to finish with zero.
 */

export type VideoFormat = 'mp4' | 'webm' | 'gif' | 'mov';

export type ExportQuality = 'high' | 'medium' | 'draft';

export interface VideoSinkParams {
  format: VideoFormat;
  width: number;
  height: number;
  fps: number;
  quality?: ExportQuality;
  /** Keep an alpha channel (forces lossless frame staging). */
  transparent?: boolean;
  /** Mixed comp audio as WAV bytes, or undefined for a silent export. */
  audioWav?: Uint8Array;
}

/**
 * A finished encode. `file` means the bytes are already on disk and must NOT be
 * read into the renderer — call `save` to let the user place them. `blob` is
 * the browser path, where an in-memory blob is all there is.
 */
export type VideoSinkResult =
  | {
      kind: 'file';
      ext: string;
      frames: number;
      /** Ask the user where to put it. Null if they cancelled. */
      save(defaultName: string): Promise<string | null>;
      /** Drop it into an already-chosen folder without a dialog. */
      saveTo(dir: string, filename: string): Promise<string>;
      /** Discard the encoded file and its staging directory. */
      discard(): Promise<void>;
    }
  | { kind: 'blob'; ext: string; frames: number; blob: Blob };

export interface VideoSink {
  /** Encode one rendered frame. Called once per frame, in order. */
  addFrame(canvas: HTMLCanvasElement, index: number): Promise<void>;
  /** Finish the encode. Throws if no frames were added. */
  finish(): Promise<VideoSinkResult>;
  /** Release everything without producing a file (cancel / error paths). */
  dispose(): Promise<void>;
}

/** True when the desktop shell can encode video locally with ffmpeg. */
export function canEncodeLocally(): boolean {
  const r = typeof window !== 'undefined' ? window.motionEditor?.render : undefined;
  return !!(r?.beginJob && r.stageFrame && r.encode);
}

/** Encode a canvas to image bytes. Shared by the sinks and the sequence export. */
export async function canvasBytes(
  canvas: HTMLCanvasElement,
  type: 'image/jpeg' | 'image/png',
  quality?: number,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
  if (!blob) throw new Error('Frame could not be encoded (canvas.toBlob returned null).');
  return new Uint8Array(await blob.arrayBuffer());
}

// ── Desktop: stage frames to disk, encode with ffmpeg ─────────────────

/** JPEG quality for staged frames. High enough that the visible loss is the
 *  video codec's, not the intermediate. */
const STAGE_JPEG_QUALITY = 0.95;

class FfmpegSink implements VideoSink {
  private jobId: string | null = null;
  private frames = 0;
  private readonly params: VideoSinkParams;
  /** PNG staging preserves alpha; JPEG is smaller and faster for opaque output. */
  private readonly frameExt: 'jpg' | 'png';

  constructor(params: VideoSinkParams) {
    this.params = params;
    this.frameExt = params.transparent ? 'png' : 'jpg';
  }

  private bridge(): NonNullable<NonNullable<Window['motionEditor']>['render']> {
    const r = window.motionEditor?.render;
    if (!r) throw new Error('Local encoding is not available in this build.');
    return r;
  }

  private async ensureJob(): Promise<string> {
    if (this.jobId) return this.jobId;
    const r = this.bridge();
    this.jobId = await r.beginJob!();
    if (this.params.audioWav && r.stageAudio) {
      await r.stageAudio(this.jobId, this.params.audioWav);
    }
    return this.jobId;
  }

  async addFrame(canvas: HTMLCanvasElement, index: number): Promise<void> {
    const jobId = await this.ensureJob();
    const bytes =
      this.frameExt === 'png'
        ? await canvasBytes(canvas, 'image/png')
        : await canvasBytes(canvas, 'image/jpeg', STAGE_JPEG_QUALITY);
    await this.bridge().stageFrame!(jobId, index, bytes, this.frameExt);
    this.frames++;
  }

  async finish(): Promise<VideoSinkResult> {
    if (this.frames === 0 || !this.jobId) {
      throw new Error('No frames were rendered — nothing to encode.');
    }
    const r = this.bridge();
    const jobId = this.jobId;
    const { frames } = await r.encode!(jobId, {
      format: this.params.format,
      fps: this.params.fps,
      hasAudio: !!this.params.audioWav,
      quality: this.params.quality ?? 'high',
    });
    // The staging dir (and the encoded file in it) outlives finish — the caller
    // still has to place the output. Whoever consumes the result is responsible
    // for save/saveTo/discard, each of which cleans the job up.
    const cleanup = async (): Promise<void> => {
      this.jobId = null;
      await r.cleanJob?.(jobId).catch(() => undefined);
    };

    return {
      kind: 'file',
      ext: this.params.format,
      frames,
      save: async (defaultName: string) => {
        const saved = await r.save?.(jobId, defaultName);
        // A cancelled dialog leaves the file staged so nothing is lost silently;
        // it is only cleaned once the outcome is settled either way.
        await cleanup();
        return saved?.path ?? null;
      },
      saveTo: async (dir: string, filename: string) => {
        const saved = await r.saveTo?.(jobId, dir, filename);
        await cleanup();
        if (!saved) throw new Error('This build cannot save into a folder directly.');
        return saved.path;
      },
      discard: cleanup,
    };
  }

  async dispose(): Promise<void> {
    const jobId = this.jobId;
    this.jobId = null;
    if (!jobId) return;
    const r = window.motionEditor?.render;
    await r?.cancel?.(jobId).catch(() => undefined);
    await r?.cleanJob?.(jobId).catch(() => undefined);
  }
}

// ── Browser: WebCodecs → WebM ────────────────────────────────────────

import { muxWebm, type WebmSample, type WebmVideoCodec } from './webmMuxer';

/** Bits per second for a given frame size and quality tier. Roughly matches
 *  what a well-tuned VP9 encode needs — 0.1 bits per pixel per frame at high. */
function targetBitrate(width: number, height: number, fps: number, quality: ExportQuality): number {
  const bitsPerPixel = quality === 'draft' ? 0.04 : quality === 'medium' ? 0.07 : 0.12;
  return Math.round(width * height * fps * bitsPerPixel);
}

/** How often a keyframe is forced. Two seconds keeps seeking responsive without
 *  inflating the file. */
const KEYFRAME_INTERVAL_SEC = 2;

class WebCodecsSink implements VideoSink {
  private encoder: VideoEncoder | null = null;
  private readonly samples: WebmSample[] = [];
  private description: Uint8Array | undefined;
  private error: Error | null = null;
  private frames = 0;
  private readonly params: VideoSinkParams;
  private readonly codec: WebmVideoCodec = 'vp9';

  constructor(params: VideoSinkParams) {
    this.params = params;
  }

  private ensureEncoder(): VideoEncoder {
    if (this.encoder) return this.encoder;
    const { width, height, fps, quality } = this.params;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        // CodecPrivate for the muxer. `description` is either a raw buffer or a
        // view onto one; both are copied so the encoder can reuse its memory.
        const d = metadata?.decoderConfig?.description;
        if (d) {
          this.description = ArrayBuffer.isView(d)
            ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer)
            : new Uint8Array(d.slice(0) as ArrayBuffer);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.samples.push({ timestampUs: chunk.timestamp, keyFrame: chunk.type === 'key', data });
      },
      error: (err) => {
        this.error = err instanceof Error ? err : new Error(String(err));
      },
    });
    encoder.configure({
      codec: 'vp09.00.10.08',
      width,
      height,
      bitrate: targetBitrate(width, height, fps, quality ?? 'high'),
      framerate: fps,
      latencyMode: 'quality',
    });
    this.encoder = encoder;
    return encoder;
  }

  async addFrame(canvas: HTMLCanvasElement, index: number): Promise<void> {
    if (this.error) throw this.error;
    const encoder = this.ensureEncoder();
    const { fps } = this.params;
    const frame = new VideoFrame(canvas, {
      // Timestamps come from the frame INDEX, never the clock — that is what
      // makes the output reproducible.
      timestamp: Math.round((index * 1e6) / fps),
      duration: Math.round(1e6 / fps),
    });
    try {
      encoder.encode(frame, { keyFrame: index % Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SEC)) === 0 });
    } finally {
      frame.close();
    }
    this.frames++;
    // Back-pressure: without this the encoder queue grows unbounded and a long
    // export balloons memory until the tab is killed.
    if (encoder.encodeQueueSize > 8) {
      await new Promise<void>((resolve) => {
        encoder.addEventListener('dequeue', () => resolve(), { once: true });
      });
    }
  }

  async finish(): Promise<VideoSinkResult> {
    if (this.error) throw this.error;
    if (!this.encoder || this.frames === 0) {
      throw new Error('No frames were rendered — nothing to encode.');
    }
    await this.encoder.flush();
    this.encoder.close();
    this.encoder = null;
    if (this.error) throw this.error;

    const bytes = muxWebm(
      {
        codec: this.codec,
        width: this.params.width,
        height: this.params.height,
        fps: this.params.fps,
        ...(this.description ? { description: this.description } : {}),
      },
      this.samples,
    );
    return {
      kind: 'blob',
      ext: 'webm',
      frames: this.frames,
      blob: new Blob([bytes as BlobPart], { type: 'video/webm' }),
    };
  }

  async dispose(): Promise<void> {
    try {
      this.encoder?.close();
    } catch {
      /* already closed */
    }
    this.encoder = null;
    this.samples.length = 0;
  }
}

/** True when this browser can encode video with WebCodecs. */
function canEncodeWithWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/**
 * The sink that can actually produce `params.format` here, or null when nothing
 * can. Callers must handle null with a clear message rather than falling back to
 * something that writes a different format under the requested extension.
 */
export function createVideoSink(params: VideoSinkParams): VideoSink | null {
  if (canEncodeLocally()) return new FfmpegSink(params);
  // Only WebM is reachable in a browser: MP4/MOV need codecs and containers no
  // browser will mux, and GIF has its own dedicated encoder (gifEncoder.ts).
  if (params.format === 'webm' && canEncodeWithWebCodecs()) return new WebCodecsSink(params);
  return null;
}
