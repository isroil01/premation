/**
 * Apply Motion Track: tracked source-pixel samples → position keyframes on a
 * target layer, as ONE undo step.
 *
 * The space chain, frame by frame (each sample at its own comp time, because
 * the video layer's transform may itself be animated):
 *
 *   source px  → video-layer local   (content is CENTRED on the local origin,
 *                                     so local = (px/srcSize − 0.5) × layer box)
 *              → comp px             (layerSpaceAt(video).toComp — parent
 *                                     chain, animation, 3D all included)
 *              → target PARENT space (the space a layer's x/y is expressed in;
 *                                     comp space when unparented)
 *
 * The parent-space step goes through the PARENT's layerSpaceAt, not the
 * target's — converting through the target's own space would fold the
 * target's current transform into the answer and the applied motion would be
 * offset by wherever the target happened to be.
 *
 * Keyframe times go through `compToKeyframeTime(target)` — the only axis the
 * engine samples — and the write splices into existing tracks the way Motion
 * Sketch does: keyframes outside the tracked span survive.
 *
 * Coasted samples (occlusion predictions) are written too: dropping them
 * would leave a hole the interpolator fills with a straight line anyway, and
 * the prediction IS the best straight line available. They are honest data
 * with a flag, not fabrications.
 */

import { defaultAnimation, type Keyframe } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { spliceRecordedRange } from '@core/animation/motionSketch';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { layerSpaceAt } from '@core/scene/layerSpace';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { readGeometry } from '@core/workspace/geometry';
import type { CompTrackSample } from './trackVideoLayer';

export interface ApplyTrackOptions {
  /** The tracked video layer — the space the samples were measured in. */
  videoNodeId: string;
  /** The layer that receives position keyframes. May be the video layer
   *  itself (stabilize-adjacent) or any other layer (AE's usual target). */
  targetNodeId: string;
  samples: readonly CompTrackSample[];
  /** Source plane size the samples were tracked in. */
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}

/** Source px at one comp time → comp px, through the video layer's live
 *  transform. Exported for the overlay, which draws the same point. */
export function trackSampleToComp(
  videoNodeId: string,
  x: number,
  y: number,
  compTime: number,
  sourceWidth: number,
  sourceHeight: number,
  comp: { width: number; height: number; rootId?: string },
): { x: number; y: number } | null {
  const node = defaultSceneGraph.getNode(videoNodeId);
  if (!node || sourceWidth <= 0 || sourceHeight <= 0) return null;
  const g = readGeometry(node);
  const space = layerSpaceAt(videoNodeId, compTime, comp);
  if (!g || !space) return null;
  const lx = (x / sourceWidth - 0.5) * g.width;
  const ly = (y / sourceHeight - 0.5) * g.height;
  const [cx, cy] = space.toComp([lx, ly]);
  return { x: cx, y: cy };
}

/**
 * Write the track as x/y keyframes on the target. Returns the number of
 * keyframes written per axis (0 = nothing usable, nothing written).
 */
export function applyTrackToLayer(opts: ApplyTrackOptions): number {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || opts.samples.length === 0) return 0;

  const parentId = target.parent ?? null;

  const xKfs: Keyframe[] = [];
  const yKfs: Keyframe[] = [];
  for (const s of opts.samples) {
    const compPt = trackSampleToComp(
      opts.videoNodeId, s.x, s.y, s.compTime, opts.sourceWidth, opts.sourceHeight, opts.comp,
    );
    if (!compPt) continue;
    let px = compPt.x;
    let py = compPt.y;
    if (parentId) {
      const parentSpace = layerSpaceAt(parentId, s.compTime, opts.comp);
      if (!parentSpace) continue;
      [px, py] = parentSpace.fromComp([compPt.x, compPt.y]);
    }
    const t = compToKeyframeTime(opts.targetNodeId, s.compTime);
    xKfs.push({ t, value: px, easing: 'linear' });
    yKfs.push({ t, value: py, easing: 'linear' });
  }
  if (xKfs.length === 0) return 0;

  const existingOf = (prop: string): readonly Keyframe[] =>
    defaultAnimation.tracksFor(opts.targetNodeId).find((tr) => tr.prop === prop)?.keyframes ?? [];

  runAnimEdit('Apply Motion Track', () => {
    defaultAnimation.batch(() => {
      defaultAnimation.setKeyframes(opts.targetNodeId, 'x', spliceRecordedRange(existingOf('x'), xKfs));
      defaultAnimation.setKeyframes(opts.targetNodeId, 'y', spliceRecordedRange(existingOf('y'), yKfs));
    });
  });
  return xKfs.length;
}
