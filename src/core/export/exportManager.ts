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
import { buildSnapshot, COMP_WIDTH, COMP_HEIGHT } from '@core/rendering/buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';

export type ExportFormat = 'webm' | 'png' | 'json' | 'lottie';

export interface ExportOptions {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Current playhead time (for the single-frame PNG). */
  time: number;
  onProgress?: (fraction: number) => void;
}

/** Trigger a browser download for a blob. */
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

async function exportPNG(opts: ExportOptions): Promise<void> {
  const { canvas, backend } = makeCanvas(opts.width, opts.height);
  backend.renderFrame(buildSnapshot(defaultSceneGraph, defaultAnimation, opts.time));
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

/** Encode a real WebM video by rendering each frame into a captured stream. */
async function exportWebM(opts: ExportOptions): Promise<void> {
  const { canvas, backend } = makeCanvas(opts.width, opts.height);
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start();

  const total = Math.max(1, Math.ceil(opts.duration * opts.fps));
  for (let i = 0; i < total; i++) {
    const t = i / opts.fps;
    backend.renderFrame(buildSnapshot(defaultSceneGraph, defaultAnimation, t));
    track.requestFrame();
    opts.onProgress?.(i / total);
    // Give MediaRecorder wall-clock time to sample the requested frame.
    await sleep(Math.max(16, 1000 / opts.fps));
  }
  rec.stop();
  await stopped;
  backend.dispose();
  opts.onProgress?.(1);
  download(new Blob(chunks, { type: 'video/webm' }), 'motion-export.webm');
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

export async function runExport(opts: ExportOptions): Promise<void> {
  switch (opts.format) {
    case 'png': return exportPNG(opts);
    case 'json': return exportJSON(opts);
    case 'lottie': return exportLottie(opts);
    case 'webm': return exportWebM(opts);
  }
}

export const EXPORT_PRESETS: { format: ExportFormat; label: string; ext: string; hint: string }[] = [
  { format: 'webm', label: 'Video', ext: 'webm', hint: 'WebM video of the full composition' },
  { format: 'png', label: 'Still frame', ext: 'png', hint: 'Current frame as a PNG image' },
  { format: 'lottie', label: 'Lottie', ext: 'json', hint: 'Editable Lottie animation for web/mobile' },
  { format: 'json', label: 'Project', ext: 'json', hint: 'Re-openable Motion project file' },
];

export const DEFAULT_COMP = { width: COMP_WIDTH, height: COMP_HEIGHT };
