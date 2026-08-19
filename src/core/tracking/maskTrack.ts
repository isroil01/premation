/**
 * Mask tracking — rotoscoping's first honest step: every vertex of a layer's
 * mask becomes a track point, and the tracked motion becomes mask keyframes.
 *
 * This rides the EXISTING mask-animation system (`fx.maskAnim`: an array of
 * full `MaskKeyframe` snapshots, linearly interpolated, index-paired — see
 * mask.ts), not the animation engine: masks have no PropPath and the
 * renderer reads them exclusively through `readNodeMaskAt`. One keyframe per
 * tracked comp frame is dense, but dense is what measurement produces —
 * thinning is a curve-fit pass this deliberately does not invent.
 *
 * Vertices are tracked as a party in ONE decode walk (trackVideoLayerPoints),
 * so a 20-point roto costs the same decoding as a 1-point track. Bezier
 * handles travel RIGIDLY with their vertex (same delta applied to in/out):
 * a per-vertex tracker measures translation, and pretending it measured
 * curvature would manufacture wobble. A vertex that gets lost mid-way
 * FREEZES at its last tracked position while the others continue — the
 * index-paired interpolation needs every keyframe to carry every point.
 *
 * Like every other mask write in the app, this does not create an undo
 * entry — mask state lives on scene-graph fx props, outside the animation
 * history's diff. Re-running the track overwrites the tracked range;
 * keyframes outside the range survive (the Motion Sketch splice rule).
 */

import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { readGeometry } from '@core/workspace/geometry';
import {
  readNodeMask,
  readNodeMaskAnim,
  readNodeMaskAt,
  type LayerMask,
  type MaskKeyframe,
  type MaskPoint,
} from '@core/effects/mask';
import { sourceDisplaySize } from './trackerSource';
import { trackVideoLayerPoints, type CompTrackSample } from './trackVideoLayer';

/** More vertices than this is a shape, not a set of trackable features. */
const MAX_VERTICES = 64;

export interface MaskTrackRequest {
  nodeId: string;
  startCompTime: number;
  endCompTime: number;
  fps: number;
  featureHalf: number;
  searchHalf: number;
  onProgress?: (fraction: number) => boolean | void;
}

export interface MaskTrackResult {
  /** Mask keyframes written. */
  keyframes: number;
  /** Vertices tracked across all paths. */
  vertices: number;
  status: 'completed' | 'lost' | 'cancelled';
}

interface VertexRef {
  pathIndex: number;
  pointIndex: number;
}

export async function trackLayerMask(req: MaskTrackRequest): Promise<MaskTrackResult> {
  const node = defaultSceneGraph.getNode(req.nodeId);
  if (!node) throw new Error('Layer is gone.');
  const g = readGeometry(node);
  const src = sourceDisplaySize(req.nodeId);
  if (!g || !src) throw new Error('Layer has no sized video source.');

  // The shape to track is the one VISIBLE at the start time — if the mask is
  // already animated, tracking continues from what the user sees, not from
  // the static rest shape underneath.
  const startLayerT = compToKeyframeTime(req.nodeId, req.startCompTime);
  const base: LayerMask | undefined = readNodeMaskAt(node, startLayerT) ?? readNodeMask(node);
  if (!base || base.paths.length === 0) throw new Error('Layer has no mask to track.');

  // Flatten every path's vertices into one tracking party.
  const refs: VertexRef[] = [];
  const points: Array<{ x: number; y: number }> = [];
  for (let p = 0; p < base.paths.length; p++) {
    const path = base.paths[p]!;
    for (let i = 0; i < path.points.length; i++) {
      const pt = path.points[i]!;
      refs.push({ pathIndex: p, pointIndex: i });
      // layer-local (centred) → source display px — the inverse of the
      // trackSampleToComp local step, stated once in applyTrack.ts.
      points.push({
        x: (pt.x / g.width + 0.5) * src.width,
        y: (pt.y / g.height + 0.5) * src.height,
      });
    }
  }
  if (points.length === 0) throw new Error('The mask has no points.');
  if (points.length > MAX_VERTICES) {
    throw new Error(`The mask has ${points.length} points — more than ${MAX_VERTICES} is a shape, not trackable features. Simplify it first.`);
  }

  const result = await trackVideoLayerPoints({
    nodeId: req.nodeId,
    startCompTime: req.startCompTime,
    endCompTime: req.endCompTime,
    fps: req.fps,
    points,
    featureHalf: req.featureHalf,
    searchHalf: req.searchHalf,
    ...(req.onProgress ? { onProgress: req.onProgress } : {}),
  });

  // Sample times: the union of comp times any vertex reached, in order. A
  // vertex missing at a time freezes at its last known place (see header).
  const timeSet = new Set<number>();
  for (const track of result.tracks) for (const s of track) timeSet.add(s.compTime);
  const times = [...timeSet].sort((a, b) => a - b);
  if (times.length < 2) throw new Error('Tracking produced too little motion to keyframe.');

  const byTime: Array<Map<number, CompTrackSample>> = result.tracks.map((track) => {
    const m = new Map<number, CompTrackSample>();
    for (const s of track) m.set(s.compTime, s);
    return m;
  });

  const keyframes: MaskKeyframe[] = [];
  const lastKnown: Array<{ x: number; y: number }> = points.map((p) => ({ ...p }));
  for (const compTime of times) {
    // Deep-clone the base shape and displace each vertex by its tracked delta.
    const paths = base.paths.map((path) => ({ ...path, points: path.points.map((pt) => ({ ...pt })) }));
    for (let v = 0; v < refs.length; v++) {
      const sample = byTime[v]!.get(compTime);
      const at = sample ? { x: sample.x, y: sample.y } : lastKnown[v]!;
      if (sample) lastKnown[v] = at;
      const ref = refs[v]!;
      const pt: MaskPoint = paths[ref.pathIndex]!.points[ref.pointIndex]!;
      const lx = (at.x / src.width - 0.5) * g.width;
      const ly = (at.y / src.height - 0.5) * g.height;
      const dx = lx - pt.x;
      const dy = ly - pt.y;
      pt.x += dx;
      pt.y += dy;
      pt.inX += dx;
      pt.inY += dy;
      pt.outX += dx;
      pt.outY += dy;
    }
    keyframes.push({ t: compToKeyframeTime(req.nodeId, compTime), mask: { paths } });
  }

  // Splice into any existing animation: keyframes strictly inside the
  // tracked span are replaced, the rest survive.
  const t0 = keyframes[0]!.t;
  const t1 = keyframes[keyframes.length - 1]!.t;
  const existing = readNodeMaskAnim(node).filter((k) => k.t < t0 - 1e-9 || k.t > t1 + 1e-9);
  const merged = [...existing, ...keyframes].sort((a, b) => a.t - b.t);
  defaultSceneGraph.setMaskAnim(req.nodeId, merged);
  getEventBus().emit('AnimationChanged', { nodeId: req.nodeId });
  bumpScene();

  return { keyframes: keyframes.length, vertices: points.length, status: result.status };
}
