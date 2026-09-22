/**
 * Motion blur.
 *
 * Multi-sample accumulation: for a frame at time `t` we sample the animation at
 * several sub-frame times spread across the shutter interval and composite the
 * results. The shutter interval is the fraction of a frame the (virtual) shutter
 * is open — shutterAngle/360 of one frame (180° = half a frame), the After
 * Effects convention. All times are in seconds; `fps` converts to frames.
 *
 * Motion blur is gated at two levels (AE-style): the composition enables it, and
 * each layer opts in. The per-layer flag lives on the `fx` component.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';
import { renderComponentsOf } from '@core/scene/SceneGraph';

export interface MotionBlurConfig {
  enabled: boolean;
  /** Shutter angle in degrees (0–360). 180 = half-frame exposure. */
  shutterAngle: number;
  /** Shutter phase in degrees (-360–360). -90 centers the exposure on frame time (AE default). */
  shutterPhase?: number;
  /** Samples across the shutter interval (≥2 to blur). */
  samples: number;
  /** Adaptive sample limit per frame across the exposure (up to 128 in AE). */
  adaptiveSampleLimit?: number;
  fps: number;
}

/**
 * Sub-frame sample times (seconds) across the shutter interval governed by
 * shutterAngle and shutterPhase relative to frame time `t`.
 * Deterministic. Returns `[t]` when there's nothing to blur (≤1 sample or a
 * closed shutter), otherwise `samples` evenly-spaced times spanning the shutter.
 */
export function motionBlurSampleTimes(
  t: number,
  fps: number,
  shutterAngle: number,
  samples: number,
  shutterPhase = -90,
  adaptiveSampleLimit = 128,
): number[] {
  const effectiveSamples = Math.min(Math.max(1, Math.floor(samples)), Math.max(1, Math.floor(adaptiveSampleLimit)));
  const shutterDuration = (Math.max(0, Math.min(360, shutterAngle)) / 360) / Math.max(1, fps);
  if (effectiveSamples <= 1 || shutterDuration <= 0) return [t];
  const phaseOffset = ((Math.max(-360, Math.min(360, shutterPhase)) + 90) / 360) / Math.max(1, fps);
  const times: number[] = [];
  for (let i = 0; i < effectiveSamples; i++) {
    times.push(t + phaseOffset + (i / (effectiveSamples - 1) - 0.5) * shutterDuration);
  }
  return times;
}

/**
 * Raise sample count with on-screen travel so fast kinetic type and camera
 * moves stay smooth without paying full cost on near-static layers.
 *
 * `travelPx` is the Euclidean distance a layer's anchor moves across the
 * shutter (comp px). Rough rule: ~1 sample per 2 px of travel, floored at the
 * configured base and capped by `adaptiveSampleLimit`.
 */
export function adaptiveMotionBlurSamples(
  baseSamples: number,
  travelPx: number,
  adaptiveSampleLimit = 128,
): number {
  const base = Math.max(1, Math.floor(baseSamples));
  const limit = Math.max(base, Math.floor(adaptiveSampleLimit));
  if (!(travelPx > 0) || !Number.isFinite(travelPx)) return Math.min(base, limit);
  const fromTravel = Math.ceil(travelPx / 2);
  return Math.min(limit, Math.max(base, fromTravel));
}

export function readNodeMotionBlur(node: SceneNode): boolean {
  const fx = renderComponentsOf(node).find((c) => c.type === 'fx');
  return fx?.props.motionBlur === true;
}

export function getNodeMotionBlur(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeMotionBlur(node) : false;
}

export function setNodeMotionBlur(nodeId: string, on: boolean): void {
  defaultSceneGraph.setMotionBlur(nodeId, on ? true : undefined);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** One sub-frame transform sample, as `sampleMotion` reads it. */
export interface MotionProbe {
  x: number; y: number;
  /** Degrees. */
  rotation: number;
  scaleX: number; scaleY: number;
}

/**
 * How far a layer's SILHOUETTE travels on screen between two sub-frame
 * samples, in comp px — the number the adaptive sample count is sized from.
 *
 * The anchor's own travel is the obvious term and used to be the only one,
 * which sized a spinning title or a scale pop at the static-layer floor: a
 * rotation about the anchor moves the anchor not at all, and every corner by
 * `Δθ · halfDiagonal`. So the far corner's travel from rotation and scale is
 * added on top. `halfDiagonalPx` is half the layer box's diagonal (0 for a
 * layer with no size, which then falls back to the anchor rule).
 */
export function motionBlurTravelPx(a: MotionProbe, b: MotionProbe, halfDiagonalPx: number): number {
  const anchor = Math.hypot(b.x - a.x, b.y - a.y);
  const hd = Math.max(0, halfDiagonalPx);
  const rot = Math.abs(b.rotation - a.rotation) * (Math.PI / 180) * hd;
  const scale = Math.max(Math.abs(b.scaleX - a.scaleX), Math.abs(b.scaleY - a.scaleY)) * hd;
  return anchor + rot + scale;
}

/**
 * The same measure for a PROJECTED 3D layer: the farthest any corner of the
 * `w`×`h` box (centred on the origin) moves between the two affine matrices
 * `[a, b, c, d, e, f]`. A card flip moves its edges and not its centre, which
 * is why the translation term alone read zero for exactly the showiest 3D
 * motion.
 */
export function affineTravelPx(
  ma: readonly [number, number, number, number, number, number],
  mb: readonly [number, number, number, number, number, number],
  w: number,
  h: number,
): number {
  const hw = Math.max(0, w) / 2; const hh = Math.max(0, h) / 2;
  const corners: ReadonlyArray<readonly [number, number]> = [[0, 0], [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  let max = 0;
  for (const [x, y] of corners) {
    const ax = ma[0] * x + ma[2] * y + ma[4]; const ay = ma[1] * x + ma[3] * y + ma[5];
    const bx = mb[0] * x + mb[2] * y + mb[4]; const by = mb[1] * x + mb[3] * y + mb[5];
    const d = Math.hypot(bx - ax, by - ay);
    if (Number.isFinite(d) && d > max) max = d;
  }
  return max;
}
