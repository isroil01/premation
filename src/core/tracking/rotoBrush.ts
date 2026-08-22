/**
 * Roto Brush–class matte — seed flood-fill + temporal optical-flow propagation.
 *
 * Not Adobe Roto Brush 3 / SAM (no neural net). This is the classical AE path:
 * colour-similarity seed on the exact frame, then warp the matte forward and
 * backward with the same block-flow the Pixel Motion / Smooth Stabilize stack
 * uses, with a per-frame colour re-seed so the edge can re-lock. Soft edge =
 * morphological blur of the binary matte before contour extraction.
 *
 * Output is a dense `maskAnim` on the target layer (same store mask tracking
 * writes), ready for Track Mask refinement.
 */

import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf } from '@core/source/sourceInfo';
import { demuxMp4 } from '@core/video/mp4Demuxer';
import { demuxWebm, isWebmMagic } from '@core/video/webmDemuxer';
import { ExactVideoSource, webCodecsAvailable } from '@core/video/exactVideoSource';
import { computeFlow, lumaOf, sampleFlow } from '@core/rendering/pixelMotionFlow';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import { readGeometry } from '@core/workspace/geometry';
import {
  readNodeMaskAnim,
  type LayerMask,
  type MaskKeyframe,
  type MaskPath,
  type MaskPoint,
} from '@core/effects/mask';
import { floodMatte, matteToPath, refineRotoMatte } from './rotoMatte';
import { grabCutMatte } from './grabCut';
import { sourceDisplaySize } from './trackerSource';

export interface RotoBrushRequest {
  nodeId: string;
  /** Seed in source display pixels. */
  seed: { x: number; y: number; tolerance?: number };
  startCompTime: number;
  endCompTime: number;
  fps: number;
  /** Soft-edge radius in px (box blur of the binary matte). */
  featherPx?: number;
  onProgress?: (f: number) => boolean | void;
}

export interface RotoBrushResult {
  keyframes: number;
  frames: number;
  status: 'completed' | 'cancelled';
}

function blurMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += mask[yy * w + xx]!;
          n++;
        }
      }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = tmp[i]! >= 128 ? 255 : 0;
  return out;
}

/** Apply classical Refine Edge: GrabCut polish + morph + colour snap + soft feather. */
function refineFrameMatte(
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  feather: number,
  seed?: { x: number; y: number; tolerance?: number },
): { mask: Uint8Array; feather: number } {
  // When we still have a seed, re-run GrabCut on the propagated region as FG prior.
  if (seed) {
    const gc = grabCutMatte(rgba, w, h, [seed], {
      unknownRadius: 6,
      iterations: 3,
      featherPx: feather,
    });
    // Intersect with propagated mask so GrabCut cannot jump to a new object.
    const fused = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) fused[i] = mask[i] && gc[i] ? 255 : 0;
    if (fused.some((v) => v === 255)) {
      return refineRotoMatte(rgba, fused, w, h, { morphRadius: 1, featherPx: feather, edgeTol: 28 });
    }
  }
  return refineRotoMatte(rgba, mask, w, h, { morphRadius: 1, featherPx: feather, edgeTol: 28 });
}

/** Warp a binary matte with a forward flow field (source → destination). */
export function warpMatte(
  mask: Uint8Array,
  w: number,
  h: number,
  flow: ReturnType<typeof computeFlow>,
  scaleX: number,
  scaleY: number,
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [dx, dy] = sampleFlow(flow, x / scaleX, y / scaleY);
      const sx = Math.round(x - dx * scaleX);
      const sy = Math.round(y - dy * scaleY);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
        out[y * w + x] = mask[sy * w + sx]!;
      }
    }
  }
  return out;
}

function pathFromMatte(
  mask: Uint8Array,
  w: number,
  h: number,
  layerW: number,
  layerH: number,
  feather: number,
): MaskPath {
  const pts = matteToPath(mask, w, h);
  // Source display px → layer-local centred space (same as maskTrack).
  const points: MaskPoint[] = pts.map((p) => {
    const lx = (p.x / w - 0.5) * layerW;
    const ly = (p.y / h - 0.5) * layerH;
    return { x: lx, y: ly, inX: lx, inY: ly, outX: lx, outY: ly };
  });
  return {
    id: `roto_${Date.now().toString(36)}`,
    name: 'Roto Brush',
    mode: 'add',
    closed: true,
    points: points.length >= 3 ? points : [
      { x: -layerW / 4, y: -layerH / 4, inX: -layerW / 4, inY: -layerH / 4, outX: -layerW / 4, outY: -layerH / 4 },
      { x: layerW / 4, y: -layerH / 4, inX: layerW / 4, inY: -layerH / 4, outX: layerW / 4, outY: -layerH / 4 },
      { x: layerW / 4, y: layerH / 4, inX: layerW / 4, inY: layerH / 4, outX: layerW / 4, outY: layerH / 4 },
      { x: -layerW / 4, y: layerH / 4, inX: -layerW / 4, inY: layerH / 4, outX: -layerW / 4, outY: layerH / 4 },
    ],
    feather,
    opacity: 1,
    expansion: 0,
    inverted: false,
  };
}

async function loadExactSource(nodeId: string): Promise<{
  source: ExactVideoSource;
  width: number;
  height: number;
}> {
  if (!webCodecsAvailable()) throw new Error('Roto Brush needs WebCodecs.');
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) throw new Error('Layer is gone.');
  const assetId = assetIdOf(node);
  const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : undefined;
  if (!asset?.src) throw new Error('No video source on this layer.');
  const res = await fetch(asset.src);
  if (!res.ok) throw new Error(`Could not load footage (${res.status}).`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const demuxed = isWebmMagic(head) ? await demuxWebm(buf) : await demuxMp4(buf);
  return {
    source: new ExactVideoSource(demuxed),
    width: demuxed.codedWidth,
    height: demuxed.codedHeight,
  };
}

function mediaTimeAt(nodeId: string, compTime: number): number {
  // Clip remapping via keyframe time axis — source seconds ≈ layer media clock.
  return Math.max(0, compToKeyframeTime(nodeId, compTime));
}

/**
 * Run Roto Brush over a time range and write maskAnim keyframes.
 */
export async function runRotoBrush(req: RotoBrushRequest): Promise<RotoBrushResult> {
  const node = defaultSceneGraph.getNode(req.nodeId);
  const g = node ? readGeometry(node) : null;
  const display = sourceDisplaySize(req.nodeId);
  if (!node || !g || !display) throw new Error('Layer has no sized video source.');

  const { source, width, height } = await loadExactSource(req.nodeId);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    source.close();
    throw new Error('No 2D context for roto readback.');
  }

  const startF = Math.round(req.startCompTime * req.fps);
  const endF = Math.round(req.endCompTime * req.fps);
  const frames: number[] = [];
  for (let f = startF; f <= endF; f++) frames.push(f);
  if (frames.length === 0) {
    source.close();
    return { keyframes: 0, frames: 0, status: 'completed' };
  }

  const scaleX = display.width / width;
  const scaleY = display.height / height;
  const feather = req.featherPx ?? 2;
  const tol = req.seed.tolerance ?? 36;

  const readRgba = async (compFrame: number): Promise<Uint8ClampedArray> => {
    const mediaSec = mediaTimeAt(req.nodeId, compFrame / req.fps);
    const idx = source.frameIndexAt(Math.max(0, Math.round(mediaSec * 1e6) + 1));
    const frame = await source.frameAt(idx);
    ctx.drawImage(frame as CanvasImageSource, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  };

  try {
    // Seed frame — GrabCut-class from click, then refine.
    const seedRgba = await readRgba(frames[0]!);
    const seedX = req.seed.x / scaleX;
    const seedY = req.seed.y / scaleY;
    const seed = { x: seedX, y: seedY, tolerance: tol };
    let mask = grabCutMatte(seedRgba, width, height, [seed], {
      unknownRadius: 8,
      iterations: 5,
      featherPx: feather,
    });
    {
      const refined = refineFrameMatte(seedRgba, mask, width, height, feather, seed);
      mask = refined.mask;
    }

    const keyframes: MaskKeyframe[] = [];
    let prevLuma = lumaOf(seedRgba, width, height);
    let cancelled = false;

    for (let i = 0; i < frames.length; i++) {
      if (req.onProgress?.(i / Math.max(1, frames.length - 1)) === false) {
        cancelled = true;
        break;
      }
      const compTime = frames[i]! / req.fps;
      const t = compToKeyframeTime(req.nodeId, compTime);
      const soft = blurMask(mask, width, height, feather);
      const path = pathFromMatte(soft, width, height, g.width, g.height, feather);
      const layerMask: LayerMask = { paths: [path] };
      keyframes.push({ t, mask: layerMask });

      if (i + 1 >= frames.length) break;
      const nextRgba = await readRgba(frames[i + 1]!);
      const nextLuma = lumaOf(nextRgba, width, height);
      const flow = computeFlow(prevLuma, nextLuma, width, height, { step: 8 });
      // Propagate matte with flow, then colour-reseed near the previous centroid.
      mask = warpMatte(mask, width, height, flow, 1, 1);
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
          if (mask[y * width + x]) {
            cx += x;
            cy += y;
            n++;
          }
        }
      }
      if (n > 0) {
        cx /= n;
        cy /= n;
        const reseed = floodMatte(nextRgba, width, height, [{ x: cx, y: cy, tolerance: tol }]);
        // Union: keep propagated OR reseed so holes heal.
        for (let p = 0; p < mask.length; p++) {
          if (reseed[p]) mask[p] = 255;
        }
      }
      const refined = refineFrameMatte(nextRgba, mask, width, height, feather, { x: cx, y: cy, tolerance: tol });
      mask = refined.mask;
      prevLuma = nextLuma;
    }

    // Splice into existing maskAnim (outside tracked range survives).
    const existing = readNodeMaskAnim(node) ?? [];
    const t0 = keyframes[0]?.t ?? 0;
    const t1 = keyframes[keyframes.length - 1]?.t ?? t0;
    const kept = existing.filter((k) => k.t < t0 - 1e-6 || k.t > t1 + 1e-6);
    const merged = [...kept, ...keyframes].sort((a, b) => a.t - b.t);
    defaultSceneGraph.setMaskAnim(req.nodeId, merged);
    // Also set static mask to the first frame so the layer shows something immediately.
    if (keyframes[0]) defaultSceneGraph.setMask(req.nodeId, keyframes[0].mask);
    getEventBus().emit('AnimationChanged', { nodeId: req.nodeId });
    bumpScene();
    getTimelineController(); // touch controller so UI refreshes timelines
    return {
      keyframes: keyframes.length,
      frames: frames.length,
      status: cancelled ? 'cancelled' : 'completed',
    };
  } finally {
    source.close();
  }
}
