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

import { isPluginFormat, pluginExporterFor } from './pluginExporters';
import { openPluginExport } from './openPluginExport';
import { createHdrMasteringAccumulator } from './hdrTransfer';
import { FramePipeline, CanvasPool, defaultConcurrency } from './framePipeline';

/**
 * A format this module can encode.
 *
 * `plugin:<pluginId>.<exporterId>` is an output a PLUGIN writes — the host
 * renders and hands over frames, the plugin returns bytes. Widened here rather
 * than kept as a parallel type so every path that already carries a format (the
 * queue, the dialogs, the output templates) carries this one too, instead of
 * each growing its own "or a plugin format" branch.
 */
export type VideoFormat = 'mp4' | 'webm' | 'gif' | 'mov' | 'hdr10' | 'hlg' | `plugin:${string}`;

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
  /**
   * Context a PLUGIN exporter is told about the job before its first frame.
   *
   * Optional, and unread by every built-in sink: ffmpeg and WebCodecs learn the
   * duration from the frames they are handed. A plugin encoder may need it up
   * front — a container header often carries one — and asking after the fact
   * would mean buffering the whole export to answer.
   */
  durationSec?: number;
  compositionName?: string;
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
      /** Encoder used for HDR (libx265 when available, else libx264 high10). */
      videoCodec?: string;
      /** Measured MaxCLL / MaxFALL from the staged frames (HDR exports only). */
      hdrMastering?: {
        maxCll: number;
        maxFall: number;
        displayMaxNits: number;
        displayMinNits: number;
      };
      /** Ask the user where to put it. Null if they cancelled. */
      save(defaultName: string): Promise<string | null>;
      /** Drop it into an already-chosen folder without a dialog. */
      saveTo(dir: string, filename: string): Promise<string>;
      /** Discard the encoded file and its staging directory. */
      discard(): Promise<void>;
    }
  | {
      kind: 'blob';
      ext: string;
      frames: number;
      blob: Blob;
      videoCodec?: string;
      hdrMastering?: {
        maxCll: number;
        maxFall: number;
        displayMaxNits: number;
        displayMinNits: number;
      };
    };

export interface VideoSink {
  /** Encode one rendered frame. Called once per frame, in order. */
  addFrame(canvas: HTMLCanvasElement, index: number): Promise<void>;
  /** Finish the encode. Throws if no frames were added. */
  finish(): Promise<VideoSinkResult>;
  /** Release everything without producing a file (cancel / error paths). */
  dispose(): Promise<void>;
}

/**
 * A sink that hands frames to a plugin and takes bytes back.
 *
 * ── Frames are read on the HOST, per frame, and transferred ─────────────────
 *
 * `getImageData` on the export canvas, then the buffer is transferred to the
 * worker rather than copied — a 4K frame is 33 MB, and copying one per frame
 * would cost more than most encoders spend encoding it. The buffer is dead on
 * this side afterwards, which is fine: nothing reads it again.
 *
 * ── Serialised on purpose ───────────────────────────────────────────────────
 *
 * One frame in flight at a time. An encoder is a stateful pipeline fed in
 * order, so overlapping frames would mean an author has to handle
 * out-of-order arrival for no gain — the export loop is already sequential.
 */
class PluginSink implements VideoSink {
  private session: Awaited<ReturnType<typeof openPluginExport>> | null = null;
  private frames = 0;

  constructor(private readonly params: VideoSinkParams) {}

  private async ensureOpen(): Promise<NonNullable<PluginSink['session']>> {
    if (this.session) return this.session;
    const entry = pluginExporterFor(this.params.format);
    if (!entry) {
      throw new Error(
        `No installed plugin provides the format "${this.params.format}". `
        + 'It may have been uninstalled or disabled since this render was queued.',
      );
    }
    this.session = await openPluginExport(entry, {
      width: this.params.width,
      height: this.params.height,
      fps: this.params.fps,
      durationSec: this.params.durationSec ?? 0,
      compositionName: this.params.compositionName ?? '',
    });
    return this.session;
  }

  async addFrame(canvas: HTMLCanvasElement, index: number): Promise<void> {
    const session = await this.ensureOpen();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('The export canvas has no 2D context to read frames from.');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    await session.addFrame(index, canvas.width, canvas.height, data.data.buffer as ArrayBuffer);
    this.frames += 1;
  }

  async finish(): Promise<VideoSinkResult> {
    if (this.frames === 0) throw new Error('No frames were rendered — nothing to encode.');
    const session = await this.ensureOpen();
    const bytes = await session.finish();
    const entry = pluginExporterFor(this.params.format);
    this.session = null;
    return {
      kind: 'blob',
      ext: entry?.extension ?? 'bin',
      frames: this.frames,
      blob: new Blob([bytes], { type: 'application/octet-stream' }),
    } as VideoSinkResult;
  }

  async dispose(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) await session.dispose();
  }
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
  /** PNG staging preserves alpha; JPEG is smaller and faster for opaque output.
   *  HDR10/HLG always stage PNG so the PQ/HLG-baked signal survives. */
  private readonly frameExt: 'jpg' | 'png';
  private readonly hdrTransfer: 'pq' | 'hlg' | null;
  private readonly hdrStats = createHdrMasteringAccumulator(1000);
  /**
   * Multi-frame staging. `addFrame` snapshots the renderer's canvas into a
   * pooled one and returns; the encode + IPC write run in the background with
   * several in flight, so the GPU renders frame N+1 while frames N−k..N are
   * still being encoded. See framePipeline.ts. Staged files are named by
   * index, so completion order does not matter to ffmpeg.
   */
  private readonly pipeline = new FramePipeline();
  private pool: CanvasPool | null = null;

  constructor(params: VideoSinkParams) {
    this.params = params;
    this.hdrTransfer = params.format === 'hdr10' ? 'pq' : params.format === 'hlg' ? 'hlg' : null;
    this.frameExt = params.transparent || this.hdrTransfer ? 'png' : 'jpg';
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
    let frameCanvas = canvas;
    if (this.hdrTransfer) {
      // Measure MaxCLL/MaxFALL on display buffer (approx linear via undo-sRGB)
      // before baking the OETF into staging PNGs. Synchronous and on the
      // renderer's canvas, BEFORE the snapshot: the accumulator is ordered.
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        try {
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          this.hdrStats.accumulateLinearFrame(data, false);
        } catch { /* tainted canvas — skip stats */ }
      }
      const { canvasWithHdrTransfer } = await import('./hdrTransfer');
      frameCanvas = canvasWithHdrTransfer(canvas, this.hdrTransfer);
    }
    // Snapshot now, encode later: the renderer reuses its canvas for the next
    // frame the moment this returns, so the pixels must be copied out first.
    this.pool ??= new CanvasPool(frameCanvas.width, frameCanvas.height, defaultConcurrency() + 1);
    const pool = this.pool;
    const snap = pool.snapshot(frameCanvas);
    const ext = this.frameExt;
    const bridge = this.bridge();
    await this.pipeline.push(async () => {
      try {
        const bytes = ext === 'png'
          ? await canvasBytes(snap, 'image/png')
          : await canvasBytes(snap, 'image/jpeg', STAGE_JPEG_QUALITY);
        await bridge.stageFrame!(jobId, index, bytes, ext);
      } finally {
        pool.release(snap);
      }
    });
    this.frames++;
  }

  async finish(): Promise<VideoSinkResult> {
    if (this.frames === 0 || !this.jobId) {
      throw new Error('No frames were rendered — nothing to encode.');
    }
    // Every staged frame must be on disk before ffmpeg reads the sequence —
    // and a frame that failed to stage must fail the export here, not leave
    // a gap ffmpeg would silently stop at.
    await this.pipeline.drain();
    const r = this.bridge();
    const jobId = this.jobId;
    /*
      A plugin format cannot reach ffmpeg: `createVideoSink` routes it to
      `PluginSink` before this sink is ever constructed. Asserted rather than
      cast away, because the day that routing changes the failure would
      otherwise be an MP4 written under a plugin's extension — a file whose
      contents its name does not predict, which is the exact thing
      `exporterSchema`'s reserved-extension list exists to prevent.
    */
    if (isPluginFormat(this.params.format)) {
      throw new Error(`"${this.params.format}" is a plugin format and cannot be encoded by ffmpeg.`);
    }
    // Container is always mp4 for HDR presets; codec/tags differ inside ffmpeg.
    const encodeFormat = this.params.format === 'hdr10' || this.params.format === 'hlg'
      ? 'mp4'
      : this.params.format;
    const mastering = this.hdrTransfer ? this.hdrStats.finish() : undefined;
    const { frames, videoCodec } = await r.encode!(jobId, {
      format: encodeFormat,
      fps: this.params.fps,
      hasAudio: !!this.params.audioWav,
      quality: this.params.quality ?? 'high',
      ...(this.hdrTransfer ? { hdr: this.hdrTransfer, hdrMastering: mastering } : {}),
    });
    // The staging dir (and the encoded file in it) outlives finish — the caller
    // still has to place the output. Whoever consumes the result is responsible
    // for save/saveTo/discard, each of which cleans the job up.
    const cleanup = async (): Promise<void> => {
      this.jobId = null;
      await r.cleanJob?.(jobId).catch(() => undefined);
    };

    const ext = encodeFormat;
    return {
      kind: 'file',
      ext,
      frames,
      ...(videoCodec ? { videoCodec } : {}),
      ...(mastering ? { hdrMastering: mastering } : {}),
      save: async (defaultName: string) => {
        const saved = await r.save?.(jobId, defaultName);
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
    // Let in-flight writes land before the directory is deleted under them.
    await this.pipeline.close();
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
  // Checked FIRST, and unconditionally: a plugin format is not something the
  // ffmpeg sink could fall back to encoding, so reaching that branch would
  // silently produce an MP4 under the plugin's extension.
  if (isPluginFormat(params.format)) return new PluginSink(params);
  if (canEncodeLocally()) return new FfmpegSink(params);
  // Only WebM is reachable in a browser: MP4/MOV need codecs and containers no
  // browser will mux, and GIF has its own dedicated encoder (gifEncoder.ts).
  if (params.format === 'webm' && canEncodeWithWebCodecs()) return new WebCodecsSink(params);
  return null;
}
