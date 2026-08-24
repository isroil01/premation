/**
 * Scene Edit Detection's driver: a video layer in, markers or splits out.
 *
 * The same seam `trackVideoLayer` owns — comp frame → layer time → source
 * presentation index — reused verbatim, because a cut the detector finds at
 * source frame 412 has to land on the comp frame the renderer SHOWS source
 * frame 412 at, and that depends on the clip's trim, slip and stretch. Any
 * other mapping puts the marker a frame or two from the cut, which on a
 * 24 fps edit is visibly wrong.
 *
 * Only the clip's VISIBLE span is walked. The detector does not care what is
 * outside the in/out points, and neither does the editor who asked.
 *
 * Decoding goes through `SequentialFrameReader` exactly as the tracker does —
 * each source frame decoded once, closed after its luma copy. See the long
 * comment in trackVideoLayer.ts for why random-access `frameAt` was the
 * "freezes at 2%" bug on long-GOP footage.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { assetIdOf } from '@core/source/sourceInfo';
import { useAssetStore } from '@stores/assetStore';
import { compToKeyframeTime, keyframeToCompTime, getTimelineController } from '@core/timeline/TimelineController';
import { demuxMp4 } from '@core/video/mp4Demuxer';
import { demuxWebm, isWebmMagic } from '@core/video/webmDemuxer';
import { ExactVideoSource, SequentialFrameReader, webCodecsAvailable } from '@core/video/exactVideoSource';
import { bumpScene } from '@stores/sceneStore';
import type { LumaPlane } from './patchMatch';
import { lumaFromDecodedFrame, makeCanvasLumaReader } from './lumaExtract';
import { walkSceneEdits, type SceneEditOptions } from './sceneEditDetect';

export interface SceneEditRequest extends SceneEditOptions {
  nodeId: string;
  fps: number;
  /** Return false to cancel. */
  onProgress?: (fraction: number) => boolean | void;
}

export interface SceneEditResult {
  /** Comp seconds of each cut — the first frame of each new shot (dissolve midpoints included). */
  cutsCompSec: number[];
  /** The subset of `cutsCompSec` that are dissolve midpoints. */
  dissolvesCompSec: number[];
  status: 'completed' | 'cancelled';
}

/** Find the cuts in a video layer's visible span. Pure read; applies nothing. */
export async function detectSceneEdits(req: SceneEditRequest): Promise<SceneEditResult> {
  if (!webCodecsAvailable()) {
    throw new Error('Scene Edit Detection needs WebCodecs, which this runtime does not have.');
  }
  const node = defaultSceneGraph.getNode(req.nodeId);
  if (!node) throw new Error('Layer is gone.');
  const assetId = assetIdOf(node);
  const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : undefined;
  if (!asset || asset.type !== 'video') throw new Error('Layer has no video source.');

  const controller = getTimelineController();
  const layers = controller.getLayersForNode(req.nodeId);
  if (layers.length === 0) throw new Error('Layer has no clip on the timeline.');
  // The union of the node's clips. A split clip is still one piece of footage.
  const startFrame = Math.min(...layers.map((l) => l.start));
  const endFrame = Math.max(...layers.map((l) => l.end)) - 1;
  if (endFrame <= startFrame) throw new Error('The clip is too short to contain a cut.');

  // The ORIGINAL file, never the proxy: a proxy's re-encode can smear a hard
  // cut across a frame and the detector would land one frame late.
  const res = await fetch(asset.src);
  if (!res.ok) throw new Error(`Source unreadable (${res.status}).`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const demuxed = isWebmMagic(head) ? await demuxWebm(buf) : await demuxMp4(buf);
  const source = new ExactVideoSource(demuxed);

  try {
    // Comp frame → source presentation index. +1µs: the fractional-boundary
    // rule every other reader of this axis follows (see exactVideoFrames).
    const srcIndexAt = (compFrame: number): number => {
      const mediaSec = compToKeyframeTime(req.nodeId, compFrame / req.fps);
      return source.frameIndexAt(Math.max(0, Math.round(mediaSec * 1e6) + 1));
    };
    const srcFrom = srcIndexAt(startFrame);
    const srcTo = srcIndexAt(endFrame);
    if (srcTo <= srcFrom) throw new Error('The clip does not advance over its span — nothing to detect.');

    const readLuma = makeCanvasLumaReader(demuxed.codedWidth, demuxed.codedHeight);
    const toLuma = (frame: unknown): Promise<LumaPlane> =>
      lumaFromDecodedFrame(frame, demuxed.codedWidth, demuxed.codedHeight, readLuma);
    const reader = new SequentialFrameReader(demuxed, srcFrom, srcTo);
    let walk;
    try {
      walk = await walkSceneEdits({
        frameAt: async (idx) => toLuma(await reader.frameAt(idx)),
        fromFrame: srcFrom,
        toFrame: srcTo,
        sensitivity: req.sensitivity,
        floor: req.floor,
        window: req.window,
        minShotFrames: req.minShotFrames,
        onProgress: req.onProgress,
      });
    } finally {
      reader.close();
    }

    // Source frame → comp seconds, through the same chain inverted. The
    // source frame's own presentation time is what `keyframeToCompTime`
    // expects on the layer axis.
    const toComp = (srcFrame: number): number =>
      keyframeToCompTime(req.nodeId, source.timeUsOf(srcFrame) / 1e6);
    return {
      cutsCompSec: walk.cuts.map(toComp),
      dissolvesCompSec: walk.dissolveCuts.map(toComp),
      status: walk.status,
    };
  } finally {
    source.close();
  }
}

/**
 * Drop a comp marker at every cut. Markers are the non-destructive choice —
 * AE's default — and a cut you can see is a cut you can split at later.
 */
export function applySceneEditsAsMarkers(
  cutsCompSec: ReadonlyArray<number>,
  dissolvesCompSec: ReadonlyArray<number> = [],
): number {
  const c = getTimelineController();
  const fps = c.timeline.getFrameRate().fps;
  const soft = new Set(dissolvesCompSec);
  let cuts = 0, fades = 0;
  for (const sec of cutsCompSec) {
    const isFade = soft.has(sec);
    c.timeline.addMarker({
      frame: Math.round(sec * fps),
      // A dissolve is named and coloured apart from a cut: the editor split
      // it at its middle, and the marker should say so.
      name: isFade ? `Dissolve ${++fades}` : `Cut ${++cuts}`,
      color: isFade ? '#c89b3c' : '#e27d69',
      scope: 'timeline',
    });
  }
  bumpScene();
  return cuts + fades;
}

/**
 * Split the node's clip at every cut, so each shot becomes its own clip.
 * Splits are applied in ascending order on whichever clip currently covers
 * the cut — after the first split the right half is a new clip, and the next
 * cut lives inside that one.
 */
export function applySceneEditsAsSplits(nodeId: string, cutsCompSec: ReadonlyArray<number>): number {
  const c = getTimelineController();
  const fps = c.timeline.getFrameRate().fps;
  let n = 0;
  for (const sec of [...cutsCompSec].sort((a, b) => a - b)) {
    const frame = Math.round(sec * fps);
    const host = c.getLayersForNode(nodeId).find((l) => frame > l.start && frame < l.end);
    if (!host) continue;
    if (c.splitClip(host.id, sec)) n++;
  }
  bumpScene();
  return n;
}
