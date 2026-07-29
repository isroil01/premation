/**
 * Per-layer blend modes.
 *
 * The blend mode lives on the node's `fx` component (sibling to the effect
 * stack), so History / autosave / export capture it for free.
 *
 * The live app composites on Canvas 2D, so we expose the full set of AE-standard
 * modes that `globalCompositeOperation` renders natively (~16). Each entry is
 * flagged `gpuSafe` = whether the GPU renderer's portable `BlendMode` union
 * already supports it; when the GPU path is wired in, non-safe modes fall back to
 * the nearest supported mode there rather than changing the picture on Canvas 2D.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type LayerBlendMode =
  | 'normal'
  | 'add'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/**
 * Blend modes in AE menu order, grouped by family. `gpuSafe` marks the ones the
 * portable GPU `BlendMode` union renders directly today; the rest are Canvas-2D
 * native and map to their nearest GPU equivalent until per-mode GPU shaders land.
 */
export const BLEND_MODES: ReadonlyArray<{ mode: LayerBlendMode; label: string; group: string; gpuSafe: boolean }> = [
  { mode: 'normal', label: 'Normal', group: 'Normal', gpuSafe: true },
  { mode: 'add', label: 'Add', group: 'Lighten', gpuSafe: true },
  { mode: 'lighten', label: 'Lighten', group: 'Lighten', gpuSafe: true },
  { mode: 'screen', label: 'Screen', group: 'Lighten', gpuSafe: true },
  { mode: 'color-dodge', label: 'Color Dodge', group: 'Lighten', gpuSafe: false },
  { mode: 'darken', label: 'Darken', group: 'Darken', gpuSafe: true },
  { mode: 'multiply', label: 'Multiply', group: 'Darken', gpuSafe: true },
  { mode: 'color-burn', label: 'Color Burn', group: 'Darken', gpuSafe: false },
  { mode: 'overlay', label: 'Overlay', group: 'Contrast', gpuSafe: true },
  { mode: 'soft-light', label: 'Soft Light', group: 'Contrast', gpuSafe: false },
  { mode: 'hard-light', label: 'Hard Light', group: 'Contrast', gpuSafe: false },
  { mode: 'difference', label: 'Difference', group: 'Comparative', gpuSafe: false },
  { mode: 'exclusion', label: 'Exclusion', group: 'Comparative', gpuSafe: false },
  { mode: 'hue', label: 'Hue', group: 'HSL', gpuSafe: false },
  { mode: 'saturation', label: 'Saturation', group: 'HSL', gpuSafe: false },
  { mode: 'color', label: 'Color', group: 'HSL', gpuSafe: false },
  { mode: 'luminosity', label: 'Luminosity', group: 'HSL', gpuSafe: false },
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

/** Map a blend mode to a Canvas 2D `globalCompositeOperation`. Most AE modes map
 *  1:1 to a native CSS/Canvas blend keyword; `add` is Canvas's `lighter`. */
export function blendToComposite(mode: LayerBlendMode): GlobalCompositeOperation {
  switch (mode) {
    case 'add': return 'lighter'; // additive / Linear Dodge
    case 'multiply': return 'multiply';
    case 'screen': return 'screen';
    case 'overlay': return 'overlay';
    case 'darken': return 'darken';
    case 'lighten': return 'lighten';
    case 'color-dodge': return 'color-dodge';
    case 'color-burn': return 'color-burn';
    case 'hard-light': return 'hard-light';
    case 'soft-light': return 'soft-light';
    case 'difference': return 'difference';
    case 'exclusion': return 'exclusion';
    case 'hue': return 'hue';
    case 'saturation': return 'saturation';
    case 'color': return 'color';
    case 'luminosity': return 'luminosity';
    case 'normal':
    default: return 'source-over';
  }
}
