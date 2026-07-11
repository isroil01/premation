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
  /** Samples across the shutter interval (≥2 to blur). */
  samples: number;
  fps: number;
}

/**
 * Sub-frame sample times (seconds) across the shutter interval centred on `t`.
 * Deterministic. Returns `[t]` when there's nothing to blur (≤1 sample or a
 * closed shutter), otherwise `samples` evenly-spaced times spanning the shutter.
 */
export function motionBlurSampleTimes(
  t: number,
  fps: number,
  shutterAngle: number,
  samples: number,
): number[] {
  const n = Math.max(1, Math.floor(samples));
  const shutter = (Math.max(0, Math.min(360, shutterAngle)) / 360) / Math.max(1, fps);
  if (n <= 1 || shutter <= 0) return [t];
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    times.push(t + (i / (n - 1) - 0.5) * shutter);
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
