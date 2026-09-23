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
 * Plans carry COMPOSITION times; the writer converts to the target's keyframe
 * axis (the engine API does it per layer) and splices into existing tracks the
 * way Motion Sketch does: keyframes outside the tracked span survive.
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
import { readNodeKind } from '@core/scene/sceneDerive';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { readGeometry } from '@core/workspace/geometry';
import { addEffect, getNodeEffects, effectPropPath } from '@core/effects/effects';
import type { SceneNode } from '@core/types';
import { fitHomography, projectHomography } from '@motion/renderer';
import { Project3D } from '@motion/scene';
import { flattenComposition } from '@core/scene/sceneDerive';
import { fitHomographyRansac, smoothHomographySequence } from './planarFit';
import { solvePlanarPose, unwrapDegrees, type PlanarPose } from './planarPose';
import { solveSfmCameraPath } from './sfmCamera';
import type { CompTrackSample } from './trackVideoLayer';
import { applySim, simRotation, simScale, type Sim } from './globalMotion';
import { sampleSubspace, type SubspaceCell } from './subspaceWarp';

// ── Plans (B3z) ─────────────────────────────────────────────────────────────
//
// Tracking is ANALYSIS; its result is keyframes. Every apply below is a PLAN —
// pure data, nothing written: per legacy track (`x`, `rotation`, `poiX`, an
// effect param…) the keys at COMPOSITION seconds, spliced into the existing
// track the Motion Sketch way (keys inside the tracked span replaced, keys
// outside kept). The Track Motion section sends a plan through the engine API
// as one undo entry (layout/Inspector/trackMotion/trackApplyEdits.ts); the
// dense stabilizer (smoothStabilize.ts) still writes its plans with
// `writeTrackPlanLegacy` until it moves onto the API with the other jobs.

/** Keys for one legacy track, at composition seconds. */
export interface TrackWrite {
  track: string;
  keys: Array<{ compTime: number; value: number }>;
}

export interface TrackPlan {
  /** The undo entry's name. */
  label: string;
  /** The layer that receives the keys. */
  layer: string;
  /** Plain tracks, or — with `effectType` — param keys of that effect. */
  writes: TrackWrite[];
  /** The writes are params of the target's first effect of this type (added when it has none). */
  effectType?: string;
  /** What the apply reports (keyframes written per axis, points planned…). */
  count: number;
}

/** A plan's first-key-to-last-key splice, written straight to the animation engine (pre-API writer). */
export function writeTrackPlanLegacy(plan: TrackPlan, effectIdHint = 'fx_track'): number {
  let effectId: string | undefined;
  if (plan.effectType) {
    effectId = getNodeEffects(plan.layer).find((e) => e.type === plan.effectType)?.id;
    if (!effectId) {
      addEffect(plan.layer, plan.effectType as Parameters<typeof addEffect>[1], `${effectIdHint}_${Math.random().toString(36).slice(2, 8)}`);
      effectId = getNodeEffects(plan.layer).find((e) => e.type === plan.effectType)?.id;
      if (!effectId) return 0;
    }
  }
  const existingOf = (prop: string): readonly Keyframe[] =>
    defaultAnimation.tracksFor(plan.layer).find((tr) => tr.prop === prop)?.keyframes ?? [];
  runAnimEdit(plan.label, () => {
    defaultAnimation.batch(() => {
      for (const w of plan.writes) {
        if (w.keys.length === 0) continue;
        const prop = effectId ? effectPropPath(effectId, w.track) : w.track;
        const kfs: Keyframe[] = w.keys.map((k) => ({ t: compToKeyframeTime(plan.layer, k.compTime), value: k.value, easing: 'linear' }));
        defaultAnimation.setKeyframes(plan.layer, prop, spliceRecordedRange(existingOf(prop), kfs));
      }
    });
  });
  return plan.count;
}

/** Keys helper: one list per track name, in insertion order. */
function trackBuckets(names: readonly string[]): { add: (track: string, compTime: number, value: number) => void; writes: () => TrackWrite[] } {
  const map = new Map<string, TrackWrite>(names.map((n) => [n, { track: n, keys: [] }]));
  return {
    add: (track, compTime, value) => {
      let w = map.get(track);
      if (!w) {
        w = { track, keys: [] };
        map.set(track, w);
      }
      w.keys.push({ compTime, value });
    },
    writes: () => [...map.values()].filter((w) => w.keys.length > 0),
  };
}

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
 * The track as x/y keyframes on the target (count = keyframes per axis; null =
 * nothing usable).
 */
export function planTrackToLayer(opts: ApplyTrackOptions): TrackPlan | null {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || opts.samples.length === 0) return null;

  const parentId = target.parent ?? null;
  const b = trackBuckets(['x', 'y']);
  let n = 0;
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
    b.add('x', s.compTime, px);
    b.add('y', s.compTime, py);
    n++;
  }
  if (n === 0) return null;
  return { label: 'Apply Motion Track', layer: opts.targetNodeId, writes: b.writes(), count: n };
}

export interface StabilizeOptions {
  videoNodeId: string;
  samples: readonly CompTrackSample[];
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}

/**
 * Stabilize: move the VIDEO layer so the tracked feature stays where it was
 * at the first sample — AE's Stabilize Motion, position only.
 *
 * Per sample: the feature's comp position P(t) is measured through the
 * layer's ORIGINAL transform (all deltas are planned before anything is
 * written, the planExpressionBake discipline — writing as you go would make
 * later samples measure a transform this function is mid-way through
 * changing). The correction is P(t₀) − P(t) as a PARENT-space delta —
 * converted by differencing two `fromComp` points, so a rotated or scaled
 * parent bends the delta correctly — added to the layer's own sampled
 * position at that time, so stabilizing footage that already has position
 * animation composes instead of overwriting it.
 */
export function planStabilize(opts: StabilizeOptions): TrackPlan | null {
  const node = defaultSceneGraph.getNode(opts.videoNodeId);
  if (!node || opts.samples.length === 0) return null;
  const g = readGeometry(node);
  if (!g) return null;
  const parentId = node.parent ?? null;

  const first = opts.samples[0]!;
  const p0 = trackSampleToComp(
    opts.videoNodeId, first.x, first.y, first.compTime, opts.sourceWidth, opts.sourceHeight, opts.comp,
  );
  if (!p0) return null;

  // Plan everything against the original transform, then write once.
  const b = trackBuckets(['x', 'y']);
  let n = 0;
  for (const s of opts.samples) {
    const p = trackSampleToComp(
      opts.videoNodeId, s.x, s.y, s.compTime, opts.sourceWidth, opts.sourceHeight, opts.comp,
    );
    if (!p) continue;
    let dx = p0.x - p.x;
    let dy = p0.y - p.y;
    if (parentId) {
      const parentSpace = layerSpaceAt(parentId, s.compTime, opts.comp);
      if (!parentSpace) continue;
      const a = parentSpace.fromComp([p0.x, p0.y]);
      const c = parentSpace.fromComp([p.x, p.y]);
      dx = a[0] - c[0];
      dy = a[1] - c[1];
    }
    const t = compToKeyframeTime(opts.videoNodeId, s.compTime);
    const baseX = defaultAnimation.sample(opts.videoNodeId, 'x', t) ?? g.x;
    const baseY = defaultAnimation.sample(opts.videoNodeId, 'y', t) ?? g.y;
    b.add('x', s.compTime, baseX + dx);
    b.add('y', s.compTime, baseY + dy);
    n++;
  }
  if (n === 0) return null;
  return { label: 'Stabilize Motion', layer: opts.videoNodeId, writes: b.writes(), count: n };
}

export interface TransformTrackOptions {
  /** The tracked video layer — the space the samples were measured in. */
  videoNodeId: string;
  /** The layer that receives position/rotation/scale keyframes. */
  targetNodeId: string;
  /** Two tracks: [anchor, reference]. The anchor drives position; the
   *  anchor→reference vector drives rotation and scale. */
  tracks: ReadonlyArray<readonly CompTrackSample[]>;
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
  /** Write rotation keyframes (default true). */
  rotation?: boolean;
  /** Write scale keyframes (default true). */
  scale?: boolean;
}

/**
 * Two-point solve: position from the anchor point, rotation and scale from
 * the anchor→reference vector — AE's Track Motion with the Rotation and
 * Scale boxes ticked.
 *
 * Everything is measured in the TARGET'S PARENT space (comp space when
 * unparented): the angle of the vector, its length ratio against the first
 * frame, and the anchor position. Measuring in comp space and writing into
 * a rotated parent would double-count the parent's rotation.
 *
 * Rotation is UNWRAPPED across samples (each delta is brought within ±180°
 * of the previous frame's) — atan2 alone would snap 179°→−179° and the
 * interpolator would spin the layer the wrong way round through the cut.
 *
 * Rotation and scale are DELTAS composed onto the target's own sampled
 * base at each time, like stabilize composes position — a target that
 * already rotates keeps its animation plus the tracked motion.
 *
 * Frames where either track lacks a sample are skipped for all five
 * params — position keyframes without matching rotation keyframes would
 * shear the motion apart at the exact frames where tracking was weakest.
 */
export function planTransformTrack(opts: TransformTrackOptions): TrackPlan | null {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || opts.tracks.length !== 2) return null;
  const g = readGeometry(target);
  if (!g) return null;
  const wantRotation = opts.rotation ?? true;
  const wantScale = opts.scale ?? true;
  const parentId = target.parent ?? null;

  // Index the reference track by time; walk the anchor track.
  const refByTime = new Map<number, CompTrackSample>();
  for (const s of opts.tracks[1]!) refByTime.set(s.compTime, s);

  const toParent = (x: number, y: number, compTime: number): [number, number] | null => {
    const c = trackSampleToComp(opts.videoNodeId, x, y, compTime, opts.sourceWidth, opts.sourceHeight, opts.comp);
    if (!c) return null;
    if (!parentId) return [c.x, c.y];
    const space = layerSpaceAt(parentId, compTime, opts.comp);
    return space ? space.fromComp([c.x, c.y]) : null;
  };

  const bk = trackBuckets(['x', 'y', 'rotation', 'scaleX', 'scaleY']);
  let n = 0;
  let baseAngle: number | null = null;
  let baseLength: number | null = null;
  let prevAngleDelta = 0;
  for (const a of opts.tracks[0]!) {
    const b = refByTime.get(a.compTime);
    if (!b) continue;
    const pa = toParent(a.x, a.y, a.compTime);
    const pb = toParent(b.x, b.y, a.compTime);
    if (!pa || !pb) continue;
    const vx = pb[0] - pa[0];
    const vy = pb[1] - pa[1];
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) continue; // coincident points measure nothing
    const angle = (Math.atan2(vy, vx) * 180) / Math.PI;
    if (baseAngle === null || baseLength === null) {
      baseAngle = angle;
      baseLength = len;
    }
    let angleDelta = angle - baseAngle;
    // Unwrap: keep each frame's delta within half a turn of the previous.
    while (angleDelta - prevAngleDelta > 180) angleDelta -= 360;
    while (angleDelta - prevAngleDelta < -180) angleDelta += 360;
    prevAngleDelta = angleDelta;
    const scaleRatio = len / baseLength;

    const t = compToKeyframeTime(opts.targetNodeId, a.compTime);
    bk.add('x', a.compTime, pa[0]);
    bk.add('y', a.compTime, pa[1]);
    n++;
    if (wantRotation) {
      const baseRot = defaultAnimation.sample(opts.targetNodeId, 'rotation', t) ?? g.rotationDeg ?? 0;
      bk.add('rotation', a.compTime, baseRot + angleDelta);
    }
    if (wantScale) {
      const baseSx = defaultAnimation.sample(opts.targetNodeId, 'scaleX', t) ?? g.scaleX ?? 1;
      const baseSy = defaultAnimation.sample(opts.targetNodeId, 'scaleY', t) ?? g.scaleY ?? 1;
      bk.add('scaleX', a.compTime, baseSx * scaleRatio);
      bk.add('scaleY', a.compTime, baseSy * scaleRatio);
    }
  }
  if (n === 0) return null;
  return { label: 'Apply Motion Track (rotation & scale)', layer: opts.targetNodeId, writes: bk.writes(), count: n };
}

export interface SmoothStabilizeOptions {
  videoNodeId: string;
  /** Per-frame corrections in SOURCE DISPLAY px (globalMotion sims), aligned
   *  with `compFrames`. */
  corrections: readonly Sim[];
  compFrames: readonly number[];
  fps: number;
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}

/**
 * Smooth (dense) stabilization: write the per-frame similarity corrections as
 * position + rotation + scale keyframes on the video layer.
 *
 * Position rides the corrected frame CENTER — measured through the layer's
 * ORIGINAL transform on both sides (the planExpressionBake discipline all the
 * apply paths share), converted to parent space by differencing `fromComp`
 * points. Rotation and scale are deltas composed onto the layer's own sampled
 * base, exactly as `planTransformTrack` composes its two-point solve.
 *
 * The correction similarity pivots at the source frame's centre; the layer's
 * rotation/scale pivot at its ANCHOR. For the default centred anchor the two
 * coincide and the mapping is exact; a re-anchored layer gets first-order
 * accuracy, which is a documented approximation, not a surprise.
 */
export function planSmoothStabilize(opts: SmoothStabilizeOptions): TrackPlan | null {
  const node = defaultSceneGraph.getNode(opts.videoNodeId);
  if (!node || opts.corrections.length === 0) return null;
  if (opts.corrections.length !== opts.compFrames.length) return null;
  const g = readGeometry(node);
  if (!g) return null;
  const parentId = node.parent ?? null;
  const cx = opts.sourceWidth / 2;
  const cy = opts.sourceHeight / 2;

  const bk = trackBuckets(['x', 'y', 'rotation', 'scaleX', 'scaleY']);
  let n = 0;
  let prevRotDelta = 0;
  for (let i = 0; i < opts.corrections.length; i++) {
    const corr = opts.corrections[i]!;
    const compTime = opts.compFrames[i]! / opts.fps;
    const [wx, wy] = applySim(corr, cx, cy);
    const from = trackSampleToComp(opts.videoNodeId, cx, cy, compTime, opts.sourceWidth, opts.sourceHeight, opts.comp);
    const to = trackSampleToComp(opts.videoNodeId, wx, wy, compTime, opts.sourceWidth, opts.sourceHeight, opts.comp);
    if (!from || !to) continue;
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if (parentId) {
      const parentSpace = layerSpaceAt(parentId, compTime, opts.comp);
      if (!parentSpace) continue;
      const a = parentSpace.fromComp([to.x, to.y]);
      const b = parentSpace.fromComp([from.x, from.y]);
      dx = a[0] - b[0];
      dy = a[1] - b[1];
    }
    let rotDelta = (simRotation(corr) * 180) / Math.PI;
    // Unwrap frame-to-frame like the two-point solve does.
    while (rotDelta - prevRotDelta > 180) rotDelta -= 360;
    while (rotDelta - prevRotDelta < -180) rotDelta += 360;
    prevRotDelta = rotDelta;
    const k = simScale(corr);

    const t = compToKeyframeTime(opts.videoNodeId, compTime);
    const baseX = defaultAnimation.sample(opts.videoNodeId, 'x', t) ?? g.x;
    const baseY = defaultAnimation.sample(opts.videoNodeId, 'y', t) ?? g.y;
    const baseRot = defaultAnimation.sample(opts.videoNodeId, 'rotation', t) ?? g.rotationDeg ?? 0;
    const baseSx = defaultAnimation.sample(opts.videoNodeId, 'scaleX', t) ?? g.scaleX ?? 1;
    const baseSy = defaultAnimation.sample(opts.videoNodeId, 'scaleY', t) ?? g.scaleY ?? 1;
    bk.add('x', compTime, baseX + dx);
    bk.add('y', compTime, baseY + dy);
    bk.add('rotation', compTime, baseRot + rotDelta);
    bk.add('scaleX', compTime, baseSx * k);
    bk.add('scaleY', compTime, baseSy * k);
    n++;
  }
  if (n === 0) return null;
  return { label: 'Smooth Stabilize', layer: opts.videoNodeId, writes: bk.writes(), count: n };
}

/** The dense stabilizer's write (smoothStabilize.ts; pre-API — see the Plans note). */
export function applySmoothStabilize(opts: SmoothStabilizeOptions): number {
  const plan = planSmoothStabilize(opts);
  return plan ? writeTrackPlanLegacy(plan) : 0;
}

/** Corner Pin param keys in the tracker's corner order (TL, TR, BR, BL) and
 *  the rest position each offset resolves against (`defaultCorners`). */
const CORNER_KEYS: ReadonlyArray<{ xKey: string; yKey: string; rest: (w: number, h: number) => { x: number; y: number } }> = [
  { xKey: 'topLeftX', yKey: 'topLeftY', rest: () => ({ x: 0, y: 0 }) },
  { xKey: 'topRightX', yKey: 'topRightY', rest: (w) => ({ x: w, y: 0 }) },
  { xKey: 'bottomRightX', yKey: 'bottomRightY', rest: (w, h) => ({ x: w, y: h }) },
  { xKey: 'bottomLeftX', yKey: 'bottomLeftY', rest: (_, h) => ({ x: 0, y: h }) },
];

export interface CornerPinTrackOptions {
  /** The tracked video layer — the space the samples were measured in. */
  videoNodeId: string;
  /** The layer whose corners get pinned to the four tracked features. */
  targetNodeId: string;
  /** Four or more tracks. First four are TL, TR, BR, BL; extras tighten the
   *  planar fit via least-squares homography. */
  tracks: ReadonlyArray<readonly CompTrackSample[]>;
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}

/**
 * Corner / planar pin: keyframe the target's Corner Pin EFFECT so its four
 * corners ride the tracked surface (the target's first Corner Pin, else a new
 * one).
 *
 * With exactly four tracks this is the classic independent-corner path.
 * With N>4, each frame fits a least-squares homography from the seed
 * positions → current samples and evaluates it at the four corner seeds —
 * Mocha-style planar overdetermined fit, still stored as 4-corner pin.
 */
export function planCornerPinTrack(opts: CornerPinTrackOptions): TrackPlan | null {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || opts.tracks.length < 4) return null;
  const g = readGeometry(target);
  if (!g) return null;

  const bk = trackBuckets(CORNER_KEYS.flatMap(({ xKey, yKey }) => [xKey, yKey]));

  const nFrames = Math.min(...opts.tracks.map((t) => t.length));
  if (nFrames === 0) return null;
  const seeds = opts.tracks.map((t) => t[0]!);
  let planned = 0;

  const writeCorner = (
    c: number,
    sx: number,
    sy: number,
    compTime: number,
  ): void => {
    const spec = CORNER_KEYS[c]!;
    const rest = spec.rest(g.width, g.height);
    const compPt = trackSampleToComp(
      opts.videoNodeId, sx, sy, compTime, opts.sourceWidth, opts.sourceHeight, opts.comp,
    );
    if (!compPt) return;
    const space = layerSpaceAt(opts.targetNodeId, compTime, opts.comp);
    if (!space) return;
    const [lx, ly] = space.fromComp([compPt.x, compPt.y]);
    const ex = lx + g.width / 2 - rest.x;
    const ey = ly + g.height / 2 - rest.y;
    bk.add(spec.xKey, compTime, ex);
    bk.add(spec.yKey, compTime, ey);
    planned += 1;
  };

  if (opts.tracks.length === 4) {
    for (let c = 0; c < 4; c++) {
      for (const s of opts.tracks[c]!) {
        writeCorner(c, s.x, s.y, s.compTime);
      }
    }
  } else {
    // Planar fit: H maps all seed features → current; evaluate at 4 corner
    // seeds. RANSAC, not bare LS — a feature that slid onto a foreground
    // object (occlusion) or coasted through a loss must lose the vote, not
    // drag the plane. Coasted samples are predictions, so they weigh 0;
    // low-confidence matches likewise. Then temporally smooth H so single-frame
    // RANSAC flips don't jitter the pin (Mocha-class foothold).
    const Hs: Array<ReturnType<typeof fitHomography> | null> = [];
    for (let i = 0; i < nFrames; i++) {
      const src = seeds.map((s) => ({ x: s.x, y: s.y }));
      const dst = opts.tracks.map((t) => ({ x: t[i]!.x, y: t[i]!.y }));
      const weights = opts.tracks.map((t) => {
        const s = t[i]!;
        return s.coasted || s.confidence < 0.2 ? 0 : s.confidence;
      });
      const fit = fitHomographyRansac(src, dst, { inlierPx: 3, seed: i + 1, weights });
      Hs.push(fit?.H ?? fitHomography(src, dst));
    }
    const smoothed = smoothHomographySequence(Hs, 1);
    for (let i = 0; i < nFrames; i++) {
      const H = smoothed[i];
      const compTime = opts.tracks[0]![i]!.compTime;
      if (!H) {
        for (let c = 0; c < 4; c++) {
          const s = opts.tracks[c]![i]!;
          writeCorner(c, s.x, s.y, compTime);
        }
        continue;
      }
      for (let c = 0; c < 4; c++) {
        const seed = seeds[c]!;
        const p = projectHomography(H, { x: seed.x, y: seed.y });
        if (!p) continue;
        writeCorner(c, p.x, p.y, compTime);
      }
    }
  }
  if (planned === 0) return null;
  return { label: 'Apply Corner Pin Track', layer: opts.targetNodeId, writes: bk.writes(), effectType: 'corner-pin', count: planned };
}

/**
 * A follow track on a camera: x/y (z kept) so the eye rides the feature, and
 * poiX/poiY so the look-at stays locked on the same point — a practical 2.5D
 * camera track without a full 3D solve.
 */
export function planTrackToCamera(opts: ApplyTrackOptions): TrackPlan | null {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || opts.samples.length === 0) return null;
  if (readNodeKind(target) !== 'camera') return null;

  const parentId = target.parent ?? null;
  const bk = trackBuckets(['x', 'y', 'poiX', 'poiY']);
  let n = 0;
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
    bk.add('x', s.compTime, px);
    bk.add('y', s.compTime, py);
    // Look-at the tracked point in the same parent/comp space.
    bk.add('poiX', s.compTime, px);
    bk.add('poiY', s.compTime, py);
    n++;
  }
  if (n === 0) return null;
  return { label: 'Apply Camera Track', layer: opts.targetNodeId, writes: bk.writes(), count: n };
}

/**
 * 2-point camera solve (MVP): position + look-at from the anchor (the follow
 * track), orientationZ from the anchor→reference vector. Not a full SfM / 3D
 * camera tracker — a practical tripod pan/tilt proxy from planar footage.
 * ONE plan (the pre-API writer made two undo entries of it).
 */
export function planCameraSolveTrack(opts: TransformTrackOptions): TrackPlan | null {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || readNodeKind(target) !== 'camera' || opts.tracks.length < 2) return null;

  const follow = planTrackToCamera({
    videoNodeId: opts.videoNodeId,
    targetNodeId: opts.targetNodeId,
    samples: opts.tracks[0] ?? [],
    sourceWidth: opts.sourceWidth,
    sourceHeight: opts.sourceHeight,
    comp: opts.comp,
  });
  if (!follow) return null;

  const refByTime = new Map<number, CompTrackSample>();
  for (const s of opts.tracks[1]!) refByTime.set(s.compTime, s);
  const ori: TrackWrite = { track: 'orientationZ', keys: [] };
  let baseAngle: number | null = null;
  let prevDelta = 0;
  for (const a of opts.tracks[0]!) {
    const b = refByTime.get(a.compTime);
    if (!b) continue;
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (baseAngle === null) baseAngle = angle;
    let delta = angle - baseAngle;
    while (delta - prevDelta > 180) delta -= 360;
    while (delta - prevDelta < -180) delta += 360;
    prevDelta = delta;
    ori.keys.push({ compTime: a.compTime, value: delta });
  }
  return {
    label: 'Apply Camera Solve',
    layer: opts.targetNodeId,
    writes: ori.keys.length > 0 ? [...follow.writes, ori] : follow.writes,
    count: follow.count + ori.keys.length,
  };
}

/**
 * Drive Mesh Warp's 4×4 lattice from the tracked plane (the target's first
 * Mesh Warp, else a new one).
 *
 * With exactly four corner tracks the interior is bilinearly filled. With a
 * dense grid (the corner mode's "Dense grid" setting) each frame fits a
 * RANSAC homography over ALL tracked features and evaluates it at the 16
 * lattice seeds — perspective-true interior motion that survives occluded
 * features, not a bilinear guess between four corners.
 */
export function planMeshWarpTrack(opts: CornerPinTrackOptions): TrackPlan | null {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || opts.tracks.length < 4) return null;
  const g = readGeometry(target);
  if (!g) return null;

  const nFrames = Math.min(...opts.tracks.slice(0, 4).map((t) => t.length));
  if (nFrames === 0) return null;
  const dense = opts.tracks.length > 4;
  const denseFrames = dense ? Math.min(...opts.tracks.map((t) => t.length)) : nFrames;
  const seeds = opts.tracks.map((t) => t[0]!);
  // Lattice seed positions: bilinear over the SEED quad in source px — the
  // rest pose of the 16 mesh vertices on the tracked surface.
  const seedQuad = [seeds[0]!, seeds[1]!, seeds[2]!, seeds[3]!];
  const latticeSeeds: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < 4; row++) {
    const v = row / 3;
    for (let col = 0; col < 4; col++) {
      const u = col / 3;
      const top = { x: seedQuad[0]!.x + (seedQuad[1]!.x - seedQuad[0]!.x) * u, y: seedQuad[0]!.y + (seedQuad[1]!.y - seedQuad[0]!.y) * u };
      const bot = { x: seedQuad[3]!.x + (seedQuad[2]!.x - seedQuad[3]!.x) * u, y: seedQuad[3]!.y + (seedQuad[2]!.y - seedQuad[3]!.y) * u };
      latticeSeeds.push({ x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v });
    }
  }

  const names: string[] = [];
  for (let i = 0; i < 16; i++) names.push(`v${i}X`, `v${i}Y`);
  const bk = trackBuckets(names);

  const cornerRest = [
    { x: 0, y: 0 },
    { x: g.width, y: 0 },
    { x: g.width, y: g.height },
    { x: 0, y: g.height },
  ];

  let planned = 0;
  for (let fi = 0; fi < nFrames; fi++) {
    const compTime = opts.tracks[0]![fi]!.compTime;
    const space = layerSpaceAt(opts.targetNodeId, compTime, opts.comp);
    if (!space) continue;

    // Dense path: one robust plane per frame, evaluated at all 16 lattice
    // seeds. Falls through to the bilinear corner path when the fit fails.
    if (dense && fi < denseFrames) {
      const src = seeds.map((s) => ({ x: s.x, y: s.y }));
      const dst = opts.tracks.map((tr) => ({ x: tr[fi]!.x, y: tr[fi]!.y }));
      const weights = opts.tracks.map((tr) => {
        const s = tr[fi]!;
        return s.coasted || s.confidence < 0.2 ? 0 : s.confidence;
      });
      const fit = fitHomographyRansac(src, dst, { inlierPx: 3, seed: fi + 1, weights });
      if (fit) {
        let wrote = 0;
        for (let idx = 0; idx < 16; idx++) {
          const p = projectHomography(fit.H, latticeSeeds[idx]!);
          if (!p) continue;
          const compPt = trackSampleToComp(
            opts.videoNodeId, p.x, p.y, compTime, opts.sourceWidth, opts.sourceHeight, opts.comp,
          );
          if (!compPt) continue;
          const [lx, ly] = space.fromComp([compPt.x, compPt.y]);
          const rest = { x: ((idx % 4) / 3) * g.width, y: (Math.floor(idx / 4) / 3) * g.height };
          bk.add(`v${idx}X`, compTime, lx + g.width / 2 - rest.x);
          bk.add(`v${idx}Y`, compTime, ly + g.height / 2 - rest.y);
          wrote += 1;
        }
        if (wrote > 0) {
          planned += wrote;
          continue;
        }
      }
    }

    const corners: Array<{ x: number; y: number } | null> = [];
    for (let c = 0; c < 4; c++) {
      const s = opts.tracks[c]![fi]!;
      const compPt = trackSampleToComp(
        opts.videoNodeId, s.x, s.y, compTime, opts.sourceWidth, opts.sourceHeight, opts.comp,
      );
      if (!compPt) { corners.push(null); continue; }
      const [lx, ly] = space.fromComp([compPt.x, compPt.y]);
      const rest = cornerRest[c]!;
      corners.push({ x: lx + g.width / 2 - rest.x, y: ly + g.height / 2 - rest.y });
    }
    if (corners.some((c) => !c)) continue;

    // Bilinear fill 4×4 from TL,TR,BR,BL offsets. Tuple assertion: the
    // `corners.some((c) => !c)` guard above proved all four are present.
    const [tl, tr, br, bl] = corners as [
      { x: number; y: number }, { x: number; y: number },
      { x: number; y: number }, { x: number; y: number },
    ];
    for (let row = 0; row < 4; row++) {
      const v = row / 3;
      for (let col = 0; col < 4; col++) {
        const u = col / 3;
        const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
        const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
        const ox = top.x + (bot.x - top.x) * v;
        const oy = top.y + (bot.y - top.y) * v;
        const idx = row * 4 + col;
        bk.add(`v${idx}X`, compTime, ox);
        bk.add(`v${idx}Y`, compTime, oy);
        planned += 1;
      }
    }
  }
  if (planned === 0) return null;
  return { label: 'Apply Mesh Warp Track', layer: opts.targetNodeId, writes: bk.writes(), effectType: 'mesh-warp', count: planned };
}

// ── Create Null & Apply ────────────────────────────────────────────────────

export type NullTrackMode = 'follow' | 'transform' | 'corner';

/** "Tracked Null", "Tracked Null 2", … — the button is easy to press twice, and
 *  two layers with byte-identical names cannot be told apart in the timeline
 *  or the parent dropdown. */
export function nextTrackedNullName(): string {
  let priorNulls = 0;
  defaultSceneGraph.traverse((n) => {
    if (/^Tracked Null( \d+)?$/.test(n.name ?? '')) priorNulls++;
  });
  return priorNulls === 0 ? 'Tracked Null' : `Tracked Null ${priorNulls + 1}`;
}

/**
 * Where AE's Create Null & Apply puts the null: beside the video (its parent),
 * seeded on the first usable sample in that parent's space. Null when the
 * video is gone or there is nothing to apply.
 */
export function trackedNullSeed(opts: {
  videoNodeId: string;
  mode: NullTrackMode;
  samples: readonly CompTrackSample[];
  tracks: readonly (readonly CompTrackSample[])[];
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}): { parentId: string; x: number; y: number } | null {
  const video = defaultSceneGraph.getNode(opts.videoNodeId);
  if (!video) return null;
  const usable = opts.mode === 'corner' ? (opts.tracks[0] ?? []) : opts.samples;
  if (usable.length === 0) return null;
  const parentId = video.parent ?? opts.comp.rootId ?? 'comp_root';
  let x = 160;
  let y = 120;
  const first = usable[0]!;
  const compPt = trackSampleToComp(opts.videoNodeId, first.x, first.y, first.compTime, opts.sourceWidth, opts.sourceHeight, opts.comp);
  if (compPt) {
    const parentSpace = parentId ? layerSpaceAt(parentId, first.compTime, opts.comp) : null;
    if (parentSpace) [x, y] = parentSpace.fromComp([compPt.x, compPt.y]);
    else {
      x = compPt.x;
      y = compPt.y;
    }
  }
  return { parentId, x, y };
}

/** The plan Create Null & Apply keys onto the (new) null `nullId`. */
export function planOntoNull(nullId: string, opts: {
  videoNodeId: string;
  mode: NullTrackMode;
  samples: readonly CompTrackSample[];
  tracks: readonly (readonly CompTrackSample[])[];
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}): TrackPlan | null {
  const base = { videoNodeId: opts.videoNodeId, targetNodeId: nullId, sourceWidth: opts.sourceWidth, sourceHeight: opts.sourceHeight, comp: opts.comp };
  if (opts.mode === 'follow') return planTrackToLayer({ ...base, samples: opts.samples });
  if (opts.mode === 'transform') return planTransformTrack({ ...base, tracks: opts.tracks });
  return planCornerPinTrack({ ...base, tracks: opts.tracks });
}

// ── 3D camera solves ───────────────────────────────────────────────────────

/** Marker prop identifying the camera a planar solve owns (re-runs reuse it). API: `camera/trackerSolve`. */
export const PLANAR_SOLVE_CAMERA_PROP = '__planarSolveCamera';

export interface PlanarCameraSolveOptions {
  videoNodeId: string;
  /** Corner-mode tracks: first four are TL,TR,BR,BL; extras tighten the fit. */
  tracks: ReadonlyArray<readonly CompTrackSample[]>;
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}

export interface PlanarCameraSolveResult {
  cameraId: string;
  keyframes: number;
  /** Mean per-frame RMS reprojection error, comp px. */
  meanRmsPx: number;
  solvedFrames: number;
  totalFrames: number;
}

/** A solve's plan plus what the section reports. */
export interface CameraSolvePlan {
  plan: TrackPlan;
  result: PlanarCameraSolveResult;
}

/** True when a camera solve has something to solve (four tracks, at least one frame). */
export function canSolveCamera(opts: PlanarCameraSolveOptions): boolean {
  return opts.tracks.length >= 4 && Math.min(...opts.tracks.map((t) => t.length)) > 0;
}

/** The camera a previous solve made in this composition (tagged `camera/trackerSolve`), or null. */
export function findSolveCamera(comp: { rootId?: string }): string | null {
  const scope = comp.rootId
    ? flattenComposition(defaultSceneGraph, comp.rootId)
    : (() => {
        const all: SceneNode[] = [];
        defaultSceneGraph.traverse((n) => { all.push(n); });
        return all;
      })();
  const camera = scope.find((n) => {
    if (readNodeKind(n) !== 'camera') return false;
    const tp = n.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown> | undefined;
    return tp?.[PLANAR_SOLVE_CAMERA_PROP] === true;
  });
  return camera?.id ?? null;
}

function cameraFocal(camId: string, comp: { width: number; height: number }): number {
  const camera = defaultSceneGraph.getNode(camId);
  const camTransform = camera?.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown> | undefined;
  return typeof camTransform?.focalLength === 'number' && camTransform.focalLength > 0
    ? camTransform.focalLength
    : Project3D.defaultCamera(comp.width, comp.height).focalLength;
}

/**
 * 3D camera from the tracked plane — homography-decomposition pose per frame
 * (see planarPose.ts), keyed onto the one-node camera `camId` as x/y/z +
 * orientationX/Y/Z.
 *
 * The tracked surface is taken to BE the comp plane (z = 0), with the footage
 * contain-fitted to the comp — the assumption that lets a single plane and a
 * known lens yield a full 6-DoF path. The lens comes from the solve camera's
 * `focalLength` prop (default lens on first run), so re-solving after editing
 * the focal re-interprets the same track through the new lens.
 *
 * The camera is ONE-NODE on purpose: a POI camera re-aims itself, which would
 * fight the solved orientation.
 */
export function planPlanarCameraSolve(opts: PlanarCameraSolveOptions, camId: string): CameraSolvePlan | null {
  if (!canSolveCamera(opts)) return null;
  const nFrames = Math.min(...opts.tracks.map((t) => t.length));

  // Footage → comp-plane mapping: contain-fit, centred. The solve treats the
  // footage's pixel grid as a window onto the comp plane.
  const s = Math.min(opts.comp.width / opts.sourceWidth, opts.comp.height / opts.sourceHeight);
  const ox = (opts.comp.width - opts.sourceWidth * s) / 2;
  const oy = (opts.comp.height - opts.sourceHeight * s) / 2;
  const toComp = (p: { x: number; y: number }): { x: number; y: number } =>
    ({ x: ox + p.x * s, y: oy + p.y * s });

  const focal = cameraFocal(camId, opts.comp);
  const cx = opts.comp.width / 2;
  const cy = opts.comp.height / 2;

  const seeds = opts.tracks.map((t) => toComp(t[0]!));
  const series: Array<{ compTime: number; pose: PlanarPose }> = [];
  let rmsSum = 0;

  for (let fi = 0; fi < nFrames; fi++) {
    const compTime = opts.tracks[0]![fi]!.compTime;
    const image = opts.tracks.map((tr) => toComp(tr[fi]!));
    const weights = opts.tracks.map((tr) => {
      const smp = tr[fi]!;
      return smp.coasted || smp.confidence < 0.2 ? 0 : smp.confidence;
    });
    // Robust pre-pass: the homography's inliers pick which correspondences
    // the pose is solved from — an occluded feature must not bend the camera.
    const fit = fitHomographyRansac(seeds, image, { inlierPx: 3 * s + 1, seed: fi + 1, weights });
    const plane: Array<{ x: number; y: number }> = [];
    const img: Array<{ x: number; y: number }> = [];
    const usable = fit
      ? seeds.filter((_, i) => fit.inliers[i])
      : seeds.filter((_, i) => weights[i]! > 0);
    if (usable.length >= 4) {
      seeds.forEach((sd, i) => {
        const keep = fit ? fit.inliers[i] : weights[i]! > 0;
        if (keep) {
          plane.push(sd);
          img.push(image[i]!);
        }
      });
    } else {
      seeds.forEach((sd, i) => { plane.push(sd); img.push(image[i]!); });
    }
    const pose = solvePlanarPose(plane, img, focal, cx, cy);
    if (!pose) continue;
    series.push({ compTime, pose });
    rmsSum += pose.rmsPx;
  }
  if (series.length === 0) return null;

  // Unwrap orientation seams so a yaw crossing ±180° doesn't spin the rig.
  const yaws = unwrapDegrees(series.map((e) => e.pose.yawDeg));
  const pitches = unwrapDegrees(series.map((e) => e.pose.pitchDeg));
  const rolls = unwrapDegrees(series.map((e) => e.pose.rollDeg));
  const w = (track: string, vals: number[]): TrackWrite => ({ track, keys: series.map((e, i) => ({ compTime: e.compTime, value: vals[i]! })) });
  const writes = [
    w('x', series.map((e) => e.pose.position.x)),
    w('y', series.map((e) => e.pose.position.y)),
    w('z', series.map((e) => e.pose.position.z)),
    w('orientationX', pitches),
    w('orientationY', yaws),
    w('orientationZ', rolls),
  ];
  return {
    plan: { label: 'Apply Planar Camera Solve', layer: camId, writes, count: series.length * writes.length },
    result: {
      cameraId: camId,
      keyframes: series.length * writes.length,
      meanRmsPx: rmsSum / series.length,
      solvedFrames: series.length,
      totalFrames: nFrames,
    },
  };
}

/**
 * Full SfM / planar-hybrid camera solve from dense tracks (see sfmCamera.ts)
 * onto the one-node camera `camId`. Uses all tracked points; prefers planar
 * when the first four form a quad.
 */
export function planSfmCameraSolve(opts: PlanarCameraSolveOptions, camId: string): CameraSolvePlan | null {
  if (!canSolveCamera(opts)) return null;
  const nFrames = Math.min(...opts.tracks.map((t) => t.length));
  const focal = cameraFocal(camId, opts.comp);

  const frames = [];
  for (let fi = 0; fi < nFrames; fi++) {
    frames.push({
      points: opts.tracks.map((tr) => ({ x: tr[fi]!.x, y: tr[fi]!.y })),
    });
  }
  const path = solveSfmCameraPath(frames, {
    focalLength: focal,
    width: opts.sourceWidth,
    height: opts.sourceHeight,
  });

  const w = (track: string, vals: number[]): TrackWrite => ({
    track,
    keys: vals.map((value, i) => ({ compTime: opts.tracks[0]![i]!.compTime, value })),
  });
  const writes = [
    w('x', path.map((p) => p.x)),
    w('y', path.map((p) => p.y)),
    w('z', path.map((p) => p.z)),
    w('orientationX', path.map((p) => p.pitchDeg)),
    w('orientationY', path.map((p) => p.yawDeg)),
    w('orientationZ', path.map((p) => p.rollDeg)),
  ];
  const meanErr = path.reduce((s, p) => s + p.error, 0) / Math.max(1, path.length);
  return {
    plan: { label: 'Apply 3D Camera Tracker (SfM)', layer: camId, writes, count: path.length * writes.length },
    result: {
      cameraId: camId,
      keyframes: path.length * writes.length,
      meanRmsPx: meanErr,
      solvedFrames: path.length,
      totalFrames: nFrames,
    },
  };
}

// ── Warp Stabilizer's mesh path (smoothStabilize.ts, pre-API) ──────────────

/**
 * Mesh Warp lattice keyframes for every frame in a subspace stabilize path.
 * `frames[i].cells` is rows×cols from {@link fitSubspaceWarp}.
 */
export function planSubspaceMeshSequence(opts: {
  targetNodeId: string;
  frames: ReadonlyArray<{
    cells: readonly SubspaceCell[];
    compTime: number;
  }>;
  rows: number;
  cols: number;
  fieldW: number;
  fieldH: number;
  layerW: number;
  layerH: number;
}): TrackPlan | null {
  if (opts.frames.length === 0) return null;
  const names: string[] = [];
  for (let i = 0; i < 16; i++) names.push(`v${i}X`, `v${i}Y`);
  const bk = trackBuckets(names);
  for (const fr of opts.frames) {
    for (let i = 0; i < 16; i++) {
      const u = (i % 4) / 3;
      const v = Math.floor(i / 4) / 3;
      const x = u * opts.fieldW;
      const y = v * opts.fieldH;
      const [wx, wy] = sampleSubspace(fr.cells, opts.rows, opts.cols, x, y, opts.fieldW, opts.fieldH);
      bk.add(`v${i}X`, fr.compTime, (wx - x) * (opts.layerW / Math.max(1e-6, opts.fieldW)));
      bk.add(`v${i}Y`, fr.compTime, (wy - y) * (opts.layerH / Math.max(1e-6, opts.fieldH)));
    }
  }
  return { label: 'Apply Subspace Mesh Path', layer: opts.targetNodeId, writes: bk.writes(), effectType: 'mesh-warp', count: opts.frames.length * 32 };
}

export function applySubspaceMeshSequence(opts: Parameters<typeof planSubspaceMeshSequence>[0]): number {
  const plan = planSubspaceMeshSequence(opts);
  return plan ? writeTrackPlanLegacy(plan, 'mw_sub') : 0;
}

/** @deprecated Prefer {@link applySubspaceMeshSequence} for full Warp Stabilizer paths. */
export function applySubspaceMeshFrame(opts: {
  targetNodeId: string;
  cells: readonly SubspaceCell[];
  rows: number;
  cols: number;
  fieldW: number;
  fieldH: number;
  layerW: number;
  layerH: number;
  compTime: number;
}): number {
  return applySubspaceMeshSequence({
    targetNodeId: opts.targetNodeId,
    frames: [{ cells: opts.cells, compTime: opts.compTime }],
    rows: opts.rows,
    cols: opts.cols,
    fieldW: opts.fieldW,
    fieldH: opts.fieldH,
    layerW: opts.layerW,
    layerH: opts.layerH,
  });
}
