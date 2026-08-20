/**
 * Smooth Stabilize — the driver. Walks the clip once through the exact
 * decoder (the same demux + frame-index machinery every tracker mode uses),
 * estimates per-pair camera motion from optical flow, smooths the path, and
 * writes the corrections as keyframes.
 *
 * The division of labour: `pixelMotionFlow` measures where blocks went,
 * `globalMotion` turns votes into one similarity per pair and a smoothed
 * correction per frame, `applySmoothStabilize` speaks keyframes. This file
 * only sequences frames — one decode pass, previous luma retained, flow at a
 * DOWNSAMPLED size (box-filtered, deterministic) because camera motion is a
 * global signal and quarter resolution measures it at a sixteenth the cost.
 */

import { demuxMp4 } from '@core/video/mp4Demuxer';
import { ExactVideoSource, webCodecsAvailable } from '@core/video/exactVideoSource';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf } from '@core/source/sourceInfo';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { computeFlow } from '@core/rendering/pixelMotionFlow';
import { fitSimilarity, flowSamplePoints, stabilizingCorrections, type Sim } from './globalMotion';
import { applySmoothStabilize } from './applyTrack';
import { sourceDisplaySize } from './trackerSource';

export interface SmoothStabilizeRequest {
  nodeId: string;
  startCompTime: number;
  endCompTime: number;
  fps: number;
  comp: { width: number; height: number; rootId?: string };
  /** Smoothing window in SECONDS of camera path (Gaussian sigma). Default 0.5 —
   *  strong enough to read as locked-off on handheld, short enough that a
   *  deliberate one-second pan survives. */
  smoothnessSec?: number;
  onProgress?: (f: number) => void;
}

export interface SmoothStabilizeResult {
  /** Keyframes written per animated property. */
  keyframes: number;
  /** Frame pairs whose fit succeeded / total pairs. */
  fittedPairs: number;
  totalPairs: number;
}

/** Box-downsample a luma plane by an integer factor. Deterministic. */
export function downsampleLuma(
  data: Float32Array,
  w: number,
  h: number,
  factor: number,
): { data: Float32Array; w: number; h: number } {
  if (factor <= 1) return { data, w, h };
  const dw = Math.max(1, Math.floor(w / factor));
  const dh = Math.max(1, Math.floor(h / factor));
  const out = new Float32Array(dw * dh);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let sum = 0;
      for (let oy = 0; oy < factor; oy++) {
        for (let ox = 0; ox < factor; ox++) {
          sum += data[(y * factor + oy) * w + (x * factor + ox)]!;
        }
      }
      out[y * dw + x] = sum * inv;
    }
  }
  return { data: out, w: dw, h: dh };
}

/** Flow raster target: camera motion reads fine at ~480 wide. */
const STAB_MAX_DIM = 480;

export async function smoothStabilizeVideoLayer(req: SmoothStabilizeRequest): Promise<SmoothStabilizeResult> {
  if (!webCodecsAvailable()) {
    throw new Error('Stabilization needs WebCodecs, which this runtime does not have.');
  }
  const node = defaultSceneGraph.getNode(req.nodeId);
  if (!node) throw new Error('Layer is gone.');
  const assetId = assetIdOf(node);
  const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : undefined;
  if (!asset || asset.type !== 'video') throw new Error('Layer has no video source.');

  // Original file, never the proxy — same reasoning as the point tracker.
  const res = await fetch(asset.src);
  if (!res.ok) throw new Error(`Source unreadable (${res.status}).`);
  const demuxed = await demuxMp4(await res.arrayBuffer());
  const source = new ExactVideoSource(demuxed);

  try {
    const startFrame = Math.round(req.startCompTime * req.fps);
    const endFrame = Math.round(req.endCompTime * req.fps);
    if (endFrame <= startFrame) throw new Error('Nothing after the playhead to stabilize.');

    const srcIndexAt = (compFrame: number): number => {
      const mediaSec = compToKeyframeTime(req.nodeId, compFrame / req.fps);
      return source.frameIndexAt(Math.max(0, Math.round(mediaSec * 1e6) + 1));
    };

    const display = sourceDisplaySize(req.nodeId) ?? {
      width: demuxed.codedWidth,
      height: demuxed.codedHeight,
    };
    const factor = Math.max(1, Math.floor(Math.max(demuxed.codedWidth, demuxed.codedHeight) / STAB_MAX_DIM));
    // Flow-grid px → source DISPLAY px: undo the downsample, then coded→display.
    const scaleX = (factor * display.width) / demuxed.codedWidth;
    const scaleY = (factor * display.height) / demuxed.codedHeight;

    // One luma reader canvas, reused per frame.
    const canvas = document.createElement('canvas');
    canvas.width = demuxed.codedWidth;
    canvas.height = demuxed.codedHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D context for frame readback.');
    const lumaAt = async (srcIdx: number): Promise<{ data: Float32Array; w: number; h: number }> => {
      const frame = await source.frameAt(srcIdx);
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const full = new Float32Array(canvas.width * canvas.height);
      for (let i = 0, p = 0; i < full.length; i++, p += 4) {
        full[i] = img.data[p]! * 0.299 + img.data[p + 1]! * 0.587 + img.data[p + 2]! * 0.114;
      }
      return downsampleLuma(full, canvas.width, canvas.height, factor);
    };

    // Comp-frame walk. Comp frames that resolve to the SAME source frame
    // (a slowed layer) contribute an identity pair — no motion between
    // identical frames, and the smoother rides through.
    const compFrames: number[] = [];
    for (let f = startFrame; f <= endFrame; f++) compFrames.push(f);
    const pairs: Array<Sim | null> = [];
    let fitted = 0;
    let prevIdx = srcIndexAt(startFrame);
    let prev = await lumaAt(prevIdx);
    for (let i = 1; i < compFrames.length; i++) {
      const idx = srcIndexAt(compFrames[i]!);
      if (idx === prevIdx) {
        pairs.push({ a: 1, b: 0, tx: 0, ty: 0 });
        fitted++;
      } else {
        const cur = await lumaAt(idx);
        const flow = computeFlow(prev.data, cur.data, prev.w, prev.h);
        const fit = fitSimilarity(flowSamplePoints(flow, scaleX, scaleY));
        pairs.push(fit);
        if (fit) fitted++;
        prev = cur;
        prevIdx = idx;
      }
      req.onProgress?.(i / (compFrames.length - 1));
    }

    const sigmaFrames = Math.max(1, (req.smoothnessSec ?? 0.5) * req.fps);
    const corrections = stabilizingCorrections(pairs, sigmaFrames);

    const keyframes = applySmoothStabilize({
      videoNodeId: req.nodeId,
      corrections,
      compFrames,
      fps: req.fps,
      sourceWidth: display.width,
      sourceHeight: display.height,
      comp: req.comp,
    });
    return { keyframes, fittedPairs: fitted, totalPairs: pairs.length };
  } finally {
    source.close();
  }
}
