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
import { addEffect, getNodeEffects, effectPropPath } from '@core/effects/effects';
import type { CompTrackSample } from './trackVideoLayer';
import { applySim, simRotation, simScale, type Sim } from './globalMotion';

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
export function applyStabilizeToLayer(opts: StabilizeOptions): number {
  const node = defaultSceneGraph.getNode(opts.videoNodeId);
  if (!node || opts.samples.length === 0) return 0;
  const g = readGeometry(node);
  if (!g) return 0;
  const parentId = node.parent ?? null;

  const first = opts.samples[0]!;
  const p0 = trackSampleToComp(
    opts.videoNodeId, first.x, first.y, first.compTime, opts.sourceWidth, opts.sourceHeight, opts.comp,
  );
  if (!p0) return 0;

  // Plan everything against the original transform, then write once.
  const xKfs: Keyframe[] = [];
  const yKfs: Keyframe[] = [];
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
      const b = parentSpace.fromComp([p.x, p.y]);
      dx = a[0] - b[0];
      dy = a[1] - b[1];
    }
    const t = compToKeyframeTime(opts.videoNodeId, s.compTime);
    const baseX = defaultAnimation.sample(opts.videoNodeId, 'x', t) ?? g.x;
    const baseY = defaultAnimation.sample(opts.videoNodeId, 'y', t) ?? g.y;
    xKfs.push({ t, value: baseX + dx, easing: 'linear' });
    yKfs.push({ t, value: baseY + dy, easing: 'linear' });
  }
  if (xKfs.length === 0) return 0;

  const existingOf = (prop: string): readonly Keyframe[] =>
    defaultAnimation.tracksFor(opts.videoNodeId).find((tr) => tr.prop === prop)?.keyframes ?? [];

  runAnimEdit('Stabilize Motion', () => {
    defaultAnimation.batch(() => {
      defaultAnimation.setKeyframes(opts.videoNodeId, 'x', spliceRecordedRange(existingOf('x'), xKfs));
      defaultAnimation.setKeyframes(opts.videoNodeId, 'y', spliceRecordedRange(existingOf('y'), yKfs));
    });
  });
  return xKfs.length;
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
export function applyTransformTrack(opts: TransformTrackOptions): number {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || opts.tracks.length !== 2) return 0;
  const g = readGeometry(target);
  if (!g) return 0;
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

  const xKfs: Keyframe[] = [];
  const yKfs: Keyframe[] = [];
  const rotKfs: Keyframe[] = [];
  const sxKfs: Keyframe[] = [];
  const syKfs: Keyframe[] = [];
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
    xKfs.push({ t, value: pa[0], easing: 'linear' });
    yKfs.push({ t, value: pa[1], easing: 'linear' });
    if (wantRotation) {
      const baseRot = defaultAnimation.sample(opts.targetNodeId, 'rotation', t) ?? g.rotationDeg ?? 0;
      rotKfs.push({ t, value: baseRot + angleDelta, easing: 'linear' });
    }
    if (wantScale) {
      const baseSx = defaultAnimation.sample(opts.targetNodeId, 'scaleX', t) ?? g.scaleX ?? 1;
      const baseSy = defaultAnimation.sample(opts.targetNodeId, 'scaleY', t) ?? g.scaleY ?? 1;
      sxKfs.push({ t, value: baseSx * scaleRatio, easing: 'linear' });
      syKfs.push({ t, value: baseSy * scaleRatio, easing: 'linear' });
    }
  }
  if (xKfs.length === 0) return 0;

  const existingOf = (prop: string): readonly Keyframe[] =>
    defaultAnimation.tracksFor(opts.targetNodeId).find((tr) => tr.prop === prop)?.keyframes ?? [];

  runAnimEdit('Apply Motion Track (rotation & scale)', () => {
    defaultAnimation.batch(() => {
      defaultAnimation.setKeyframes(opts.targetNodeId, 'x', spliceRecordedRange(existingOf('x'), xKfs));
      defaultAnimation.setKeyframes(opts.targetNodeId, 'y', spliceRecordedRange(existingOf('y'), yKfs));
      if (rotKfs.length > 0) {
        defaultAnimation.setKeyframes(opts.targetNodeId, 'rotation', spliceRecordedRange(existingOf('rotation'), rotKfs));
      }
      if (sxKfs.length > 0) {
        defaultAnimation.setKeyframes(opts.targetNodeId, 'scaleX', spliceRecordedRange(existingOf('scaleX'), sxKfs));
        defaultAnimation.setKeyframes(opts.targetNodeId, 'scaleY', spliceRecordedRange(existingOf('scaleY'), syKfs));
      }
    });
  });
  return xKfs.length;
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
 * base, exactly as `applyTransformTrack` composes its two-point solve.
 *
 * The correction similarity pivots at the source frame's centre; the layer's
 * rotation/scale pivot at its ANCHOR. For the default centred anchor the two
 * coincide and the mapping is exact; a re-anchored layer gets first-order
 * accuracy, which is a documented approximation, not a surprise.
 */
export function applySmoothStabilize(opts: SmoothStabilizeOptions): number {
  const node = defaultSceneGraph.getNode(opts.videoNodeId);
  if (!node || opts.corrections.length === 0) return 0;
  if (opts.corrections.length !== opts.compFrames.length) return 0;
  const g = readGeometry(node);
  if (!g) return 0;
  const parentId = node.parent ?? null;
  const cx = opts.sourceWidth / 2;
  const cy = opts.sourceHeight / 2;

  const xKfs: Keyframe[] = [];
  const yKfs: Keyframe[] = [];
  const rotKfs: Keyframe[] = [];
  const sxKfs: Keyframe[] = [];
  const syKfs: Keyframe[] = [];
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
    xKfs.push({ t, value: baseX + dx, easing: 'linear' });
    yKfs.push({ t, value: baseY + dy, easing: 'linear' });
    rotKfs.push({ t, value: baseRot + rotDelta, easing: 'linear' });
    sxKfs.push({ t, value: baseSx * k, easing: 'linear' });
    syKfs.push({ t, value: baseSy * k, easing: 'linear' });
  }
  if (xKfs.length === 0) return 0;

  const existingOf = (prop: string): readonly Keyframe[] =>
    defaultAnimation.tracksFor(opts.videoNodeId).find((tr) => tr.prop === prop)?.keyframes ?? [];

  runAnimEdit('Smooth Stabilize', () => {
    defaultAnimation.batch(() => {
      defaultAnimation.setKeyframes(opts.videoNodeId, 'x', spliceRecordedRange(existingOf('x'), xKfs));
      defaultAnimation.setKeyframes(opts.videoNodeId, 'y', spliceRecordedRange(existingOf('y'), yKfs));
      defaultAnimation.setKeyframes(opts.videoNodeId, 'rotation', spliceRecordedRange(existingOf('rotation'), rotKfs));
      defaultAnimation.setKeyframes(opts.videoNodeId, 'scaleX', spliceRecordedRange(existingOf('scaleX'), sxKfs));
      defaultAnimation.setKeyframes(opts.videoNodeId, 'scaleY', spliceRecordedRange(existingOf('scaleY'), syKfs));
    });
  });
  return xKfs.length;
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
  /** Four tracks in TL, TR, BR, BL order. */
  tracks: ReadonlyArray<readonly CompTrackSample[]>;
  sourceWidth: number;
  sourceHeight: number;
  comp: { width: number; height: number; rootId?: string };
}

/**
 * Corner pin: keyframe the target's Corner Pin EFFECT so its four corners
 * ride the four tracked features — screen replacement, the AE workflow.
 *
 * Space chain per corner per sample: source px → comp (through the VIDEO
 * layer's live transform) → target layer-local (`fromComp`) → effect param
 * space (top-left origin — layer-local plus half the box, the
 * `layerToEffect` convention) → OFFSET from that corner's rest position,
 * because corner-pin params are offsets from `defaultCorners(w,h)` so that
 * all-zero is the identity.
 *
 * The effect is added with an EXPLICIT id before any track is written —
 * `addEffect` returns void and `isAnimatableProp` accepts any `effect.*`
 * path without validating, so writing tracks against a guessed id is the
 * documented silent-nothing bug. Tracks are created via `setKeyframes`
 * directly (the stopwatch-respecting `writeEffectParams` only keyframes
 * params that are ALREADY animated, and none of these are yet). One
 * `runAnimEdit` step for all eight params.
 *
 * Frames where the four samples are index-misaligned (a corner got lost and
 * its track is shorter) contribute only the corners they have — a missing
 * corner keeps its previous keyframed value through interpolation, which
 * degrades softer than snapping the quad to rest.
 */
export function applyCornerPinTrack(opts: CornerPinTrackOptions): number {
  const target = defaultSceneGraph.getNode(opts.targetNodeId);
  if (!target || opts.tracks.length !== 4) return 0;
  const g = readGeometry(target);
  if (!g) return 0;

  // Plan all eight tracks before creating anything.
  const kfsByKey = new Map<string, Keyframe[]>();
  for (const { xKey, yKey } of CORNER_KEYS) {
    kfsByKey.set(xKey, []);
    kfsByKey.set(yKey, []);
  }
  let planned = 0;
  for (let c = 0; c < 4; c++) {
    const spec = CORNER_KEYS[c]!;
    const rest = spec.rest(g.width, g.height);
    for (const s of opts.tracks[c]!) {
      const compPt = trackSampleToComp(
        opts.videoNodeId, s.x, s.y, s.compTime, opts.sourceWidth, opts.sourceHeight, opts.comp,
      );
      if (!compPt) continue;
      const space = layerSpaceAt(opts.targetNodeId, s.compTime, opts.comp);
      if (!space) continue;
      const [lx, ly] = space.fromComp([compPt.x, compPt.y]);
      // layer-local (centred) → effect space (top-left origin) → rest offset
      const ex = lx + g.width / 2 - rest.x;
      const ey = ly + g.height / 2 - rest.y;
      const t = compToKeyframeTime(opts.targetNodeId, s.compTime);
      kfsByKey.get(spec.xKey)!.push({ t, value: ex, easing: 'linear' });
      kfsByKey.get(spec.yKey)!.push({ t, value: ey, easing: 'linear' });
      planned += 1;
    }
  }
  if (planned === 0) return 0;

  // Reuse an existing corner pin on the target, else add one with a known id.
  let effectId = getNodeEffects(opts.targetNodeId).find((e) => e.type === 'corner-pin')?.id;
  if (!effectId) {
    effectId = `fx_cptrack_${Math.random().toString(36).slice(2, 8)}`;
    addEffect(opts.targetNodeId, 'corner-pin', effectId);
    // addEffect silently regenerates a colliding id — read back the truth.
    const added = getNodeEffects(opts.targetNodeId).find((e) => e.type === 'corner-pin');
    if (!added) return 0;
    effectId = added.id;
  }

  const existingOf = (path: string): readonly Keyframe[] =>
    defaultAnimation.tracksFor(opts.targetNodeId).find((tr) => tr.prop === path)?.keyframes ?? [];

  runAnimEdit('Apply Corner Pin Track', () => {
    defaultAnimation.batch(() => {
      for (const [key, kfs] of kfsByKey) {
        if (kfs.length === 0) continue;
        const path = effectPropPath(effectId!, key);
        defaultAnimation.setKeyframes(opts.targetNodeId, path, spliceRecordedRange(existingOf(path), kfs));
      }
    });
  });
  return planned;
}
