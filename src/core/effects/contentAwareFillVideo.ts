/**
 * Content-Aware Fill over a video range — PatchMatch + flow propagation.
 * Results live on `fx.props.contentAwareFill` as timed PNG data-URLs; the
 * Canvas2D backend composites the nearest stamp over the layer.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { bumpScene } from '@stores/sceneStore';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf } from '@core/source/sourceInfo';
import { demuxMp4 } from '@core/video/mp4Demuxer';
import { demuxWebm, isWebmMagic } from '@core/video/webmDemuxer';
import { ExactVideoSource, webCodecsAvailable } from '@core/video/exactVideoSource';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { readNodeMaskAt, getNodeMask } from '@core/effects/mask';
import { readGeometry } from '@core/workspace/geometry';
import type { SceneNode } from '@core/types';
import { propagateFillBidirectional } from './contentAwareFill';

export interface ContentAwareFillFrame {
  t: number;
  dataUrl: string;
}

export interface ContentAwareFillStore {
  frames: ContentAwareFillFrame[];
}

export function readContentAwareFill(node: SceneNode): ContentAwareFillStore | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = fx?.props?.contentAwareFill as ContentAwareFillStore | undefined;
  if (!raw || !Array.isArray(raw.frames) || raw.frames.length === 0) return null;
  return raw;
}

export function contentAwareFillAt(node: SceneNode, t: number): string | null {
  const store = readContentAwareFill(node);
  if (!store) return null;
  let best = store.frames[0]!;
  let bestD = Math.abs(best.t - t);
  for (const fr of store.frames) {
    const d = Math.abs(fr.t - t);
    if (d < bestD) {
      best = fr;
      bestD = d;
    }
  }
  return best.dataUrl;
}

export interface ContentAwareFillRequest {
  nodeId: string;
  startCompTime: number;
  endCompTime: number;
  fps: number;
  onProgress?: (f: number) => boolean | void;
}

export interface ContentAwareFillResult {
  frames: number;
  filledPixels: number;
  status: 'completed' | 'cancelled';
}

function maskToHole(
  nodeId: string,
  t: number,
  w: number,
  h: number,
  layerW: number,
  layerH: number,
): Uint8Array {
  const node = defaultSceneGraph.getNode(nodeId);
  const mask = (node ? readNodeMaskAt(node, t) : undefined) ?? getNodeMask(nodeId);
  const hole = new Uint8Array(w * h);
  for (const path of mask.paths) {
    if (path.mode === 'none' || path.points.length < 3) continue;
    const poly = path.points.map((p) => ({
      x: (p.x / layerW + 0.5) * w,
      y: (p.y / layerH + 0.5) * h,
    }));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (pointInPoly(x + 0.5, y + 0.5, poly)) hole[y * w + x] = 255;
      }
    }
  }
  return hole;
}

function pointInPoly(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export async function runContentAwareFill(req: ContentAwareFillRequest): Promise<ContentAwareFillResult> {
  if (!webCodecsAvailable()) throw new Error('Content-Aware Fill needs WebCodecs.');
  const node = defaultSceneGraph.getNode(req.nodeId);
  const g = node ? readGeometry(node) : null;
  if (!node || !g) throw new Error('Layer is gone.');
  const assetId = assetIdOf(node);
  const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : undefined;
  if (!asset?.src) throw new Error('No video source.');

  const buf = await (await fetch(asset.src)).arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const demuxed = isWebmMagic(head) ? await demuxWebm(buf) : await demuxMp4(buf);
  const source = new ExactVideoSource(demuxed);
  const w = demuxed.codedWidth;
  const h = demuxed.codedHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    source.close();
    throw new Error('No 2D context');
  }

  const startF = Math.round(req.startCompTime * req.fps);
  const endF = Math.round(req.endCompTime * req.fps);
  let cancelled = false;
  const buffers: Uint8ClampedArray[] = [];
  const holesList: Uint8Array[] = [];
  const times: number[] = [];

  try {
    for (let f = startF; f <= endF; f++) {
      if (req.onProgress?.((f - startF) / Math.max(1, endF - startF) * 0.7) === false) {
        cancelled = true;
        break;
      }
      const compTime = f / req.fps;
      const mediaSec = Math.max(0, compToKeyframeTime(req.nodeId, compTime));
      const idx = source.frameIndexAt(Math.max(0, Math.round(mediaSec * 1e6) + 1));
      const frame = await source.frameAt(idx);
      ctx.drawImage(frame as CanvasImageSource, 0, 0);
      const img = ctx.getImageData(0, 0, w, h);
      const t = compToKeyframeTime(req.nodeId, compTime);
      const hole = maskToHole(req.nodeId, t, w, h, g.width, g.height);
      if (!hole.some((v) => v)) continue;
      buffers.push(new Uint8ClampedArray(img.data));
      holesList.push(hole);
      times.push(t);
    }

    const filled = buffers.length
      ? propagateFillBidirectional(buffers, w, h, holesList, { patchHalf: 4, iterations: 4 })
      : 0;
    req.onProgress?.(0.85);

    const outFrames: ContentAwareFillFrame[] = [];
    for (let i = 0; i < buffers.length; i++) {
      const img = ctx.createImageData(w, h);
      img.data.set(buffers[i]!);
      ctx.putImageData(img, 0, 0);
      outFrames.push({ t: times[i]!, dataUrl: canvas.toDataURL('image/png') });
    }

    const fx = node.components.find((c) => c.type === 'fx');
    if (fx) {
      defaultSceneGraph.writeProp(req.nodeId, fx.id, 'contentAwareFill', { frames: outFrames });
    }
    getEventBus().emit('AnimationChanged', { nodeId: req.nodeId });
    bumpScene();
    req.onProgress?.(1);
    return {
      frames: outFrames.length,
      filledPixels: filled,
      status: cancelled ? 'cancelled' : 'completed',
    };
  } finally {
    source.close();
  }
}
