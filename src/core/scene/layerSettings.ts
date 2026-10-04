/**
 * Layer Settings (AE: Layer ▸ Layer Settings…, Ctrl+Shift+Y) and Solid
 * Settings — the data half of the dialog.
 *
 * What the dialog can edit depends on the layer:
 *
 *  • solid  — name, width, height, colour (+ label colour). AE's Solid
 *             Settings; also what Layer ▸ New ▸ Solid opens first.
 *  • sized  — a null or adjustment layer that carries its own width/height:
 *             name, label colour, width, height.
 *  • plain  — every other layer: name and label colour.
 *
 * Every apply is ONE engine entry (compositionEdits.ts; the new solid is one
 * `pasteLayers`), so Undo takes a freshly created solid away in one press.
 */

import { readNodeKind } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';

export type LayerSettingsKind = 'solid' | 'sized' | 'plain';

export interface LayerSettingsValues {
  name: string;
  /** Label colour hex, or undefined for the kind's default. Omit the key to leave it alone. */
  labelColor?: string;
  width?: number;
  height?: number;
  /** Solid fill colour (solids only). */
  color?: string;
}

/** AE's limits for a solid's pixel size. */
export const MIN_LAYER_SIZE = 1;
export const MAX_LAYER_SIZE = 30000;

export const DEFAULT_SOLID_COLOR = '#4f7ea8';

/** A typed size, rounded and clamped into AE's range; NaN → null. */
export function sanitizeLayerSize(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  return Math.max(MIN_LAYER_SIZE, Math.min(MAX_LAYER_SIZE, Math.round(v)));
}

function fxProps(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

function transformSize(node: SceneNode): { width: number; height: number } | null {
  const t = node.components.find((c) => c.type === 'Transform');
  const w = t?.props.width;
  const h = t?.props.height;
  return typeof w === 'number' && typeof h === 'number' ? { width: w, height: h } : null;
}

export function layerSettingsKind(node: SceneNode): LayerSettingsKind {
  const fx = fxProps(node);
  if (fx?.solid === true) return 'solid';
  const kind = readNodeKind(node) as string;
  const isAdjustment = kind === 'adjustment' || fx?.adjustment === true;
  if ((kind === 'null' || isAdjustment) && transformSize(node)) return 'sized';
  return 'plain';
}
