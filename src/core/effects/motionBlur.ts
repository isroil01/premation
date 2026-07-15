/**
 * Motion blur (Prompt 6).
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

export function readNodeMotionBlur(node: SceneNode): boolean {
  const fx = node.components.find((c) => c.type === 'fx');
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
