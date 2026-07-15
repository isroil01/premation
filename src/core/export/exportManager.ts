/**
 * Export pipeline (spec §Export). One-click presets that render the current
 * composition to real, downloadable files. Everything runs off-screen so it
 * never blocks the editor, and reports progress.
 *
 *  - JSON   — the editable project (scene + animation), re-openable.
 *  - PNG    — the current frame at full resolution.
 *  - WebM   — a real video, encoded frame-by-frame via MediaRecorder.
 *  - Lottie — a JSON animation (transform keyframes) for web/mobile players.
 */

import { Canvas2DBackend } from '@core/rendering/Canvas2DBackend';
import { buildSnapshot, COMP_WIDTH, COMP_HEIGHT, type SnapshotComp } from '@core/rendering/buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { getTimelineController } from '@core/timeline/TimelineController';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { renderOffline, frameCount, exportView, type OfflineRenderParams } from './offlineRenderer';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { createStoreZip, type ZipEntry } from './zip';
import { createAnimatedGIF, type GifFrame } from './gifEncoder';
import { api } from '@core/api/client';
import { useUIStore } from '@stores/uiStore';

export type ExportFormat = 'webm' | 'png' | 'png-sequence' | 'jpg-sequence' | 'json' | 'lottie' | 'mp4' | 'gif';

export interface ExportOptions {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Current playhead time (for the single-frame PNG). */
  time: number;
  /** Comp size + background (defaults to 1920×1080 near-black when omitted).
   *  `transparent` yields real alpha in the exported PNG/WebM. */
  comp?: SnapshotComp;
  onProgress?: (fraction: number) => void;
}

/** Viewport motion-blur settings, threaded into export so it matches preview. */
function exportMotionBlur(fps: number): import('@core/effects/motionBlur').MotionBlurConfig | undefined {
  const mb = useMotionBlurStore.getState();
  return mb.enabled ? { enabled: true, shutterAngle: mb.shutterAngle, shutterPhase: mb.shutterPhase, samples: mb.samples, adaptiveSampleLimit: mb.adaptiveSampleLimit, fps } : undefined;
}

/** buildSnapshot with the export comp settings (bg colour + transparency), no
 *  preview chrome, comp mapped 1:1 into the output frame (the implicit fallback
 *  fit insets 8% for preview framing — exported frames must fill exactly). */
function exportSnapshot(opts: ExportOptions, time: number): ReturnType<typeof buildSnapshot> {
  return buildSnapshot(
    defaultSceneGraph,
    defaultAnimation,
    time,
    undefined,
    undefined,
    exportView(opts.width, opts.height, opts.comp),
    exportMotionBlur(opts.fps),
    opts.comp,
  );
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
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; backend: Canvas2DBackend } {
  const canvas = document.createElement('canvas');
  const backend = new Canvas2DBackend();
  backend.attach(canvas);
  backend.resize(w, h, 1);
  return { canvas, backend };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Offline-render params derived from the export options. */
function offlineParams(opts: ExportOptions): OfflineRenderParams {
  const wa = getTimelineController().getWorkArea();
  return {
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    durationSec: opts.duration,
    comp: opts.comp,
    motionBlur: exportMotionBlur(opts.fps),
    ...(wa ? { startFrame: Math.round(wa.start * opts.fps), endFrame: Math.round(wa.end * opts.fps) } : {}),
  };
}

/** Encode a canvas frame to raw bytes (png/jpeg). */
async function frameBytes(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
  if (!blob) return new Uint8Array(0);
  return new Uint8Array(await blob.arrayBuffer());
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
): Promise<Blob> {
  const type = ext === 'png' ? 'image/png' : 'image/jpeg';
  const total = frameCount(opts.duration, opts.fps);
  const pad = String(total).length;
  const entries: ZipEntry[] = [];
  await renderOffline(
    offlineParams(opts),
    async (canvas, frame, count) => {
      const name = `frame_${String(frame).padStart(pad, '0')}.${ext}`;
      entries.push({ name, data: await frameBytes(canvas, type, 0.92) });
      onProgress?.((frame + 1) / count);
    },
    signal,
  );
  return createStoreZip(entries);
}

async function exportPNG(opts: ExportOptions): Promise<void> {
  const { canvas, backend } = makeCanvas(opts.width, opts.height);
  backend.renderFrame(exportSnapshot(opts, opts.time));
  opts.onProgress?.(1);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  backend.dispose();
  if (blob) download(blob, `motion-frame-${opts.time.toFixed(2)}s.png`);
}

function exportJSON(opts: ExportOptions): void {
  const doc = {
    version: '1.0.0',
    scene: sceneProjectIO.capture(),
    animation: defaultAnimation.snapshot(),
    exportedAt: new Date().toISOString(),
  };
  opts.onProgress?.(1);
  download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), 'motion-project.json');
}

/**
 * Encode a WebM by feeding the DETERMINISTICALLY rendered frames into a
 * captured stream. The content is fixed-timestep (frame time = i/fps), so the
 * frames are reproducible; the MediaRecorder container is paced by wall-clock.
 * Returns the encoded blob.
 */
export async function renderWebMBlob(
  opts: ExportOptions,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  // The captured canvas must persist for the whole recording, so drive
  // MediaRecorder on a dedicated canvas that we render each offline frame onto.
  const rec: { canvas: HTMLCanvasElement; track: CanvasCaptureMediaStreamTrack; recorder: MediaRecorder; chunks: Blob[] } =
    (() => {
      const canvas = document.createElement('canvas');
      canvas.width = opts.width;
      canvas.height = opts.height;
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      return { canvas, track, recorder, chunks };
    })();
  const ctx = rec.canvas.getContext('2d')!;
  const stopped = new Promise<void>((res) => { rec.recorder.onstop = () => res(); });
  rec.recorder.start();

  await renderOffline(
    offlineParams(opts),
    async (frameCanvas, frame, count) => {
      ctx.clearRect(0, 0, opts.width, opts.height);
      ctx.drawImage(frameCanvas, 0, 0);
      rec.track.requestFrame();
      onProgress?.((frame + 1) / count);
      await sleep(Math.max(16, 1000 / opts.fps));
    },
    signal,
  );

  rec.recorder.stop();
  await stopped;
  return new Blob(rec.chunks, { type: 'video/webm' });
}

async function exportWebM(opts: ExportOptions): Promise<void> {
  const blob = await renderWebMBlob(opts, opts.onProgress);
  opts.onProgress?.(1);
  download(blob, 'motion-export.webm');
}

export async function renderGIFBlob(
  opts: ExportOptions,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const frames: GifFrame[] = [];
  await renderOffline(
    offlineParams(opts),
    async (canvas, frame, count) => {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const imgData = ctx.getImageData(0, 0, opts.width, opts.height);
        frames.push({
          width: opts.width,
          height: opts.height,
          pixels: imgData.data,
        });
      }
      onProgress?.((frame + 1) / count);
    },
    signal,
  );
  return createAnimatedGIF(frames, opts.fps);
}

async function exportGIF(opts: ExportOptions): Promise<void> {
  const blob = await renderGIFBlob(opts, opts.onProgress);
  opts.onProgress?.(1);
  download(blob, 'motion-export.gif');
}

async function exportSequence(opts: ExportOptions, ext: 'png' | 'jpg'): Promise<void> {
  const blob = await renderSequenceZip(opts, ext, opts.onProgress);
  opts.onProgress?.(1);
  download(blob, `motion-${ext}-sequence.zip`);
}

/** Build a minimal but valid Lottie JSON from the scene's transform tracks. */
function exportLottie(opts: ExportOptions): void {
  const fr = opts.fps;
  const op = Math.round(opts.duration * fr);
  const layers = flattenScene(defaultSceneGraph)
    .filter((n) => readNodeKind(n) !== 'group')
    .map((node, idx) => {
      const kf = (prop: string, mul = 1): unknown => {
        const tr = defaultAnimation.tracksFor(node.id).find((t) => t.prop === prop);
        if (!tr || tr.keyframes.length < 2) {
          const v = defaultAnimation.sample(node.id, prop, 0) ?? 0;
          return { a: 0, k: v * mul };
        }
        return {
          a: 1,
          k: tr.keyframes.map((k) => ({ t: Math.round(k.t * fr), s: [k.value * mul], i: { x: [0.4], y: [1] }, o: { x: [0.4], y: [0] } })),
        };
      };
      const x = defaultAnimation.sample(node.id, 'x', opts.time) ?? 0;
      const y = defaultAnimation.sample(node.id, 'y', opts.time) ?? 0;
      return {
        ddd: 0, ind: idx + 1, ty: 4, nm: node.name ?? `Layer ${idx}`,
        sr: 1, ip: 0, op,
        ks: {
          o: kf('opacity'),
          r: kf('rotation'),
          p: { a: 0, k: [x, y, 0] },
          a: { a: 0, k: [0, 0, 0] },
          s: { a: 0, k: [100, 100, 100] },
        },
        shapes: [],
      };
    });
  const lottie = { v: '5.7.0', fr, ip: 0, op, w: opts.width, h: opts.height, nm: 'Motion Export', ddd: 0, assets: [], layers };
  opts.onProgress?.(1);
  download(new Blob([JSON.stringify(lottie)], { type: 'application/json' }), 'motion-export.lottie.json');
}

async function exportMP4(opts: ExportOptions): Promise<void> {
  const signal = new AbortController().signal;
  try {
    const renderJob = await api.createRender({
      format: 'mp4',
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
      duration: opts.duration,
      transparent: false,
    });
    opts.onProgress?.(0.1);
    const zipBlob = await renderSequenceZip(opts, 'jpg', (f) => opts.onProgress?.(0.1 + f * 0.4), signal);
    opts.onProgress?.(0.5);
    await api.uploadRenderFrames(renderJob.id, zipBlob, 'zip');
    
    while (true) {
      const status = await api.getRender(renderJob.id);
      if (status.status === 'completed' && status.resultUrl) {
        opts.onProgress?.(1.0);
        const res = await fetch(status.resultUrl);
        const blob = await res.blob();
        download(blob, `motion-export-${Date.now()}.mp4`);
        return;
      }
      if (status.status === 'failed') {
        throw new Error(status.error || 'Backend render failed');
      }
      opts.onProgress?.(0.5 + status.progress * 0.45);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    useUIStore.getState().notify({
      level: 'error',
      message: `MP4 export requires the backend to be online (localhost:4000). Please check connection or start the backend.`,
      durationMs: 4000
    });
    throw err;
  }
}

export async function runExport(opts: ExportOptions): Promise<void> {
  switch (opts.format) {
    case 'png': return exportPNG(opts);
    case 'png-sequence': return exportSequence(opts, 'png');
    case 'jpg-sequence': return exportSequence(opts, 'jpg');
    case 'json': return exportJSON(opts);
    case 'lottie': return exportLottie(opts);
    case 'webm': return exportWebM(opts);
    case 'mp4': return exportMP4(opts);
    case 'gif': return exportGIF(opts);
  }
}

export const EXPORT_PRESETS: { format: ExportFormat; label: string; ext: string; hint: string }[] = [
  { format: 'mp4', label: 'MP4 Video', ext: 'mp4', hint: 'MP4 video (requires backend online)' },
  { format: 'gif', label: 'GIF Animation', ext: 'gif', hint: 'GIF animation (local render)' },
  { format: 'webm', label: 'Video', ext: 'webm', hint: 'WebM video, deterministic frame-by-frame render' },
  { format: 'png-sequence', label: 'PNG sequence', ext: 'zip', hint: 'Lossless frames in a zip (deterministic)' },
  { format: 'png', label: 'Still frame', ext: 'png', hint: 'Current frame as a PNG image' },
  { format: 'lottie', label: 'Lottie', ext: 'json', hint: 'Editable Lottie animation for web/mobile' },
  { format: 'json', label: 'Project', ext: 'json', hint: 'Re-openable Motion project file' },
];

export const DEFAULT_COMP = { width: COMP_WIDTH, height: COMP_HEIGHT };
