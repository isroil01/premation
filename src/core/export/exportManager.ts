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

import { createRenderBackend } from '@core/rendering/createRenderBackend';
import type { RenderBackend } from '@core/rendering/RenderBackend';
import { buildSnapshot, COMP_WIDTH, COMP_HEIGHT, type SnapshotComp } from '@core/rendering/buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, pointsToLottieBezier } from '@motion/animation';
import { shapeOutline } from '@core/scene/pathOps';
import { captureDocument } from '@core/api/cloudDocument';
import { getTimelineController } from '@core/timeline/TimelineController';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';
import { renderOffline, exportView, type OfflineRenderParams } from './offlineRenderer';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { type ZipEntry } from './zip';
import { encodeGifBytes, encodeZipBytes } from './encodeClient';
import { mixdownAudio, mixdownBuffer } from '@core/audio/audioMixdown';
import { type GifFrame } from './gifEncoder';
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
  /** Cooperative cancellation for the whole export (frame loop, encoders, the
   *  backend MP4 job). Aborting rejects with a DOMException 'AbortError'. */
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
        { ...comp, transparent: false },
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
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; backend: RenderBackend } {
  const canvas = document.createElement('canvas');
  const backend = createRenderBackend();
  backend.attach(canvas);
  backend.resize(w, h, 1);
  return { canvas, backend };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
 * Zero-padding width for frame filenames. THIS IS A CROSS-REPO CONTRACT: the
 * motion-back render worker globs `frame_%04d.jpg`, so this must stay 4.
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
  /** Extra files to pack alongside the frames (the MP4 path adds audio.wav). */
  extraEntries: ReadonlyArray<ZipEntry> = [],
): Promise<Blob> {
  const type = ext === 'png' ? 'image/png' : 'image/jpeg';
  const entries: ZipEntry[] = [];
  await renderOffline(
    offlineParams(opts),
    async (canvas, frame, count) => {
      entries.push({ name: frameFileName(frame, ext), data: await frameBytes(canvas, type, 0.92) });
      onProgress?.((frame + 1) / count);
    },
    signal,
  );
  // Assemble the archive off the main thread (falls back to sync if no worker).
  const bytes = await encodeZipBytes([...entries, ...extraEntries]);
  return new Blob([bytes as BlobPart], { type: 'application/zip' });
}

async function exportPNG(opts: ExportOptions): Promise<void> {
  const { canvas, backend } = makeCanvas(opts.width, opts.height);
  try {
    if (backend.readyPromise) await backend.readyPromise;
    throwIfAborted(opts.signal);
    backend.renderFrame(exportSnapshot(opts, opts.time));
    opts.onProgress?.(1);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    throwIfAborted(opts.signal);
    if (blob) download(blob, `motion-frame-${opts.time.toFixed(2)}s.png`);
  } finally {
    backend.dispose();
  }
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
  // Mix the comp audio (deterministic, offline) and play it as a live track on
  // the recorder's stream — MediaRecorder muxes video + audio by capture
  // timestamp, and the frame loop below is paced at ~real time, so they align.
  // Null (silent comp / no Web Audio) → video-only, exactly as before.
  const { startSec, endSec } = exportRange(opts);
  const mixedAudio = await mixdownBuffer(startSec, endSec).catch(() => null);

  const rec: { canvas: HTMLCanvasElement; track: CanvasCaptureMediaStreamTrack; recorder: MediaRecorder; chunks: Blob[]; audio?: { ctx: AudioContext; source: AudioBufferSourceNode } } =
    (() => {
      const canvas = document.createElement('canvas');
      canvas.width = opts.width;
      canvas.height = opts.height;
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

      let audio: { ctx: AudioContext; source: AudioBufferSourceNode } | undefined;
      if (mixedAudio) {
        const actx = new AudioContext();
        const dest = actx.createMediaStreamDestination();
        const source = actx.createBufferSource();
        source.buffer = mixedAudio;
        source.connect(dest);
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
        audio = { ctx: actx, source };
      }

      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      return { canvas, track, recorder, chunks, audio };
    })();
  const ctx = rec.canvas.getContext('2d')!;
  const stopped = new Promise<void>((res) => { rec.recorder.onstop = () => res(); });
  rec.recorder.start();
  // Start audio in lock-step with the recorder so track 0 of both aligns.
  rec.audio?.source.start();

  try {
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
  } finally {
    // Runs on abort too — a cancelled export must not leave the recorder,
    // audio graph or capture stream running (partial-state cleanup).
    rec.recorder.stop();
    await stopped;
    try { rec.audio?.source.stop(); } catch { /* never started / already stopped */ }
    void rec.audio?.ctx.close();
  }
  return new Blob(rec.chunks, { type: 'video/webm' });
}

async function exportWebM(opts: ExportOptions): Promise<void> {
  const blob = await renderWebMBlob(opts, opts.onProgress, opts.signal);
  opts.onProgress?.(1);
  download(blob, 'motion-export.webm');
}

export async function renderGIFBlob(
  opts: ExportOptions,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const frames: GifFrame[] = [];
  // Read pixels through a 2D scratch canvas rather than off the render surface.
  // `getContext('2d')` returns NULL on a canvas the GPU backend has claimed for
  // WebGL, and the old code just skipped the frame — so a GIF exported with the
  // GPU renderer came out empty, with no error.
  const scratch = document.createElement('canvas');
  scratch.width = opts.width;
  scratch.height = opts.height;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  await renderOffline(
    offlineParams(opts),
    async (canvas, frame, count) => {
      if (sctx) {
        sctx.clearRect(0, 0, opts.width, opts.height);
        sctx.drawImage(canvas, 0, 0, opts.width, opts.height);
        frames.push({
          width: opts.width,
          height: opts.height,
          pixels: sctx.getImageData(0, 0, opts.width, opts.height).data,
        });
      }
      onProgress?.((frame + 1) / count);
    },
    signal,
  );
  if (frames.length === 0) throw new Error('No frames were rendered.');
  // LZW-encode the GIF off the main thread so the app stays responsive during
  // the (previously blocking) encode pass. Falls back to sync if no worker.
  const bytes = await encodeGifBytes(frames, opts.fps);
  return bytes.length === 0
    ? new Blob([], { type: 'image/gif' })
    : new Blob([bytes as BlobPart], { type: 'image/gif' });
}

async function exportGIF(opts: ExportOptions): Promise<void> {
  const blob = await renderGIFBlob(opts, opts.onProgress, opts.signal);
  opts.onProgress?.(1);
  download(blob, 'motion-export.gif');
}

async function exportSequence(opts: ExportOptions, ext: 'png' | 'jpg'): Promise<void> {
  const blob = await renderSequenceZip(opts, ext, opts.onProgress, opts.signal);
  opts.onProgress?.(1);
  download(blob, `motion-${ext}-sequence.zip`);
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

  return [
    {
      ty: 'gr',
      nm: 'Group',
      it: [
        geometry,
        { ty: 'fl', c: { a: 0, k: [...hexToLottieRgb(fill), 1] }, o: { a: 0, k: 100 }, r: 1, nm: 'Fill' },
        {
          ty: 'tr',
          p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] },
          s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 },
        },
      ],
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
  const layers = flattenScene(defaultSceneGraph)
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

/** The export range in seconds — the work area if set, else the whole comp. */
function exportRange(opts: ExportOptions): { startSec: number; endSec: number } {
  const wa = getTimelineController().getWorkArea();
  return wa ? { startSec: wa.start, endSec: wa.end } : { startSec: 0, endSec: opts.duration };
}

/**
 * The mixed comp audio as a zip entry (`audio.wav`), or [] when the comp is
 * silent. Shared by the video export paths so audio and frames always cover the
 * same window.
 */
async function exportAudioEntries(opts: ExportOptions): Promise<ZipEntry[]> {
  const { startSec, endSec } = exportRange(opts);
  const mix = await mixdownAudio(startSec, endSec).catch(() => null);
  if (!mix) return [];
  return [{ name: 'audio.wav', data: new Uint8Array(await mix.wav.arrayBuffer()) }];
}

/**
 * Encode an MP4 by feeding the DETERMINISTICALLY rendered frames into a
 * captured canvas stream and recording it. If the browser/platform does not
 * support native video/mp4 recording, it falls back to video/webm recording.
 */
export async function renderMP4Blob(
  opts: ExportOptions,
  onProgress?: (f: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const { startSec, endSec } = exportRange(opts);
  const mixedAudio = await mixdownBuffer(startSec, endSec).catch(() => null);

  const rec: {
    canvas: HTMLCanvasElement;
    track: CanvasCaptureMediaStreamTrack;
    recorder: MediaRecorder;
    chunks: Blob[];
    audio?: { ctx: AudioContext; source: AudioBufferSourceNode };
  } = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

    let audio: { ctx: AudioContext; source: AudioBufferSourceNode } | undefined;
    if (mixedAudio) {
      const actx = new AudioContext();
      const dest = actx.createMediaStreamDestination();
      const source = actx.createBufferSource();
      source.buffer = mixedAudio;
      source.connect(dest);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
      audio = { ctx: actx, source };
    }

    let mime = 'video/mp4;codecs=h264';
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = 'video/mp4;codecs=avc1';
    }
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = 'video/mp4';
    }
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
    }

    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    return { canvas, track, recorder, chunks, audio };
  })();

  const ctx = rec.canvas.getContext('2d')!;
  const stopped = new Promise<void>((res) => {
    rec.recorder.onstop = () => res();
  });
  rec.recorder.start();
  rec.audio?.source.start();

  try {
    await renderOffline(
      offlineParams(opts),
      async (frameCanvas, frame, count) => {
        ctx.clearRect(0, 0, opts.width, opts.height);
        ctx.drawImage(frameCanvas, 0, 0);
        rec.track.requestFrame();
        onProgress?.(frame / count);
        await sleep(Math.max(16, 1000 / opts.fps));
      },
      signal,
    );
  } finally {
    // Runs on abort too — never leave the recorder / audio graph running.
    rec.recorder.stop();
    await stopped;
    try { rec.audio?.source.stop(); } catch { /* never started / already stopped */ }
    void rec.audio?.ctx.close();
  }
  // The blob's type is whatever the recorder ACTUALLY produced — the caller
  // must read it to name the file honestly (mp4 vs the webm fallback).
  return new Blob(rec.chunks, { type: rec.recorder.mimeType });
}

/** Download a locally-recorded video blob under its HONEST extension: the
 *  MediaRecorder falls back to WebM where MP4 recording isn't supported, and
 *  shipping that file as `.mp4` produced a video many players refuse to open. */
function downloadRecordedVideo(blob: Blob): void {
  const isMp4 = /mp4/i.test(blob.type);
  if (!isMp4) {
    useUIStore.getState().notify({
      level: 'warning',
      message: 'This browser cannot record MP4 locally — exported as WebM instead (motion-export.webm).',
      durationMs: 6000,
    });
  }
  download(blob, `motion-export-${Date.now()}.${isMp4 ? 'mp4' : 'webm'}`);
}

async function exportMP4(opts: ExportOptions): Promise<void> {
  const signal = opts.signal;
  // The backend job id, once created — an abort mid-flight also cancels the
  // server-side render instead of leaving it burning in the queue.
  let jobId: string | null = null;
  try {
    const renderJob = await api.createRender({
      format: 'mp4',
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
      duration: opts.duration,
      transparent: false,
    });
    jobId = renderJob.id;
    opts.onProgress?.(0.1);
    // Mix the comp's audio over the export range; bundled into the frames zip
    // as audio.wav for the backend to mux. Empty when the comp has no audio.
    const audioEntries = await exportAudioEntries(opts);
    const zipBlob = await renderSequenceZip(opts, 'jpg', (f) => opts.onProgress?.(0.1 + f * 0.4), signal, audioEntries);
    opts.onProgress?.(0.5);
    throwIfAborted(signal);
    await api.uploadRenderFrames(renderJob.id, zipBlob, 'zip');

    while (true) {
      throwIfAborted(signal);
      const status = await api.getRender(renderJob.id);
      if (status.status === 'completed' && status.resultUrl) {
        opts.onProgress?.(1.0);
        const res = await fetch(status.resultUrl, signal ? { signal } : undefined);
        const blob = await res.blob();
        download(blob, `motion-export-${Date.now()}.mp4`);
        return;
      }
      if (status.status === 'failed' || status.status === 'canceled') {
        throw new Error(status.error || `Backend render ${status.status}`);
      }
      opts.onProgress?.(0.5 + status.progress * 0.45);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    // User cancellation: also cancel the server-side job, then propagate —
    // never treated as "backend offline" or reported as a failure.
    if (isAbortError(err)) {
      if (jobId) void api.cancelRender(jobId).catch(() => undefined);
      throw err;
    }
    // Report what actually failed. This used to blame the network for every
    // error, which masked a frame-naming bug that broke most MP4 exports.
    const reason = (err as Error)?.message ?? String(err);
    const offline = err instanceof TypeError || /fetch|network|ECONNREFUSED|Failed to fetch/i.test(reason);
    if (offline) {
      useUIStore.getState().notify({
        level: 'info',
        message: 'Render backend offline. Falling back to local MP4 recording...',
        durationMs: 4000,
      });
      try {
        const blob = await renderMP4Blob(opts, opts.onProgress, signal);
        opts.onProgress?.(1.0);
        downloadRecordedVideo(blob);
        return;
      } catch (localErr) {
        if (isAbortError(localErr)) throw localErr;
        useUIStore.getState().notify({
          level: 'error',
          message: `Local MP4 export failed: ${(localErr as Error)?.message || localErr}`,
          durationMs: 5000,
        });
        throw localErr;
      }
    }
    useUIStore.getState().notify({
      level: 'error',
      message: `MP4 export failed: ${reason}`,
      durationMs: 5000,
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
