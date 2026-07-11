/**
 * Per-layer blend modes (Prompt 5 — GPU compositing, feature 1).
 *
 * The blend mode lives on the node's `fx` component (sibling to the effect
 * stack), so History / autosave / export capture it for free. We expose only the
 * modes BOTH backends render identically — the intersection of Canvas 2D's
 * `globalCompositeOperation` and the GPU renderer's `BlendMode` — so switching
 * backends never changes the picture.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type LayerBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'add';

export const BLEND_MODES: ReadonlyArray<{ mode: LayerBlendMode; label: string }> = [
  { mode: 'normal', label: 'Normal' },
  { mode: 'multiply', label: 'Multiply' },
  { mode: 'screen', label: 'Screen' },
  { mode: 'overlay', label: 'Overlay' },
  { mode: 'darken', label: 'Darken' },
  { mode: 'lighten', label: 'Lighten' },
  { mode: 'add', label: 'Add' },
];

const VALID = new Set<string>(BLEND_MODES.map((b) => b.mode));

export function isBlendMode(v: unknown): v is LayerBlendMode {
  return typeof v === 'string' && VALID.has(v);
}

/** Read a node's blend mode from its `fx` component (defaults to 'normal'). */
export function readNodeBlend(node: SceneNode): LayerBlendMode {
  const fx = node.components.find((c) => c.type === 'fx');
  const m = fx?.props.blendMode;
  return isBlendMode(m) ? m : 'normal';
}

export function getNodeBlend(nodeId: string): LayerBlendMode {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeBlend(node) : 'normal';
}

export function setNodeBlend(nodeId: string, mode: LayerBlendMode): void {
  defaultSceneGraph.setBlendMode(nodeId, mode);
  // Compositing changed → same refresh signal as an effect/animation edit.
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** Map a blend mode to a Canvas 2D `globalCompositeOperation`. */
export function blendToComposite(mode: LayerBlendMode): GlobalCompositeOperation {
  switch (mode) {
    case 'multiply': return 'multiply';
    case 'screen': return 'screen';
    case 'overlay': return 'overlay';
    case 'darken': return 'darken';
    case 'lighten': return 'lighten';
    case 'add': return 'lighter'; // additive
    case 'normal':
    default: return 'source-over';
  }
}
