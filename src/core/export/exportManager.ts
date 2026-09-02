/**
 * Export pipeline — renders the current composition to real files.
 *
 * Every format shares one deterministic frame loop (offlineRenderer: frame time
 * is exactly `index / fps`, never wall-clock), so an export is reproducible and
 * matches the viewport. What differs is where the frames go:
 *
 *  - MP4 / WebM / MOV / GIF — a {@link VideoSink}: ffmpeg in a child process on
 *    the desktop, WebCodecs in the browser. See videoSink.ts.
 *  - PNG / JPEG sequence — image bytes packed into a zip by a worker.
 *  - PNG — one frame, snapped to the frame grid.
 *  - Lottie — the scene's shapes and transform tracks as bodymovin JSON.
 *  - JSON — the editable project document, re-openable with File ▸ Open.
 */

import { createRenderBackend } from '@core/rendering/createRenderBackend';
import type { RenderBackend } from '@core/rendering/RenderBackend';
import { buildSnapshot, COMP_WIDTH, COMP_HEIGHT, type SnapshotComp } from '@core/rendering/buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, pointsToLottieBezier } from '@motion/animation';
import { shapeOutline } from '@core/scene/pathOps';
import { captureDocument } from '@core/api/cloudDocument';
import { getTimelineController } from '@core/timeline/TimelineController';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { compRootOf } from '@core/scene/parenting';
import type { SceneNode } from '@core/types';
import { renderOffline, renderStillFrame, exportView, exportComp, resolveRange, type OfflineRenderParams } from './offlineRenderer';
import { FramePipeline, CanvasPool, defaultConcurrency } from './framePipeline';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { type ZipEntry } from './zip';
import { encodeGifBytes, encodeZipBytes } from './encodeClient';
import { mixdownAudio } from '@core/audio/audioMixdown';
import { type GifFrame } from './gifEncoder';
import {
  canEncodeLocally,
  canvasBytes,
  createVideoSink,
  type ExportQuality,
  type ProresProfile,
  type VideoFormat,
  type VideoSinkResult,
} from './videoSink';
import { isPluginFormat, pluginExporters } from './pluginExporters';
import type { ExportChapter } from './chapters';

import { useUIStore } from '@stores/uiStore';
import { exportEdlText } from './exportEdl';
import { exportOtioText } from './exportOtio';
import { exportFcpxmlText } from './exportFcpxml';
import { exportAleText } from './exportAle';
import { exportMogrtZip } from './exportMogrt';
import { encodeExr } from '@core/media/exr';

export type ExportFormat =
  | VideoFormat
  | 'png'
  | 'png-sequence'
  | 'jpg-sequence'
  | 'exr-sequence'
  | 'wav'
  | 'json'
  | 'lottie'
  | 'edl'
  | 'otio'
  | 'fcpxml'
  | 'ale'
  | 'mogrt';

export interface ExportOptions {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Current playhead time (for the single-frame PNG). */
  time: number;
  /** Comp size + background (defaults to 1920×1080 near-black when omitted).
   *  `transparent` yields real alpha in PNG, WebM and MOV output. */
  comp?: SnapshotComp;
  /** Encoder quality tier. Draft trades visible quality for speed. */
  quality?: ExportQuality;
  /** mov only — which ProRes flavour to encode. Defaults to 4444 (alpha). */
  proresProfile?: ProresProfile;
  /**
   * Chapter marks for the delivered file, derived from the composition's
   * markers by `chaptersFromMarkers`.
   *
   * Passed in already-resolved rather than read from the timeline here for the
   * same reason `range` is: an export must deliver what was asked for at the
   * moment it was asked for, and a queued job that re-read the live marker list
   * at render time would ship chapters the user never saw. Absent — which is
   * what every non-dialog caller, the render queue and the headless CLI
   * included, leaves it — means no chapters and no extra ffmpeg input.
   */
  chapters?: ReadonlyArray<ExportChapter>;
  /**
   * When false, ignore the timeline work area and export the whole composition.
   * Default (undefined/true) keeps the existing behaviour: a set work area is
   * the export range.
   */
  useWorkArea?: boolean;
  /**
   * EXPLICIT export range in seconds (end exclusive) — wins over the live work
   * area. Queued render jobs capture their range at QUEUE time and pass it
   * here: without this, every queued job read `getWorkArea()` at RUN time — a
   * live, global value — so queueing comp A, then editing comp B's work area,
   * rendered comp A's picture over comp B's frame range.
   */
  range?: { startSec: number; endSec: number };
  /**
   * Base filename (no extension) for the delivered file. The dialog's footer
   * has always displayed one — and nothing downstream ever read it: the save
   * dialog offered `motion-export-<timestamp>` regardless.
   */
  baseName?: string;
  onProgress?: (fraction: number) => void;
  /** Cooperative cancellation for the whole export (frame loop and encoder).
   *  Aborting rejects with a DOMException 'AbortError'. */
  signal?: AbortSignal;
}

/** True when an error is the cooperative-cancel rejection. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Viewport motion-blur settings, threaded into export so it matches preview. */
function exportMotionBlur(fps: number): import('@core/effects/motionBlur').MotionBlurConfig | undefined {
  const mb = useMotionBlurStore.getState();
  return mb.enabled ? { enabled: true, shutterAngle: mb.shutterAngle, shutterPhase: mb.shutterPhase, samples: mb.samples, adaptiveSampleLimit: mb.adaptiveSampleLimit, fps } : undefined;
}

/** Longest edge of a project poster frame. Big enough for a retina card. */
const THUMBNAIL_MAX_EDGE = 480;

/**
 * Render one frame as a small JPEG, for a project's poster frame.
 *
 * Same renderer the viewport and every export use, so a card shows what the
 * project actually looks like rather than a generic icon. Scaled down here
 * rather than uploaded full-size: a 4K poster costs the user a slow list for
 * no visible gain.
 *
 * Returns null when there is nothing to draw — the caller must not upload a
 * blank frame and call it a preview.
 */
export async function renderThumbnailBlob(
  comp: SnapshotComp & { width: number; height: number },
  time = 0,
): Promise<Blob | null> {
  const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(comp.width, comp.height));
  const width = Math.max(1, Math.round(comp.width * scale));
  const height = Math.max(1, Math.round(comp.height * scale));

  const { canvas, backend } = makeCanvas(width, height);
  try {
    if (backend.readyPromise) await backend.readyPromise;
    backend.renderFrame(
      buildSnapshot(
        defaultSceneGraph,
        defaultAnimation,
        time,
        undefined,
        undefined,
        exportView(width, height, comp),
        undefined, // no motion blur on a still
        // A poster frame is never transparent: it sits on a card, and a
        // transparent JPEG is just a black one.
        exportComp({ ...comp, transparent: false }),
      ),
    );
    return await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.72));
  } catch {
    return null;
  } finally {
    backend.dispose();
  }
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  download(blob, filename);
}
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 10 minutes, not 4 seconds: revoking mid-write aborts the save of a large
  // blob (multi-hundred-MB sequence zips on slow disks) in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; backend: RenderBackend } {
  const canvas = document.createElement('canvas');
  const backend = createRenderBackend('auto', 'auxiliary');
  backend.attach(canvas);
  backend.resize(w, h, 1);
  return { canvas, backend };
}

function activeWorkArea(opts: ExportOptions): { start: number; end: number } | null {
  if (opts.range) return { start: opts.range.startSec, end: opts.range.endSec };
  if (opts.useWorkArea === false) return null;
  return getTimelineController().getWorkArea();
}

function offlineParams(opts: ExportOptions): OfflineRenderParams {
  const wa = activeWorkArea(opts);
  return {
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    durationSec: opts.duration,
    comp: opts.comp,
    motionBlur: exportMotionBlur(opts.fps),
    // getWorkArea's end is EXCLUSIVE (start + duration); resolveRange's is
    // INCLUSIVE. Passing it straight through rendered one extra frame from
    // OUTSIDE the work area on every partial-range export — and since the
    // audio mixdown used the correct length, ffmpeg's `-shortest` then
    // trimmed the picture back only when the comp had sound: same project,
    // two different durations depending on a mute layer.
    ...(wa
      ? {
          startFrame: Math.round(wa.start * opts.fps),
          endFrame: Math.max(Math.round(wa.start * opts.fps), Math.round(wa.end * opts.fps) - 1),
        }
      : {}),
  };
}

/**
 * Zero-padding width for frame filenames. THIS IS A SHARED CONTRACT: both the
 * desktop shell (electron/main.ts) and motion-back's render worker glob
 * `frame_%04d.jpg`, so this must stay 4.
 *
 * It used to be `String(total).length`, which produced `frame_000.jpg` for any
 * render under 1000 frames — ffmpeg then matched nothing and every MP4 export
 * under ~33s failed, reported as "backend offline". Frames past 9999 are fine:
 * `%04d` is a MINIMUM width, so ffmpeg still matches `frame_10000.jpg`.
 *
 * @see motion-back/src/render/render.worker.ts
 */
export const FRAME_SEQUENCE_PAD = 4;

/** The filename a given frame index is packed under. Shared by both consumers. */
export function frameFileName(frame: number, ext: 'png' | 'jpg'): string {
  return `frame_${String(frame).padStart(FRAME_SEQUENCE_PAD, '0')}.${ext}`;
}

/**
 * Deterministic image-sequence export: render every frame offline and pack the
 * PNG/JPEG stills into one STORE zip. Reproducible — identical bytes each run.
 */
export async function renderSequenceZip(
  opts: ExportOptions,
  ext: 'png' | 'jpg',
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
  /** Extra files to pack alongside the frames (e.g. the mixed audio.wav). */
  extraEntries: ReadonlyArray<ZipEntry> = [],
): Promise<Blob> {
  const type = ext === 'png' ? 'image/png' : 'image/jpeg';
  // Multi-frame staging, as in the desktop video sink: the render hands each
  // frame to a pooled canvas and moves on while several encodes run. Entries
  // are slotted by frame index so completion order never reorders the zip.
  const entries: ZipEntry[] = [];
  const pipeline = new FramePipeline();
  let pool: CanvasPool | null = null;
  // The zip writer is classic 32-bit (no ZIP64): offsets truncate past 4GB
  // and the whole archive is assembled in memory. Enforced DURING the render
  // — a 1080p PNG sequence crosses the limit around ~2000 frames, and the old
  // behaviour was to render for an hour and then die (or corrupt) at
  // assembly. 3.5GB leaves headroom for the central directory + the worker's
  // second copy of the entries.
  const ZIP_BYTE_LIMIT = 3.5 * 1024 * 1024 * 1024;
  let zipBytes = 0;
  await renderOffline(
    offlineParams(opts),
    async (canvas, frame, count) => {
      pool ??= new CanvasPool(canvas.width, canvas.height, defaultConcurrency() + 1);
      const p = pool;
      const snap = p.snapshot(canvas);
      const name = frameFileName(frame, ext);
      const slot = frame;
      await pipeline.push(async () => {
        try {
          const data = await canvasBytes(snap, type, ext === 'jpg' ? 0.92 : undefined);
          zipBytes += data.byteLength;
          entries[slot] = { name, data };
        } finally {
          p.release(snap);
        }
      });
      if (zipBytes > ZIP_BYTE_LIMIT) {
        throw new Error(
          `The ${ext.toUpperCase()} sequence exceeds the browser zip's 3.5GB limit at frame ${frame} of ${count}. `
          + 'Export a shorter range, use JPG frames, or use the desktop app for video output.',
        );
      }
      onProgress?.((frame + 1) / count);
    },
    signal,
  );
  await pipeline.drain();
  if (entries.length === 0) throw new Error('No frames were rendered.');
  // Assemble the archive off the main thread (falls back to sync if no worker).
  const bytes = await encodeZipBytes([...entries, ...extraEntries]);
  return new Blob([bytes as BlobPart], { type: 'application/zip' });
}

async function exportPNG(opts: ExportOptions): Promise<void> {
  // Through renderStillFrame, NOT a bespoke render: this path used to call
  // renderFrame once on a cold backend with no media convergence and no
  // diagnostics gate — a comp with footage exported the transparent
  // placeholder (or a half-decoded frame), and a broken compositing op that
  // every other export REFUSES on shipped silently in a still.
  const frame = opts.fps > 0 ? Math.round(opts.time * opts.fps) : 0;
  const frameTime = opts.fps > 0 ? frame / opts.fps : opts.time;
  const blob = await renderStillFrame({
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    durationSec: opts.duration,
    comp: opts.comp,
    motionBlur: exportMotionBlur(opts.fps),
  }, frame);
  opts.onProgress?.(1);
  throwIfAborted(opts.signal);
  if (!blob) throw new Error('The frame could not be encoded to PNG.');
  download(blob, `${opts.baseName ?? `motion-frame-${frameTime.toFixed(2)}s`}.png`);
}

/** Throw the standard cancellation rejection when the signal has fired. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

/**
 * Export the project as a re-openable document.
 *
 * This wrote its own hand-rolled shape (`{version, scene, animation,
 * exportedAt}`) that nothing could read back: the loader looks for a top-level
 * `nodes`, found none, and opened a SILENTLY EMPTY scene — while the preset
 * advertised "Re-openable Motion project file". It now writes exactly what
 * `File ▸ Open` restores, so the claim is true.
 */
function exportJSON(opts: ExportOptions): void {
  const doc = { ...captureDocument(), exportedAt: new Date().toISOString() };
  opts.onProgress?.(1);
  download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), 'motion-project.json');
}

/** CMX 3600-style EDL of the active timeline's clip bars. */
function exportEDL(opts: ExportOptions): void {
  const text = exportEdlText('MOTION');
  opts.onProgress?.(1);
  download(new Blob([text], { type: 'text/plain' }), 'timeline.edl');
}

/** OpenTimelineIO document of the same clip bars (see exportOtio.ts). */
function exportOTIO(opts: ExportOptions): void {
  const text = exportOtioText('MOTION');
  opts.onProgress?.(1);
  download(new Blob([text], { type: 'application/json' }), 'timeline.otio');
}

/** Final Cut Pro X XML of the same clip bars. */
function exportFCPXML(opts: ExportOptions): void {
  const text = exportFcpxmlText('MOTION');
  opts.onProgress?.(1);
  download(new Blob([text], { type: 'text/xml' }), 'timeline.fcpxml');
}

/** Premation .mogrt foothold — template fields + document in a zip (not Adobe AME). */
function exportMogrt(opts: ExportOptions): void {
  const bytes = exportMogrtZip('MOTION');
  opts.onProgress?.(1);
  download(new Blob([bytes as BlobPart], { type: 'application/zip' }), 'template.mogrt.zip');
}

/** Avid Log Exchange — text cut list Media Composer imports. */
function exportALE(opts: ExportOptions): void {
  const text = exportAleText();
  opts.onProgress?.(1);
  download(new Blob([text], { type: 'text/plain' }), 'timeline.ale');
}

/** sRGB byte → approximate linear light. */
function srgbToLinear(u: number): number {
  const c = u / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * RGBA planes → EXR bytes. `rgba` must be linear light with ASSOCIATED
 * (premultiplied) alpha — the OpenEXR convention. The GPU readback is already
 * premultiplied; the canvas fallback premultiplies before calling this.
 */
function encodeExrFromLinearRgba(w: number, h: number, rgba: Float32Array): Uint8Array {
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = rgba[i * 4]!;
    g[i] = rgba[i * 4 + 1]!;
    b[i] = rgba[i * 4 + 2]!;
    a[i] = rgba[i * 4 + 3]!;
  }
  const buf = encodeExr({
    width: w,
    height: h,
    channels: [
      { name: 'R', data: r },
      { name: 'G', data: g },
      { name: 'B', data: b },
      { name: 'A', data: a },
    ],
  });
  return new Uint8Array(buf);
}

/** Read canvas pixels into an OpenEXR HALF RGB file (display-referred → linear). */
async function canvasToExrBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const w = canvas.width;
  const h = canvas.height;
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('EXR: no 2d context');
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);
  const n = w * h;
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    // getImageData hands back STRAIGHT alpha; EXR stores associated
    // (premultiplied) — multiply colour by alpha after linearizing.
    const a = data[i * 4 + 3]! / 255;
    rgba[i * 4] = srgbToLinear(data[i * 4]!) * a;
    rgba[i * 4 + 1] = srgbToLinear(data[i * 4 + 1]!) * a;
    rgba[i * 4 + 2] = srgbToLinear(data[i * 4 + 2]!) * a;
    rgba[i * 4 + 3] = a;
  }
  return encodeExrFromLinearRgba(w, h, rgba);
}

export async function renderExrSequenceZip(
  opts: ExportOptions,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const audio = await exportAudioEntries(opts);
  const entries: ZipEntry[] = [];
  await renderOffline(
    offlineParams(opts),
    async (canvas, frame, count, backend) => {
      const linear =
        (await backend?.readLinearRgbaAsync?.())
        ?? backend?.readLinearRgba?.()
        ?? null;
      // Exact-size match only: a stale readback from a previous resolution
      // would decode as garbled rows, which is worse than the canvas fallback.
      const data = linear && linear.length === canvas.width * canvas.height * 4
        ? encodeExrFromLinearRgba(canvas.width, canvas.height, linear)
        : await canvasToExrBytes(canvas);
      entries.push({
        name: `frame_${String(frame).padStart(FRAME_SEQUENCE_PAD, '0')}.exr`,
        data,
      });
      onProgress?.((frame + 1) / count);
    },
    signal,
  );
  if (entries.length === 0) throw new Error('No frames were rendered.');
  const bytes = await encodeZipBytes([...entries, ...audio]);
  onProgress?.(1);
  return new Blob([bytes as BlobPart], { type: 'application/zip' });
}

async function exportExrSequence(opts: ExportOptions): Promise<void> {
  const blob = await renderExrSequenceZip(opts, opts.onProgress, opts.signal);
  download(blob, `${opts.baseName ?? defaultBaseName()}-exr-sequence.zip`);
}

// ── Video / GIF export ───────────────────────────────────────────────

/**
 * Render every frame into a video sink and produce one file.
 *
 * On the desktop this stages frames to a temp dir and encodes them with ffmpeg
 * in a child process; in the browser it encodes with WebCodecs. Either way the
 * loop is the deterministic one (frame time = index / fps), so two exports of the
 * same project are identical, and the sink reports how many frames it actually
 * received — a zero-frame encode throws instead of writing a black file.
 *
 * @see videoSink.ts for why MediaRecorder is no longer used.
 */
export async function renderVideo(
  opts: ExportOptions,
  format: VideoFormat,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<VideoSinkResult> {
  const audio = await exportAudioBytes(opts);
  const sink = createVideoSink({
    format,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    quality: opts.quality ?? 'high',
    ...(opts.proresProfile ? { proresProfile: opts.proresProfile } : {}),
    transparent: !!opts.comp?.transparent,
    ...(opts.chapters?.length ? { chapters: opts.chapters } : {}),
    ...(audio ? { audioWav: audio } : {}),
  });
  if (!sink) throw new Error(unsupportedFormatMessage(format));

  const { withNeutralDisplayForHdrEncode } = await import('./hdrTransfer');
  const { useColorManagementStore } = await import('@stores/colorManagementStore');
  const runEncode = async (): Promise<VideoSinkResult> => {
    try {
      await renderOffline(
        offlineParams(opts),
        async (canvas, frame, count, backend) => {
          // The backend rides along as the sink's optional float-linear frame
          // source (the HDR sink stages from it instead of 8-bit sRGB bytes).
          await sink.addFrame(canvas, frame, backend);
          // Encoding is the bulk of the work for a video, so hold the reported
          // progress just short of done until the encode itself finishes.
          onProgress?.(((frame + 1) / count) * 0.95);
        },
        signal,
      );
      throwIfAborted(signal);
      const result = await sink.finish();
      onProgress?.(1);
      return result;
    } catch (err) {
      await sink.dispose();
      throw err;
    }
  };

  // HDR delivery bakes PQ/HLG once in the sink — neutralize viewport ODT first.
  if (format === 'hdr10' || format === 'hlg') {
    const cm = useColorManagementStore.getState();
    return withNeutralDisplayForHdrEncode(
      runEncode,
      (v) => cm.setDisplayTransform(v),
      () => cm.displayTransform,
    );
  }
  return runEncode();
}

/**
 * A video render the queue can PAUSE and RESUME without losing staged frames.
 *
 * The desktop sink already makes this cheap: every frame lands as an image in a
 * per-job temp dir and ffmpeg encodes ONCE at the end from `frame_%04d` — so a
 * paused render is nothing more exotic than "the loop stopped after frame N and
 * the files for 0..N are still there". Resume restarts the loop at N+1, staging
 * into the SAME sink; nothing already rendered is re-rendered or re-encoded.
 *
 * `run` treats the abort signal as PAUSE, not failure: it resolves with the
 * next offset instead of throwing, and deliberately does NOT dispose the sink —
 * disposal is exactly the thing a pause must not do (it deletes the staging
 * dir, which was the entire pre-existing behaviour this replaces). Real errors
 * still throw, after disposing.
 *
 * Session-scoped on purpose: the sink handle lives in memory, so quitting the
 * app still loses the partial render (as AE's queue does). What a pause no
 * longer loses is the work.
 *
 * Frames staged before a pause reflect the project AS IT WAS — editing between
 * pause and resume produces a file that changes content mid-way. That is
 * inherent to resumable rendering, not a bug to fix here.
 */
export interface ResumableVideoRender {
  /** Frames in the export range — the denominator for progress. */
  totalFrames: number;
  /**
   * Render frames starting at `fromOffset` (0-based within the export range)
   * into the sink. Resolves `{done: true}` after the last frame stages, or
   * `{done: false, nextOffset}` when the signal fired mid-run.
   */
  run(
    fromOffset: number,
    onProgress?: (f: number) => void,
    signal?: AbortSignal,
  ): Promise<{ done: true } | { done: false; nextOffset: number }>;
  /** Encode the staged frames into the deliverable. */
  finish(): Promise<VideoSinkResult>;
  /** Abandon the render and delete the staging dir. */
  dispose(): Promise<void>;
}

/**
 * A resumable render, or null where resuming is impossible — the browser sinks
 * stream their encode as frames arrive, so a paused stream has no staging to
 * come back to. Callers fall back to the one-shot `renderVideo` there.
 */
export async function createResumableVideoRender(
  opts: ExportOptions,
  format: VideoFormat,
): Promise<ResumableVideoRender | null> {
  if (!canEncodeLocally()) return null;
  const audio = await exportAudioBytes(opts);
  const sink = createVideoSink({
    format,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    quality: opts.quality ?? 'high',
    ...(opts.proresProfile ? { proresProfile: opts.proresProfile } : {}),
    transparent: !!opts.comp?.transparent,
    ...(opts.chapters?.length ? { chapters: opts.chapters } : {}),
    ...(audio ? { audioWav: audio } : {}),
  });
  if (!sink) return null;

  const params = offlineParams(opts);
  const { start, end } = resolveRange(params);
  const totalFrames = end - start + 1;
  const isHdr = format === 'hdr10' || format === 'hlg';

  return {
    totalFrames,
    async run(fromOffset, onProgress, signal) {
      let staged = fromOffset;
      const body = async (): Promise<{ done: true } | { done: false; nextOffset: number }> => {
        try {
          await renderOffline(
            // The loop's own range does the skipping: nothing before the resume
            // point is rendered, let alone re-staged.
            { ...params, startFrame: start + fromOffset, endFrame: end },
            async (canvas, frame, _count, backend) => {
              // `frame` is 0-based within THIS run; the sink needs the offset
              // within the whole export range, or a resume would restage over
              // frame_0000 and the encode would begin mid-composition.
              await sink.addFrame(canvas, fromOffset + frame, backend);
              staged = fromOffset + frame + 1;
              onProgress?.((staged / totalFrames) * 0.95);
            },
            signal,
          );
          return { done: true };
        } catch (err) {
          if (isAbortError(err)) return { done: false, nextOffset: staged };
          await sink.dispose();
          throw err;
        }
      };
      if (!isHdr) return body();
      const { withNeutralDisplayForHdrEncode } = await import('./hdrTransfer');
      const { useColorManagementStore } = await import('@stores/colorManagementStore');
      const cm = useColorManagementStore.getState();
      return withNeutralDisplayForHdrEncode(
        body,
        (v) => cm.setDisplayTransform(v),
        () => cm.displayTransform,
      );
    },
    async finish() {
      const result = await sink.finish();
      return result;
    },
    dispose: () => sink.dispose(),
  };
}

/** Why a format can't be produced here, in terms the user can act on. */
function unsupportedFormatMessage(format: VideoFormat): string {
  if (format === 'webm') {
    return 'This browser cannot encode video. Use the desktop app, or export a PNG sequence.';
  }
  return `${format.toUpperCase()} export needs the desktop app (it encodes with ffmpeg). In the browser, export WebM or a PNG sequence instead.`;
}

/**
 * Deliver a finished encode: a native save dialog on the desktop, a download in
 * the browser. Returns false when the user cancelled the save dialog.
 */
async function deliver(result: VideoSinkResult, filenameBase: string): Promise<boolean> {
  const filename = `${filenameBase}.${result.ext}`;
  if (result.kind === 'file') {
    // The bytes stay on disk and are MOVED to the chosen path — a multi-gigabyte
    // export never passes through the renderer heap.
    return (await result.save(filename)) !== null;
  }
  download(result.blob, filename);
  return true;
}

/** True when this build hands finished renders to the OS rather than the browser. */
export { canEncodeLocally };

/** A timestamped default filename, so repeat exports don't collide. */
function defaultBaseName(): string {
  return `motion-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
}

async function exportVideoFormat(
  opts: ExportOptions,
  format: VideoFormat,
): Promise<{ videoCodec?: string; hdrMastering?: { maxCll: number; maxFall: number } }> {
  // GIF has a dedicated encoder in the browser (no browser will mux one), so it
  // only routes through the video sink where ffmpeg is available.
  if (format === 'gif' && !canEncodeLocally()) {
    const blob = await renderGifBlob(opts, opts.onProgress, opts.signal);
    download(blob, `${opts.baseName ?? defaultBaseName()}.gif`);
    return {};
  }
  const result = await renderVideo(opts, format, opts.onProgress, opts.signal);
  const delivered = await deliver(result, opts.baseName ?? defaultBaseName());
  if (!delivered) {
    if (result.kind === 'file') await result.discard();
    throw new DOMException('The user cancelled the save dialog.', 'AbortError');
  }
  const mastering = result.hdrMastering;
  return {
    videoCodec: result.kind === 'file' ? result.videoCodec : result.videoCodec,
    ...(mastering
      ? { hdrMastering: { maxCll: mastering.maxCll, maxFall: mastering.maxFall } }
      : {}),
  };
}

/**
 * Peak renderer memory a browser GIF encode would need. The encoder quantises
 * the whole animation at once, so every frame's RGBA is resident.
 *
 * Without a guard, a 1080p 10-second GIF asks for ~2.5 GB and takes the tab down
 * with it — an out-of-memory crash mid-export, with no explanation.
 */
const GIF_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * Encode an animated GIF in the browser. Desktop builds use ffmpeg instead (via
 * the video sink), which palettises across the whole animation and streams
 * frames through disk rather than RAM.
 */
export async function renderGifBlob(
  opts: ExportOptions,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const { start, end } = resolveRange(offlineParams(opts));
  const estimate = opts.width * opts.height * 4 * (end - start + 1);
  if (estimate > GIF_MEMORY_BUDGET_BYTES) {
    throw new Error(
      `A ${opts.width}×${opts.height} GIF of this length needs about ${Math.round(estimate / 1e6)} MB of memory to encode in the browser. ` +
        'Lower the resolution, shorten the range, or export from the desktop app.',
    );
  }

  const frames: GifFrame[] = [];
  // Read pixels through a 2D scratch canvas rather than off the render surface:
  // `getContext('2d')` returns null on a canvas the GPU backend has claimed, and
  // the old code silently skipped such frames — so a GIF came out empty with no
  // error at all.
  const scratch = document.createElement('canvas');
  scratch.width = opts.width;
  scratch.height = opts.height;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('GIF export needs a 2D canvas, which this browser did not provide.');

  await renderOffline(
    offlineParams(opts),
    async (canvas, frame, count) => {
      sctx.clearRect(0, 0, opts.width, opts.height);
      sctx.drawImage(canvas, 0, 0, opts.width, opts.height);
      frames.push({
        width: opts.width,
        height: opts.height,
        pixels: sctx.getImageData(0, 0, opts.width, opts.height).data,
      });
      onProgress?.(((frame + 1) / count) * 0.9);
    },
    signal,
  );
  if (frames.length === 0) throw new Error('No frames were rendered.');

  // LZW-encode off the main thread so the app stays responsive (this pass used
  // to freeze the whole window, cursor included). Falls back to sync if the
  // worker is unavailable.
  const bytes = await encodeGifBytes(frames, opts.fps);
  if (bytes.length === 0) throw new Error('GIF encoding produced no data.');
  onProgress?.(1);
  return new Blob([bytes as BlobPart], { type: 'image/gif' });
}

async function exportSequence(opts: ExportOptions, ext: 'png' | 'jpg'): Promise<void> {
  // The mixed audio rides along in the archive: a frame sequence is normally
  // headed for another editor, and shipping the picture without the sound means
  // re-exporting just to get it.
  const audio = await exportAudioEntries(opts);
  const blob = await renderSequenceZip(opts, ext, opts.onProgress, opts.signal, audio);
  opts.onProgress?.(1);
  download(blob, `${opts.baseName ?? defaultBaseName()}-${ext}-sequence.zip`);
}

/** "#ff8800" → Lottie's normalized [r, g, b] triple. */
function hexToLottieRgb(hex: unknown): [number, number, number] {
  const s = typeof hex === 'string' ? hex.trim().replace('#', '') : '';
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-f]{6}$/i.test(full)) return [1, 1, 1];
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * The layer's actual geometry, as Lottie shape items.
 *
 * Without this the export was structurally valid bodymovin with `shapes: []`
 * on every layer — it opened in a player and drew absolutely nothing. Lottie
 * shapes are positioned around the layer's own anchor, so `p` is [0,0] here;
 * the layer's `ks.p` does the placing.
 *
 * Returns [] for kinds with no vector equivalent (text needs embedded font
 * data, images need embedded assets) — the caller counts those and tells the
 * user rather than silently shipping a hole.
 */
function lottieShapesFor(node: SceneNode): unknown[] {
  // Hard type-guard: only true vector shape layers export Lottie geometry.
  // Without this, a text/image/video node that happens to carry a default
  // `shapeType:'rect'` Transform with width/height would fall through to the
  // rect branch below and export as a rectangle. Non-shape layers return [] so
  // the caller counts them as unexported and warns the user (honest drop),
  // rather than silently shipping a bogus box.
  if (readNodeKind(node) !== 'shape') return [];

  const t = node.components.find((c) => c.type === 'Transform');
  const style = node.components.find((c) => c.type === 'Style');
  if (!t) return [];

  const p = t.props as Record<string, unknown>;
  const w = typeof p.width === 'number' ? p.width : 0;
  const h = typeof p.height === 'number' ? p.height : 0;

  const shapeType = typeof p.shapeType === 'string' ? p.shapeType : 'rect';
  const fill = (style?.props as Record<string, unknown> | undefined)?.fill;
  const stroke = (style?.props as Record<string, unknown> | undefined)?.stroke;
  const strokeWidth = (style?.props as Record<string, unknown> | undefined)?.strokeWidth;
  const hasFill = typeof fill === 'string' && fill !== '' && fill !== 'none' && fill !== 'transparent';
  const hasStroke = typeof stroke === 'string' && stroke !== '' && stroke !== 'none' && typeof strokeWidth === 'number' && strokeWidth > 0;

  const geomComp = node.components.find((c) => c.type === 'Geometry');
  let geometry: unknown;

  if (geomComp && Array.isArray(geomComp.props.points) && (geomComp.props.points as Array<{ x: number; y: number }>).length > 0) {
    const pts = geomComp.props.points as Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>;
    const closed = geomComp.props.open !== true;
    const lottieBez = pointsToLottieBezier(pts, closed);
    geometry = {
      ty: 'sh',
      d: 1,
      ks: { a: 0, k: lottieBez },
      nm: 'Path',
    };
  } else if (shapeType === 'ellipse') {
    if (w <= 0 || h <= 0) return [];
    geometry = { ty: 'el', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [w, h] }, nm: 'Ellipse' };
  } else if (shapeType === 'polygon' || shapeType === 'star') {
    const width = w > 0 ? w : 100;
    const height = h > 0 ? h : 100;
    const outline = shapeOutline(shapeType as 'polygon' | 'star', width, height, 32);
    if (outline && outline.length >= 3) {
      const lottieBez = pointsToLottieBezier(outline, true);
      geometry = { ty: 'sh', d: 1, ks: { a: 0, k: lottieBez }, nm: shapeType === 'polygon' ? 'Polygon' : 'Star' };
    } else {
      geometry = { ty: 'rc', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [width, height] }, r: { a: 0, k: 0 }, nm: 'Rect' };
    }
  } else {
    if (w <= 0 || h <= 0) return [];
    geometry = {
      ty: 'rc', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [w, h] },
      r: { a: 0, k: typeof p.cornerRadius === 'number' ? p.cornerRadius : 0 },
      nm: 'Rect',
    };
  }

  const groupItems: unknown[] = [geometry];
  if (hasFill || !hasStroke) {
    groupItems.push({
      ty: 'fl',
      c: { a: 0, k: [...hexToLottieRgb(hasFill ? fill : '#ffffff'), 1] },
      o: { a: 0, k: hasFill ? 100 : 0 },
      r: 1,
      nm: 'Fill',
    });
  }
  if (hasStroke) {
    groupItems.push({
      ty: 'st',
      c: { a: 0, k: [...hexToLottieRgb(stroke), 1] },
      o: { a: 0, k: 100 },
      w: { a: 0, k: strokeWidth },
      lc: 2,
      lj: 2,
      nm: 'Stroke',
    });
  }
  groupItems.push({
    ty: 'tr',
    p: { a: 0, k: [0, 0] },
    a: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 },
    o: { a: 0, k: 100 },
  });

  return [
    {
      ty: 'gr',
      nm: 'Group',
      it: groupItems,
    },
  ];
}

/** Lottie out/in handles for the segment STARTING at keyframe `k` (bodymovin
 *  stores both on the leading keyframe). Hold segments use `h: 1`. */
function lottieEase(k: { easing?: string; bezier?: readonly number[] }): Record<string, unknown> {
  const CURVES: Record<string, [number, number, number, number]> = {
    linear: [0.167, 0.167, 0.833, 0.833],
    ease: [0.25, 0.1, 0.25, 1],
    easeIn: [0.42, 0, 1, 1],
    easeOut: [0, 0, 0.58, 1],
    easeInOut: [0.42, 0, 0.58, 1],
  };
  if (k.easing === 'hold' || k.easing === 'step') return { h: 1 };
  const b =
    (k.easing === 'bezier' || k.easing === 'autoBezier' || k.easing === 'continuousBezier') && k.bezier?.length === 4
      ? (k.bezier as [number, number, number, number])
      : CURVES[k.easing ?? 'linear'] ?? CURVES.linear!;
  return { o: { x: [b[0]], y: [b[1]] }, i: { x: [b[2]], y: [b[3]] } };
}

/** Build a Lottie animation from the scene's geometry and transform tracks. */
function exportLottie(opts: ExportOptions): void {
  const fr = opts.fps;
  const op = Math.round(opts.duration * fr);
  // Scoped to THIS composition: flattenScene walks the whole project, so a
  // multi-comp project exported every comp's layers stacked into one Lottie.
  const rootId = opts.comp?.rootId;
  const layers = flattenScene(defaultSceneGraph)
    .filter((n) => (rootId ? compRootOf(n.id) === rootId && n.id !== rootId : true))
    .filter((n) => readNodeKind(n) !== 'group')
    .map((node, idx) => {
      // Base (un-keyframed) value straight off the components — the engine's
      // base provider only covers some props, and `?? 0` here once exported
      // every un-animated-opacity layer invisible.
      const baseProp = (prop: string): number | undefined => {
        for (const c of node.components) {
          const v = (c.props as Record<string, unknown>)[prop];
          if (typeof v === 'number') return v;
        }
        return undefined;
      };
      const kf = (prop: string, mul = 1, fallback = 0): unknown => {
        const tr = defaultAnimation.tracksFor(node.id).find((t) => t.prop === prop);
        if (!tr || tr.keyframes.length < 2) {
          const v = defaultAnimation.sample(node.id, prop, 0) ?? baseProp(prop) ?? fallback;
          return { a: 0, k: v * mul };
        }
        // Real per-segment easing — this was a hardcoded 0.4 bezier for every
        // keyframe regardless of the authored curves.
        return {
          a: 1,
          k: tr.keyframes.map((k) => ({ t: Math.round(k.t * fr), s: [k.value * mul], ...lottieEase(k) })),
        };
      };

      // Scale: engine stores 1 = 100%, split across scale/scaleX/scaleY —
      // Lottie wants one [sx, sy, sz] vector track, so animated scale merges
      // over the union of keyframe times. (It exported a hardcoded static
      // [100,100,100] before — scale animation vanished from every Lottie.)
      const scaleProps = ['scale', 'scaleX', 'scaleY'] as const;
      const scaleAnimated = scaleProps.some((p) => defaultAnimation.isAnimated(node.id, p));
      const sampleScale = (axis: 'scaleX' | 'scaleY', t: number): number =>
        defaultAnimation.sample(node.id, 'scale', t) ??
        defaultAnimation.sample(node.id, axis, t) ??
        baseProp('scale') ?? baseProp(axis) ?? 1;
      let s: unknown;
      if (!scaleAnimated) {
        s = { a: 0, k: [sampleScale('scaleX', 0) * 100, sampleScale('scaleY', 0) * 100, 100] };
      } else {
        const times = [...new Set(
          scaleProps.flatMap((p) =>
            defaultAnimation.tracksFor(node.id).find((t) => t.prop === p)?.keyframes.map((k) => k.t) ?? [],
          ),
        )].sort((a, b) => a - b);
        const easeSourceAt = (t: number) =>
          scaleProps
            .map((p) => defaultAnimation.tracksFor(node.id).find((tr) => tr.prop === p)?.keyframes.find((k) => k.t === t))
            .find((k) => k !== undefined) ?? {};
        s = {
          a: 1,
          k: times.map((t) => ({
            t: Math.round(t * fr),
            s: [sampleScale('scaleX', t) * 100, sampleScale('scaleY', t) * 100, 100],
            ...lottieEase(easeSourceAt(t)),
          })),
        };
      }

      return {
        ddd: 0, ind: idx + 1, ty: 4, nm: node.name ?? `Layer ${idx}`,
        sr: 1, ip: 0, op,
        ks: {
          o: kf('opacity', 1, 100),
          r: kf('rotation'),
          // Split-dimension position: x and y are independent scalar tracks in
          // the engine, and Lottie's `s: true` form keeps their keyframes AND
          // easing intact. (Position was sampled once and written static.)
          p: { s: true, x: kf('x'), y: kf('y') },
          a: { a: 0, k: [0, 0, 0] },
          s,
        },
        shapes: lottieShapesFor(node),
      };
    });

  const lottie = { v: '5.7.0', fr, ip: 0, op, w: opts.width, h: opts.height, nm: 'Motion Export', ddd: 0, assets: [], layers };
  opts.onProgress?.(1);
  download(new Blob([JSON.stringify(lottie)], { type: 'application/json' }), 'motion-export.lottie.json');

  // Say what didn't make it. A Lottie that silently drops every text layer is
  // worse than one that admits it — the user finds out in the player otherwise.
  const dropped = layers.filter((l) => (l as { shapes: unknown[] }).shapes.length === 0).length;
  if (dropped > 0) {
    useUIStore.getState().notify({
      level: 'warning',
      message: `Lottie exported, but ${dropped} layer${dropped > 1 ? 's' : ''} had no vector equivalent (text and images need WebM or MP4).`,
      durationMs: 6000,
    });
  }
}

/**
 * The export range in seconds — derived from the SAME frame arithmetic the
 * picture uses (offlineParams → resolveRange), so audio length always equals
 * frameCount / fps exactly. Deriving it independently from seconds left audio
 * shorter than video by up to a frame (work areas, fractional rates), and
 * ffmpeg's `-shortest` silently dropped the final video frame(s) whenever the
 * comp had sound.
 */
function exportRange(opts: ExportOptions): { startSec: number; endSec: number } {
  const wa = activeWorkArea(opts);
  if (wa) {
    const startFrame = Math.round(wa.start * opts.fps);
    const endFrame = Math.max(startFrame, Math.round(wa.end * opts.fps) - 1);
    const startSec = startFrame / opts.fps;
    return { startSec, endSec: startSec + (endFrame - startFrame + 1) / opts.fps };
  }
  const frames = Math.max(1, Math.round(opts.duration * opts.fps));
  return { startSec: 0, endSec: frames / opts.fps };
}

/**
 * The comp's mixed audio as WAV bytes, or undefined when the comp is silent.
 *
 * Mixed over the same window the frames cover ({@link exportRange}), so picture
 * and sound can never drift apart. A failure here is never fatal: a silent video
 * beats a failed export.
 */
async function exportAudioBytes(opts: ExportOptions): Promise<Uint8Array | undefined> {
  const { startSec, endSec } = exportRange(opts);
  const mix = await mixdownAudio(startSec, endSec, opts.comp?.rootId).catch(() => null);
  if (!mix) return undefined;
  return new Uint8Array(await mix.wav.arrayBuffer());
}

/** The mixed comp audio as a zip entry, for sequence exports. */
export async function exportAudioEntries(opts: ExportOptions): Promise<ZipEntry[]> {
  const bytes = await exportAudioBytes(opts);
  return bytes ? [{ name: 'audio.wav', data: bytes }] : [];
}

/**
 * Audio-only export: the comp's mixdown as a WAV, over the same range and with
 * the same frame arithmetic every other format uses. Unlike the video paths a
 * silent comp is an ERROR here — the whole point of the format is the sound,
 * and a zero-byte-of-signal WAV with a success toast would be the export bug
 * this module keeps having to un-ship.
 */
async function exportWavAudio(opts: ExportOptions): Promise<void> {
  const { startSec, endSec } = exportRange(opts);
  const mix = await mixdownAudio(startSec, endSec, opts.comp?.rootId);
  throwIfAborted(opts.signal);
  if (!mix) {
    throw new Error(
      'This composition has no audible audio in the export range — nothing to write. '
      + 'Check layer mute states and the work area.',
    );
  }
  opts.onProgress?.(1);
  download(mix.wav, `${opts.baseName ?? defaultBaseName()}.wav`);
}

export async function runExport(
  opts: ExportOptions,
): Promise<{ videoCodec?: string; hdrMastering?: { maxCll: number; maxFall: number } }> {
  switch (opts.format) {
    case 'png': await exportPNG(opts); return {};
    case 'png-sequence': await exportSequence(opts, 'png'); return {};
    case 'jpg-sequence': await exportSequence(opts, 'jpg'); return {};
    case 'exr-sequence': await exportExrSequence(opts); return {};
    case 'wav': await exportWavAudio(opts); return {};
    case 'json': exportJSON(opts); return {};
    case 'edl': exportEDL(opts); return {};
    case 'otio': exportOTIO(opts); return {};
    case 'fcpxml': exportFCPXML(opts); return {};
    case 'ale': exportALE(opts); return {};
    case 'mogrt': exportMogrt(opts); return {};
    case 'lottie': exportLottie(opts); return {};
    case 'webm':
    case 'mp4':
    case 'gif':
    case 'mov':
    case 'hdr10':
    case 'hlg':
      return exportVideoFormat(opts, opts.format);
    default:
      /*
        A plugin format takes the SAME video path — render every frame, feed a
        sink, take a result. Only the sink differs, and `createVideoSink` picks
        it. Routing it here rather than giving plugin exports their own pipeline
        is what keeps them honest: they get the identical frames, the identical
        colour handling and the identical save flow as a built-in format.
      */
      if (isPluginFormat(opts.format)) return exportVideoFormat(opts, opts.format);
      throw new Error(`Unsupported export format "${String(opts.format)}".`);
  }
}

export interface ExportPreset {
  format: ExportFormat;
  label: string;
  ext: string;
  hint: string;
  /** True when only the desktop build can produce this format. */
  desktopOnly?: boolean;
}

/**
 * The export menu. Hints say what each format is actually for and what it costs,
 * because the choice is otherwise opaque — and because an earlier version of this
 * list advertised things that were not true ("requires backend online" for a
 * format that renders locally, "Re-openable Motion project file" for a shape
 * nothing could open).
 */
export const EXPORT_PRESETS: ExportPreset[] = [
  { format: 'mp4', label: 'MP4 · H.264', ext: 'mp4', hint: 'Plays everywhere. Best default for sharing.', desktopOnly: true },
  { format: 'hdr10', label: 'MP4 · HDR10 (PQ)', ext: 'mp4', hint: 'ST.2084 PQ + BT.2020. Probes host ffmpeg: HEVC 10-bit + MaxCLL/MaxFALL when libx265 is present; otherwise tagged H.264 High 10 (no MaxCLL SEI).', desktopOnly: true },
  { format: 'hlg', label: 'MP4 · HLG', ext: 'mp4', hint: 'Hybrid Log-Gamma + BT.2020. Same encode path as HDR10 — HEVC preferred, H.264 High 10 fallback.', desktopOnly: true },
  { format: 'webm', label: 'WebM · VP9', ext: 'webm', hint: 'Smaller than MP4, keeps transparency, ideal for the web.' },
  { format: 'mov', label: 'MOV · ProRes', ext: 'mov', hint: 'For editing in another app. 4444 keeps alpha; the 422 profiles halve the file for opaque delivery.', desktopOnly: true },
  { format: 'gif', label: 'Animated GIF', ext: 'gif', hint: 'No audio, 256 colours. Keep it short and small.' },
  { format: 'wav', label: 'Audio only · WAV', ext: 'wav', hint: 'The comp’s mixed audio as 48kHz 16-bit stereo PCM. No picture.' },
  { format: 'png-sequence', label: 'PNG sequence', ext: 'zip', hint: 'Lossless frames with alpha, zipped. The archival option.' },
  { format: 'jpg-sequence', label: 'JPEG sequence', ext: 'zip', hint: 'Smaller frames, no alpha.' },
  { format: 'exr-sequence', label: 'EXR sequence', ext: 'zip', hint: 'Half-float linear RGB per frame. Prefers GPU linear RT readback (WebGL2 sync / WebGPU async); falls back to display undo-gamma.' },
  { format: 'png', label: 'Still frame', ext: 'png', hint: 'The current frame as one PNG.' },
  { format: 'lottie', label: 'Lottie', ext: 'json', hint: 'Vector animation for web/mobile players. Shapes only.' },
  { format: 'json', label: 'Project file', ext: 'json', hint: 'The editable document, re-openable with File ▸ Open.' },
  { format: 'edl', label: 'EDL (CMX 3600)', ext: 'edl', hint: 'Clip list for Premiere / Avid. No nested comps or AAF.' },
  { format: 'otio', label: 'OpenTimelineIO', ext: 'otio', hint: 'Editorial interchange: Resolve opens it natively; OTIO adapters convert to AAF/FCPXML. Cuts only — no effects.' },
  { format: 'fcpxml', label: 'FCPXML', ext: 'fcpxml', hint: 'Final Cut / Premiere XML cuts. Same clip bars as EDL — no nested comps.' },
  { format: 'ale', label: 'ALE (Avid)', ext: 'ale', hint: 'Avid Log Exchange cut list. Binary AAF still needs OTIO adapters.' },
  { format: 'mogrt', label: 'Essential Graphics (.mogrt.zip)', ext: 'zip', hint: 'Premation template package (fields + project). Not Adobe AME — re-importable here.' },
];

/** Presets this build can actually produce. */
export function availableExportPresets(): ExportPreset[] {
  const local = canEncodeLocally();
  const builtin = EXPORT_PRESETS.filter((p) => local || !p.desktopOnly);

  /*
    Plugin formats, appended AFTER the built-ins and never interleaved.

    Order is the whole point: a user scanning the list should reach everything
    the editor guarantees before anything a third party added, and a plugin
    should not be able to place its format above MP4 by naming it "AAA". The
    hint carries the plugin's own name, so a format that behaves oddly is
    attributable without opening the plugin manager.

    Never marked `desktopOnly` — a plugin encoder is JavaScript in a worker and
    runs wherever the editor does.
  */
  return [
    ...builtin,
    ...pluginExporters().map((e) => ({
      format: e.format as ExportFormat,
      label: e.label,
      ext: e.extension,
      hint: `Provided by ${e.pluginName}`,
    })),
  ];
}

export const DEFAULT_COMP = { width: COMP_WIDTH, height: COMP_HEIGHT };
