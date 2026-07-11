/**
 * Track / alpha mattes (Prompt 5 — GPU compositing, feature 3).
 *
 * A matte makes the layer directly above it define the alpha of this layer:
 *   • alpha      — keep this layer where the layer above is opaque
 *   • alpha-inv  — keep this layer where the layer above is transparent
 *   • luma       — this layer's alpha follows the above layer's luminance
 *   • luma-inv   — …follows the inverse luminance
 * The matte source layer is consumed (not drawn on its own).
 *
 * Stored on the matted layer's `fx` component. Canvas2DBackend composites it via
 * offscreen buffers; the GPU matte path is a later slice (Canvas2D is default).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type MatteType = 'alpha' | 'luma' | 'alpha-inv' | 'luma-inv';

export const MATTE_OPTIONS: ReadonlyArray<{ value: MatteType | 'none'; label: string }> = [
  { value: 'none', label: 'No matte' },
  { value: 'alpha', label: 'Alpha' },
  { value: 'alpha-inv', label: 'Alpha inverted' },
  { value: 'luma', label: 'Luma' },
  { value: 'luma-inv', label: 'Luma inverted' },
];

const VALID = new Set<string>(['alpha', 'luma', 'alpha-inv', 'luma-inv']);

export function isMatteType(v: unknown): v is MatteType {
  return typeof v === 'string' && VALID.has(v);
}

/** Read a node's matte type from its `fx` component (undefined = none). */
export function readNodeMatte(node: SceneNode): MatteType | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  const m = fx?.props.matte;
  return isMatteType(m) ? m : undefined;
}

export function getNodeMatte(nodeId: string): MatteType | 'none' {
  const node = defaultSceneGraph.getNode(nodeId);
  return (node && readNodeMatte(node)) ?? 'none';
}

export function setNodeMatte(nodeId: string, matte: MatteType | 'none'): void {
  defaultSceneGraph.setMatte(nodeId, matte === 'none' ? undefined : matte);
  getEventBus().emit('AnimationChanged', { nodeId });
}
