/**
 * Track Motion's driver: comp frames in, tracked comp-time samples out.
 *
 * The tracker core (tracker.ts) walks SOURCE frames; the timeline thinks in
 * COMP frames; and one comp frame maps to one source frame through the
 * layer's clip (trim/slip), stretch and remap. This module owns that seam:
 *
 *   comp frame → compToKeyframeTime(videoNode) → media seconds
 *             → ExactVideoSource.frameIndexAt  → presentation frame index
 *
 * `compToKeyframeTime` is the SAME axis every keyframe write in the app uses
 * (moveNodes, expression bake), so the frame the tracker matched is the frame
 * the renderer shows at that comp time — the whole point of tracking on the
 * exact decoder rather than a seeked <video> element.
 *
 * A comp range can hit each source frame more than once (freeze frames, slow
 * stretch) — the walk runs over the DISTINCT source-frame span once, and comp
 * samples are read out of it, so a 50%-stretched clip does not decode (or
 * match) every frame twice.
 *
 * Decoding pulls frames strictly one at a time through ExactVideoSource, so
 * its GOP cache absorbs the sequential access and memory stays flat on long
 * clips. Luma extraction goes through ONE reused canvas.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { assetIdOf } from '@core/source/sourceInfo';
import { useAssetStore } from '@stores/assetStore';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { demuxMp4 } from '@core/video/mp4Demuxer';
import { ExactVideoSource, webCodecsAvailable } from '@core/video/exactVideoSource';
import { lumaFromRGBA, type LumaPlane } from './patchMatch';
import { trackPoints, type TrackSample } from './tracker';
import { sourceDisplaySize } from './trackerSource';

export interface CompTrackSample {
  /** Comp seconds — where the playhead is when this sample applies. */
  compTime: number;
  /** Feature centre in source DISPLAY pixels (see trackerSource.ts). */
  x: number;
  y: number;
  confidence: number;
  coasted: boolean;
}

export interface VideoTrackRequest {
  nodeId: string;
  /** Comp-time range to track, inclusive, in seconds. */
  startCompTime: number;
  endCompTime: number;
  fps: number;
  /** Feature centre in source DISPLAY px at the START comp time (the grid
   *  `sourceDisplaySize` reports — see trackerSource.ts). */
  startX: number;
  startY: number;
  featureHalf: number;
  searchHalf: number;
  /** Return false to cancel. */
  onProgress?: (fraction: number) => boolean | void;
}

export interface VideoTrackResult {
  samples: CompTrackSample[];
  sourceWidth: number;
  sourceHeight: number;
  status: 'completed' | 'lost' | 'cancelled';
}

export interface MultiVideoTrackRequest extends Omit<VideoTrackRequest, 'startX' | 'startY'> {
  /** Feature centres in source DISPLAY px at the START comp time. */
  points: ReadonlyArray<{ x: number; y: number }>;
}

export interface MultiVideoTrackResult {
  /** One comp-sample list per input point, same order. */
  tracks: CompTrackSample[][];
  sourceWidth: number;
  sourceHeight: number;
  status: 'completed' | 'lost' | 'cancelled';
}

/** Draw a decoded frame once and hand back its luma. One canvas, reused. */
function makeLumaReader(width: number, height: number): (frame: CanvasImageSource) => LumaPlane {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return (frame) => {
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(frame, 0, 0, width, height);
    const img = ctx.getImageData(0, 0, width, height);
    return lumaFromRGBA(img.data, width, height);
  };
}

export async function trackVideoLayerPoints(req: MultiVideoTrackRequest): Promise<MultiVideoTrackResult> {
  if (!webCodecsAvailable()) {
    throw new Error('Tracking needs WebCodecs, which this runtime does not have.');
  }
  const node = defaultSceneGraph.getNode(req.nodeId);
  if (!node) throw new Error('Layer is gone.');
  const assetId = assetIdOf(node);
  const asset = assetId
    ? useAssetStore.getState().assets.find((a) => a.id === assetId)
    : undefined;
  if (!asset || asset.type !== 'video') throw new Error('Layer has no video source.');

  // Always the ORIGINAL file, never the proxy: a proxy is quarter-resolution,
  // and a tracker that silently returns quarter-precision positions while the
  // proxy switch is on is the "proxy silently in use" bug all over again.
  const res = await fetch(asset.src);
  if (!res.ok) throw new Error(`Source unreadable (${res.status}).`);
  const demuxed = await demuxMp4(await res.arrayBuffer());
  const source = new ExactVideoSource(demuxed);

  try {
    const startFrame = Math.round(req.startCompTime * req.fps);
    const endFrame = Math.round(req.endCompTime * req.fps);
    if (endFrame <= startFrame) throw new Error('Nothing after the playhead to track.');

    // Comp frame → source presentation index, through the layer's own time
    // chain. +1µs for the fractional-boundary rule (see exactVideoFrames).
    const srcIndexAt = (compFrame: number): number => {
      const mediaSec = compToKeyframeTime(req.nodeId, compFrame / req.fps);
      return source.frameIndexAt(Math.max(0, Math.round(mediaSec * 1e6) + 1));
    };
    const compFrames: number[] = [];
    const srcOfComp: number[] = [];
    for (let f = startFrame; f <= endFrame; f++) {
      compFrames.push(f);
      srcOfComp.push(srcIndexAt(f));
    }
    const srcFrom = srcOfComp[0]!;
    const srcTo = srcOfComp[srcOfComp.length - 1]!;
    if (srcTo === srcFrom) {
      throw new Error('The clip does not advance over this range — nothing to track.');
    }

    // Display grid (what the request and the samples speak) ↔ coded grid
    // (what the decoder hands the matcher). See trackerSource.ts.
    const display = sourceDisplaySize(req.nodeId) ?? {
      width: demuxed.codedWidth,
      height: demuxed.codedHeight,
    };
    const toCodedX = demuxed.codedWidth / display.width;
    const toCodedY = demuxed.codedHeight / display.height;

    const readLuma = makeLumaReader(demuxed.codedWidth, demuxed.codedHeight);
    const result = await trackPoints({
      frameAt: async (idx) => readLuma((await source.frameAt(idx)) as unknown as CanvasImageSource),
      fromFrame: srcFrom,
      toFrame: srcTo,
      points: req.points.map((p) => ({ x: p.x * toCodedX, y: p.y * toCodedY })),
      featureHalf: req.featureHalf,
      searchHalf: req.searchHalf,
      onProgress: (done, total) => req.onProgress?.(done / total),
    });

    // Read the comp samples out of the source-frame walk. A comp frame whose
    // source frame the walk never reached (lost/cancelled early) is dropped —
    // a keyframe with no measurement behind it is not a keyframe.
    const tracks: CompTrackSample[][] = result.tracks.map((trackSamples) => {
      const byFrame = new Map<number, TrackSample>();
      for (const s of trackSamples) byFrame.set(s.frame, s);
      const samples: CompTrackSample[] = [];
      for (let i = 0; i < compFrames.length; i++) {
        const s = byFrame.get(srcOfComp[i]!);
        if (!s) continue;
        samples.push({
          compTime: compFrames[i]! / req.fps,
          x: s.x / toCodedX,
          y: s.y / toCodedY,
          confidence: s.confidence,
          coasted: s.coasted,
        });
      }
      return samples;
    });
    return {
      tracks,
      sourceWidth: display.width,
      sourceHeight: display.height,
      status: result.status,
    };
  } finally {
    source.close();
  }
}

/** One point — the multi-point drive with a party of one. */
export async function trackVideoLayer(req: VideoTrackRequest): Promise<VideoTrackResult> {
  const { startX, startY, ...rest } = req;
  const r = await trackVideoLayerPoints({ ...rest, points: [{ x: startX, y: startY }] });
  return {
    samples: r.tracks[0] ?? [],
    sourceWidth: r.sourceWidth,
    sourceHeight: r.sourceHeight,
    status: r.status,
  };
}
