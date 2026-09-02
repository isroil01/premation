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
import { formatFfmetadata, formatCarriesChapters, type ExportChapter } from './chapters';

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

/**
 * ProRes flavour for `.mov` — the same family AE's output modules offer.
 * 4444 is the only one that carries alpha; the 422 tiers trade quality for
 * file size (HQ ≈ mastering, 422 ≈ edit, LT/Proxy ≈ offline).
 */
export type ProresProfile = 'proxy' | 'lt' | '422' | 'hq' | '4444';

export const PRORES_PROFILE_LABELS: Record<ProresProfile, string> = {
  '4444': 'ProRes 4444 (alpha)',
  hq: 'ProRes 422 HQ',
  '422': 'ProRes 422',
  lt: 'ProRes 422 LT',
  proxy: 'ProRes 422 Proxy',
};

export interface VideoSinkParams {
  format: VideoFormat;
  width: number;
  height: number;
  fps: number;
  quality?: ExportQuality;
  /** mov only — which ProRes flavour ffmpeg encodes. Defaults to 4444. */
  proresProfile?: ProresProfile;
  /** Keep an alpha channel (forces lossless frame staging). */
  transparent?: boolean;
  /**
   * Chapter marks for the delivered file, already derived from the comp's
   * markers (`chaptersFromMarkers`).
   *
   * Only the ffmpeg sink can honour these, and only for a container that
   * carries chapters — MP4 and MOV, which includes the HDR presets since they
   * mux into MP4. Handed to a WebM or GIF export they are ignored rather than
   * rejected: the caller has already been told which formats carry them, and
   * failing an otherwise-fine export over metadata nobody can see would be the
   * wrong trade. See `formatCarriesChapters`.
   */
  chapters?: ReadonlyArray<ExportChapter>;
  /** Mixed comp audio as WAV bytes, or undefined for a silent export. */
  audioWav?: Uint8Array;
  /** Cooperative cancellation reaching INTO the encode phase — without it the
   *  Cancel button was inert for the entire ffmpeg run, which on a long comp
   *  is most of the export's wall clock. */
  signal?: AbortSignal;
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
      /**
       * Drop it into an already-chosen folder without a dialog.
       *
       * `overwrite` is what separates a queue from a CLI. The queue never
       * overwrites — a clashing name becomes " (2)", because silently replacing
       * someone's previous render is not recoverable. A CLI told exactly where
       * to write must land THERE: a build whose artifact appears at
       * `out (7).mp4` on the seventh run has no artifact path at all.
       */
      saveTo(dir: string, filename: string, overwrite?: boolean): Promise<string>;
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

/**
 * Optional float-linear readback of the frame just rendered, offered alongside
 * the 8-bit canvas. The HDR sink prefers it: PQ baked from float linear
 * quantises once, on the perceptually-uniform side, where the canvas path
 * quantises through display sRGB first and bands in the shadows.
 */
export interface LinearFrameSource {
  readLinearRgba?(): Float32Array | null;
  readLinearRgbaAsync?(): Promise<Float32Array | null>;
}

export interface VideoSink {
  /** Encode one rendered frame. Called once per frame, in order. */
  addFrame(canvas: HTMLCanvasElement, index: number, source?: LinearFrameSource): Promise<void>;
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
    // Via the 2D scratch: the export canvas is GPU-owned, and getContext('2d')
    // on it returns null — this threw on the FIRST frame of every plugin
    // export before anything reached the plugin at all.
    const ctx = readableContext(canvas);
    if (!ctx) throw new Error('The export frame could not be read (no 2D context available).');
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

/**
 * A 2D-readable copy of a frame canvas.
 *
 * The offline renderer's canvas belongs to a GPU context, and a canvas that
 * has ever vended WebGL/WebGPU returns NULL from `getContext('2d')` — a fact
 * this codebase has re-discovered per call site (the GIF path and the preview
 * both note it). The plugin sink and the HDR stats reader both read pixels,
 * so they draw into this reused scratch canvas first.
 */
let readScratch: HTMLCanvasElement | null = null;

function readableContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  readScratch ??= document.createElement('canvas');
  if (readScratch.width !== canvas.width) readScratch.width = canvas.width;
  if (readScratch.height !== canvas.height) readScratch.height = canvas.height;
  const ctx = readScratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(canvas, 0, 0);
  return ctx;
}

/**
 * RGBA pixels of a frame canvas.
 *
 * Exported because the comment above is right that this gets re-discovered per
 * call site: the GIF path, the HDR stats reader, the plugin sink and now
 * auto-reframe all need to read pixels out of a GPU-backed canvas, and each one
 * that rolls its own scratch canvas is another full-frame allocation per frame.
 * One scratch, one place that knows why it exists.
 */
export function readCanvasPixels(canvas: HTMLCanvasElement): ImageData | null {
  const ctx = readableContext(canvas);
  return ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
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
    // MOV always stages PNG: the preset promises "lossless" ProRes 4444, and
    // an opaque comp used to stage through JPEG 0.95 — paying 4444's file
    // size for JPEG-degraded, chroma-subsampled pixels.
    this.frameExt = params.transparent || this.hdrTransfer || params.format === 'mov' ? 'png' : 'jpg';
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

  async addFrame(canvas: HTMLCanvasElement, index: number, source?: LinearFrameSource): Promise<void> {
    const jobId = await this.ensureJob();
    let frameCanvas = canvas;
    if (this.hdrTransfer) {
      // Prefer the FLOAT linear readback: PQ/HLG baked from real linear light
      // quantises once. The 8-bit canvas fallback reconstructs linear from
      // display sRGB bytes, which is where HDR10 exports banded in shadows.
      const linear =
        (await source?.readLinearRgbaAsync?.().catch(() => null))
        ?? source?.readLinearRgba?.()
        ?? null;
      const exactLinear = linear && linear.length === canvas.width * canvas.height * 4 ? linear : null;
      if (exactLinear) {
        this.hdrStats.accumulateLinearFrame(exactLinear, true);
        const { hdrCanvasFromLinearRgba } = await import('./hdrTransfer');
        const baked = hdrCanvasFromLinearRgba(exactLinear, canvas.width, canvas.height, this.hdrTransfer);
        if (baked) frameCanvas = baked;
      }
      if (frameCanvas === canvas) {
        // Measure MaxCLL/MaxFALL BEFORE baking the OETF into staging PNGs.
        // Read through the 2D scratch: getContext('2d') on the GPU-owned render
        // canvas returns null, which silently skipped the stats — every HDR10
        // file shipped fabricated max-cll=1,1 mastering metadata that display
        // tone-mappers actually read.
        const ctx = readableContext(canvas);
        if (ctx) {
          try {
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            this.hdrStats.accumulateLinearFrame(data, false);
          } catch { /* tainted canvas — skip stats */ }
        }
        const { canvasWithHdrTransfer } = await import('./hdrTransfer');
        frameCanvas = canvasWithHdrTransfer(canvas, this.hdrTransfer);
      }
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
    /*
      Chapters cross the IPC boundary as FFMETADATA1 TEXT, not as a chapter
      array. The main process has no access to `src/` (it is a separate tsconfig
      and a separate bundle), so formatting there would mean a second copy of
      the escaping rules — the half of this feature most likely to be wrong and
      least likely to be noticed. One tested formatter, and main.ts only has to
      write bytes to a file and name it on the command line.

      Empty string when the format cannot carry chapters or none were derived;
      main.ts treats that as "add no metadata input".
    */
    const chapterMetadata = formatCarriesChapters(this.params.format)
      ? formatFfmetadata(this.params.chapters ?? [])
      : '';
    // Encode-phase cancellation. The frame loop polls the signal itself, but
    // the ffmpeg child is where a long export spends most of its wall clock —
    // and without this the Cancel button was inert for that entire phase,
    // stuck at 95% with a running child process.
    const signal = this.params.signal;
    if (signal?.aborted) {
      await this.dispose();
      throw new DOMException('Export cancelled', 'AbortError');
    }
    const onAbort = (): void => {
      void r.cancel?.(jobId).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let encoded: { frames: number; videoCodec?: string };
    try {
      encoded = await r.encode!(jobId, {
        format: encodeFormat,
        fps: this.params.fps,
        hasAudio: !!this.params.audioWav,
        quality: this.params.quality ?? 'high',
        ...(encodeFormat === 'mov' && this.params.proresProfile
          ? { proresProfile: this.params.proresProfile }
          : {}),
        ...(this.hdrTransfer ? { hdr: this.hdrTransfer, hdrMastering: mastering } : {}),
        ...(chapterMetadata ? { chaptersFfmetadata: chapterMetadata } : {}),
      });
    } catch (err) {
      // A killed child exits non-zero and rejects with an ffmpeg error — when
      // WE killed it, surface the cancellation, not "ffmpeg exited null".
      if (signal?.aborted) {
        await r.cleanJob?.(jobId).catch(() => undefined);
        this.jobId = null;
        throw new DOMException('Export cancelled', 'AbortError');
      }
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    const { frames, videoCodec } = encoded;
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
        // A cancelled save dialog must NOT clean up: cleanup deletes the
        // staging dir INCLUDING the finished encode, so dismissing the dialog
        // by reflex destroyed a completed multi-minute render with no way to
        // retry. Keep it; discard()/dispose() still reclaims it later.
        if (saved) await cleanup();
        return saved?.path ?? null;
      },
      saveTo: async (dir: string, filename: string, overwrite?: boolean) => {
        const saved = await r.saveTo?.(jobId, dir, filename, overwrite);
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

import { muxWebm, type WebmAudioTrack, type WebmSample, type WebmVideoCodec } from './webmMuxer';

/** PCM pulled out of the mixdown's WAV container. */
interface WavPcm {
  sampleRate: number;
  channels: number;
  /** Interleaved signed 16-bit samples. */
  data: Int16Array;
}

/** Minimal RIFF/WAVE reader for the mixdown's own output (48kHz s16 stereo).
 *  Walks chunks rather than assuming a 44-byte header, so an extra LIST/fact
 *  chunk cannot break it. Returns null for anything it does not understand. */
function parseWav(bytes: Uint8Array): WavPcm | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44) return null;
  if (view.getUint32(0, false) !== 0x52494646 /* RIFF */) return null;
  if (view.getUint32(8, false) !== 0x57415645 /* WAVE */) return null;
  let pos = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let data: Int16Array | null = null;
  while (pos + 8 <= bytes.length) {
    const id = view.getUint32(pos, false);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 0x666d7420 /* fmt  */ && size >= 16) {
      const format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format !== 1 /* PCM */) return null;
    } else if (id === 0x64617461 /* data */) {
      const len = Math.min(size, bytes.length - body);
      data = new Int16Array(bytes.buffer, bytes.byteOffset + body, Math.floor(len / 2));
    }
    pos = body + size + (size % 2);
  }
  if (!data || !sampleRate || !channels || bits !== 16) return null;
  return { sampleRate, channels, data };
}

/** Opus frames per AudioData chunk — 20ms at 48kHz, Opus' native frame size. */
const OPUS_CHUNK_FRAMES = 960;

/**
 * Encode the mixdown WAV to Opus for the WebM muxer.
 *
 * The muxer has carried a complete Opus audio-track implementation since it
 * was written — and nothing ever fed it: the mixdown was computed, passed in,
 * and dropped on the floor, so every browser export was SILENT with a green
 * success toast. Returns null when this browser has no AudioEncoder or the
 * encode fails — a silent file then ships exactly as before, never a failed
 * export.
 */
async function encodeOpusAudio(
  wav: Uint8Array,
): Promise<{ track: WebmAudioTrack; samples: WebmSample[] } | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  const pcm = parseWav(wav);
  if (!pcm) return null;
  try {
    const samples: WebmSample[] = [];
    let description: Uint8Array | null = null;
    let failure: Error | null = null;
    const encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        const d = metadata?.decoderConfig?.description;
        if (d && !description) {
          description = ArrayBuffer.isView(d)
            ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer)
            : new Uint8Array((d as ArrayBuffer).slice(0));
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ timestampUs: chunk.timestamp, keyFrame: true, data });
      },
      error: (err) => {
        failure = err instanceof Error ? err : new Error(String(err));
      },
    });
    encoder.configure({
      codec: 'opus',
      sampleRate: pcm.sampleRate,
      numberOfChannels: pcm.channels,
      bitrate: 160_000,
    });
    const totalFrames = Math.floor(pcm.data.length / pcm.channels);
    for (let frame = 0; frame < totalFrames; frame += OPUS_CHUNK_FRAMES) {
      const count = Math.min(OPUS_CHUNK_FRAMES, totalFrames - frame);
      // slice(), not subarray(): AudioData wants a view over a plain
      // ArrayBuffer, and the WAV view may sit on a shared/offset buffer.
      const slice = pcm.data.slice(frame * pcm.channels, (frame + count) * pcm.channels);
      const audio = new AudioData({
        format: 's16',
        sampleRate: pcm.sampleRate,
        numberOfFrames: count,
        numberOfChannels: pcm.channels,
        timestamp: Math.round((frame * 1e6) / pcm.sampleRate),
        data: slice,
      });
      encoder.encode(audio);
      audio.close();
    }
    await encoder.flush();
    encoder.close();
    if (failure || !description || samples.length === 0) return null;
    return {
      track: { sampleRate: pcm.sampleRate, channels: pcm.channels, description },
      samples,
    };
  } catch {
    return null;
  }
}

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
    // export balloons memory until the tab is killed. Re-checked AFTER the
    // listener registers: the encoder drains on its own thread, and a queue
    // that emptied between the size check and addEventListener would never
    // fire another `dequeue` — the export hung forever with Cancel inert.
    if (encoder.encodeQueueSize > 8) {
      await new Promise<void>((resolve) => {
        const onDequeue = (): void => {
          encoder.removeEventListener('dequeue', onDequeue);
          resolve();
        };
        encoder.addEventListener('dequeue', onDequeue);
        if (encoder.encodeQueueSize <= 8) onDequeue();
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

    // Audio: the mixdown was always computed and handed in — and dropped.
    // Encode it to Opus and give the muxer the track it has supported all
    // along. A failed audio encode falls back to a silent file, never a
    // failed export.
    const audio = this.params.audioWav ? await encodeOpusAudio(this.params.audioWav) : null;

    const bytes = muxWebm(
      {
        codec: this.codec,
        width: this.params.width,
        height: this.params.height,
        fps: this.params.fps,
        ...(this.description ? { description: this.description } : {}),
      },
      this.samples,
      audio ?? undefined,
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
