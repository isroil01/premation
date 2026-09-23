/**
 * Roto Brush TOOL glue — turns the strokes painted on the viewport
 * (`rotoBrushStore`) into a matte on the layer, and hands "propagate
 * forward" to the tracker's `runRotoBrush`.
 *
 * ## What belongs here and what does not
 *
 * The segmentation is `core/tracking/samSegment.ts` (SAM when a session is
 * registered, the classical GrabCut / flood matte otherwise) and the
 * propagation is `core/tracking/rotoBrush.ts`. This file only converts
 * coordinates, reads the layer's source pixels and writes the resulting
 * path — the three things the tool needs that neither module does. Both the
 * pixel reader and the segmenter are injectable so the stroke→mask contract
 * is testable without a video decoder.
 *
 * ## Spaces
 *
 *   stroke points   layer-local px, centre origin (the mask path's space)
 *   segmenter       source pixels, top-left origin, at the source's own size
 *   mask path       layer-local px, centre origin — what `matteToPath` maps
 *                   back to, exactly as `rotoBrush.pathFromMatte` does
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readGeometry } from '@core/workspace/geometry';
import { getNodeMask, type MaskPath, type MaskPoint } from '@core/effects/mask';
import { segmentSam, type SamPointPrompt, type SamSegmentRequest, type SamSegmentResult } from '@core/tracking/samSegment';
import { matteToPath } from '@core/tracking/rotoMatte';
import { runRotoBrush, type RotoBrushResult } from '@core/tracking/rotoBrush';
import { sourceDisplaySize } from '@core/tracking/trackerSource';
import { assetIdOf } from '@core/source/sourceInfo';
import { useAssetStore } from '@stores/assetStore';
import { bumpScene } from '@stores/sceneStore';
import { getEventBus } from '@core/events/EventBus';
import type { RotoStroke } from '@stores/rotoBrushStore';

/** The name every path this tool writes carries, so a re-segment replaces it. */
export const ROTO_PATH_NAME = 'Roto Brush';

export interface LayerPixels {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export type Segmenter = (req: SamSegmentRequest) => Promise<SamSegmentResult>;

/**
 * Stroke points → segmenter prompts in SOURCE pixels. Every point of a stroke
 * is a prompt: a stroke is how a brush says "all of this", and the classical
 * segmenter seeds a flood from each one.
 */
export function strokesToPrompts(
  strokes: readonly RotoStroke[],
  layer: { width: number; height: number },
  source: { width: number; height: number },
): SamPointPrompt[] {
  const out: SamPointPrompt[] = [];
  const sx = source.width / Math.max(1, layer.width);
  const sy = source.height / Math.max(1, layer.height);
  for (const s of strokes) {
    // Thin dense strokes to at most ~24 prompts each — the segmenter's cost
    // is per seed, and a slow drag records hundreds of near-identical points.
    const step = Math.max(1, Math.ceil(s.points.length / 24));
    for (let i = 0; i < s.points.length; i += step) {
      const p = s.points[i]!;
      const x = (p.x + layer.width / 2) * sx;
      const y = (p.y + layer.height / 2) * sy;
      if (x < 0 || y < 0 || x >= source.width || y >= source.height) continue;
      out.push({ x, y, label: s.kind === 'fg' ? 1 : 0 });
    }
  }
  return out;
}

/** A matte in source pixels → a closed mask path in layer-local px. */
export function matteToLayerPath(
  mask: Uint8Array,
  source: { width: number; height: number },
  layer: { width: number; height: number },
  featherPx: number,
  id?: string,
): MaskPath | null {
  const pts = matteToPath(mask, source.width, source.height);
  if (pts.length < 3) return null;
  const points: MaskPoint[] = pts.map((p) => {
    const lx = (p.x / source.width - 0.5) * layer.width;
    const ly = (p.y / source.height - 0.5) * layer.height;
    return { x: lx, y: ly, inX: lx, inY: ly, outX: lx, outY: ly };
  });
  return {
    id: id ?? `roto_${Date.now().toString(36)}`,
    name: ROTO_PATH_NAME,
    mode: 'add',
    closed: true,
    points,
    feather: featherPx,
    opacity: 1,
    expansion: 0,
    inverted: false,
  };
}

/**
 * Read the layer's source pixels at `timeSec` (comp time) by drawing its
 * asset into a canvas: an image directly, a video seeked to the layer's
 * media time. The exact WebCodecs path is what propagation uses; for the
 * single frame a brush stroke needs, the element's own decode is enough.
 */
export async function readLayerPixels(nodeId: string, timeSec: number): Promise<LayerPixels | null> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const size = sourceDisplaySize(nodeId);
  if (!size) return null;
  const assetId = assetIdOf(node);
  const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : undefined;
  if (!asset?.src) return null;

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  if (asset.type === 'video') {
    const video = document.createElement('video');
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.src = asset.src;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Could not load the video for roto.'));
    });
    const { compToKeyframeTime } = await import('@core/timeline/TimelineController');
    const mediaT = Math.max(0, compToKeyframeTime(nodeId, timeSec));
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      try { video.currentTime = mediaT; } catch { resolve(); }
    });
    ctx.drawImage(video, 0, 0, size.width, size.height);
  } else {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = asset.src;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not load the image for roto.'));
    });
    ctx.drawImage(img, 0, 0, size.width, size.height);
  }
  return { rgba: ctx.getImageData(0, 0, size.width, size.height).data, width: size.width, height: size.height };
}

export interface SegmentStrokesOptions {
  featherPx?: number;
  /** Replace this path id if it is still on the layer. */
  replacePathId?: string | null;
  readPixels?: (nodeId: string, timeSec: number) => Promise<LayerPixels | null>;
  segment?: Segmenter;
}

/**
 * Segment from the strokes and write the matte as the layer's roto mask
 * path (replacing the tool's previous path). Resolves to the written path's
 * id, or null when nothing usable came back.
 */
export async function segmentStrokesToMask(
  nodeId: string,
  strokes: readonly RotoStroke[],
  timeSec: number,
  opts: SegmentStrokesOptions = {},
): Promise<string | null> {
  const node = defaultSceneGraph.getNode(nodeId);
  const g = node ? readGeometry(node) : null;
  if (!node || !g) return null;
  if (!strokes.some((s) => s.kind === 'fg' && s.points.length > 0)) return null;

  const pixels = await (opts.readPixels ?? readLayerPixels)(nodeId, timeSec);
  if (!pixels) return null;
  const layer = { width: g.width, height: g.height };
  const source = { width: pixels.width, height: pixels.height };
  const points = strokesToPrompts(strokes, layer, source);
  if (points.length === 0) return null;
  const feather = opts.featherPx ?? 2;
  const result = await (opts.segment ?? segmentSam)({
    rgba: pixels.rgba, width: pixels.width, height: pixels.height, points, featherPx: feather,
  });
  const path = matteToLayerPath(result.mask, source, layer, feather, opts.replacePathId ?? undefined);
  if (!path) return null;

  const existing = getNodeMask(nodeId);
  const kept = existing.paths.filter((p) => p.id !== opts.replacePathId && p.name !== ROTO_PATH_NAME);
  // B3-legacy: engine gap — `addMask` carries no feather / opacity /
  // expansion and assigns its own id, while the Roto Brush reuses the path id
  // it replaces (`replacePathId`) and a follow-up feather write would need the
  // new id inside the same entry.
  defaultSceneGraph.setMask(nodeId, { paths: [...kept, path] });
  getEventBus().emit('AnimationChanged', { nodeId });
  bumpScene();
  return path.id;
}

/**
 * Propagate the matte forward from `fromSec` to `toSec` with the tracker,
 * seeded at the first foreground stroke's first point (source pixels).
 */
export function propagateRotoForward(
  nodeId: string,
  strokes: readonly RotoStroke[],
  fromSec: number,
  toSec: number,
  fps: number,
  featherPx: number,
  onProgress?: (f: number) => boolean | void,
): Promise<RotoBrushResult> {
  const node = defaultSceneGraph.getNode(nodeId);
  const g = node ? readGeometry(node) : null;
  const size = sourceDisplaySize(nodeId);
  if (!node || !g || !size) return Promise.reject(new Error('Layer has no sized video source.'));
  const fg = strokes.find((s) => s.kind === 'fg' && s.points.length > 0);
  const p0 = fg?.points[0];
  if (!p0) return Promise.reject(new Error('Paint a foreground stroke first.'));
  const seed = {
    x: (p0.x / Math.max(1, g.width) + 0.5) * size.width,
    y: (p0.y / Math.max(1, g.height) + 0.5) * size.height,
  };
  return runRotoBrush({
    nodeId, seed, startCompTime: fromSec, endCompTime: toSec, fps, featherPx,
    ...(onProgress ? { onProgress } : {}),
  });
}
