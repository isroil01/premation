/**
 * Per-layer time controls (Prompt E6): time-stretch, reverse, freeze-frame and
 * frame-blending. Each layer maps composition time → its own SOURCE time, so its
 * keyframed motion (and, once real footage lands in Prompt 7, its frames) can
 * play slower/faster, backwards, or hold on a single frame.
 *
 * Stored on the node's `fx` component like the other E-series layer data, so
 * History / autosave / export capture it for free. The mapping is pure and
 * tested; buildSnapshot samples each node's animation at its remapped time.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type FrameBlend = 'none' | 'mix';

export interface LayerTime {
  /** Playback speed as a percentage of the source: 100 = normal, 200 = half
   *  speed (twice as long), 50 = double speed. */
  stretch: number;
  /** Play the layer backwards over its animated span. */
  reverse: boolean;
  /** Hold one source time for the whole comp (freeze frame). */
  freeze: boolean;
  freezeTime: number;
  /** Frame blending for stretched/slowed footage (applied to real frames once
   *  the asset pipeline exists — Prompt 7; no-op for continuous keyframes). */
  frameBlend: FrameBlend;
}

/** The layer's animated time range — the anchor for stretch + reverse. */
export interface TimeSpan {
  start: number;
  end: number;
}

export const DEFAULT_LAYER_TIME: LayerTime = {
  stretch: 100,
  reverse: false,
  freeze: false,
  freezeTime: 0,
  frameBlend: 'none',
};

export const FRAME_BLENDS: ReadonlyArray<{ value: FrameBlend; label: string }> = [
  { value: 'none', label: 'Off' },
  { value: 'mix', label: 'Frame Mix' },
];

/** True when the config leaves time unchanged (lets callers skip remapping). */
export function isIdentityTime(cfg: LayerTime): boolean {
  return !cfg.freeze && !cfg.reverse && cfg.stretch === 100;
}

/**
 * Map composition time `t` to the layer's source time.
 *   freeze  → constant `freezeTime`
 *   stretch → progress through the source at `100/stretch` the comp rate,
 *             anchored at the span start
 *   reverse → mirror the source time within the span
 * Pure; sampleTrack clamps anything outside the keyframe range.
 */
export function remapTime(t: number, cfg: LayerTime, span: TimeSpan): number {
  if (cfg.freeze) return cfg.freezeTime;
  const stretch = cfg.stretch > 0 ? cfg.stretch : 100;
  let s = span.start + (t - span.start) * (100 / stretch);
  if (cfg.reverse) s = span.start + span.end - s;
  return s;
}

function normalize(v: unknown): LayerTime {
  const o = (v ?? {}) as Partial<LayerTime>;
  const stretch = Number.isFinite(o.stretch) ? Math.max(1, Math.min(1000, o.stretch as number)) : 100;
  return {
    stretch,
    reverse: o.reverse === true,
    freeze: o.freeze === true,
    freezeTime: Number.isFinite(o.freezeTime) ? (o.freezeTime as number) : 0,
    frameBlend: o.frameBlend === 'mix' ? 'mix' : 'none',
  };
}

/** Read a node's time config from its `fx` component (undefined when default). */
export function readNodeLayerTime(node: SceneNode): LayerTime | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  if (!fx || fx.props.time === undefined) return undefined;
  const cfg = normalize(fx.props.time);
  return isIdentityTime(cfg) && cfg.frameBlend === 'none' ? undefined : cfg;
}

export function getNodeLayerTime(nodeId: string): LayerTime {
  const node = defaultSceneGraph.getNode(nodeId);
  const fx = node?.components.find((c) => c.type === 'fx');
  return fx && fx.props.time !== undefined ? normalize(fx.props.time) : { ...DEFAULT_LAYER_TIME };
}

/** Patch a node's time config (clears back to default when identity). */
export function updateNodeLayerTime(nodeId: string, patch: Partial<LayerTime>): void {
  const next = normalize({ ...getNodeLayerTime(nodeId), ...patch });
  const clear = isIdentityTime(next) && next.frameBlend === 'none';
  defaultSceneGraph.setLayerTime(nodeId, clear ? undefined : next);
  getEventBus().emit('AnimationChanged', { nodeId });
}
