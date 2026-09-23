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
 * Every apply is ONE undo entry (`runDocumentEdit`), including the new-solid
 * path, so Undo takes a freshly created solid away in one press.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { renameLayer } from '@core/scene/renameLayer';
import { setNodeLabelColor } from '@core/scene/labelColor';
import { writeTransformProps } from '@core/scene/transformWrite';
import { insertSolid } from '@core/scene/sceneInsert';
import { readNodeFill, solidFill } from '@core/paint/fill';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { useSelectionStore } from '@stores/selectionStore';
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

/** The dialog's starting values for a layer, or null when it is gone. */
export function readLayerSettings(nodeId: string): { kind: LayerSettingsKind; values: LayerSettingsValues } | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const kind = layerSettingsKind(node);
  const values: LayerSettingsValues = { name: node.name ?? '' };
  if (node.color) values.labelColor = node.color;
  const size = transformSize(node);
  if (size && kind !== 'plain') {
    values.width = size.width;
    values.height = size.height;
  }
  if (kind === 'solid') {
    const fill = readNodeFill(node);
    values.color = fill && fill.type === 'solid' ? fill.color : DEFAULT_SOLID_COLOR;
  }
  return { kind, values };
}

/** Writes the values onto an existing layer. Caller provides the undo scope. */
function writeSettings(nodeId: string, kind: LayerSettingsKind, values: LayerSettingsValues, label: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const name = values.name.trim();
  if (name && name !== node.name) renameLayer(nodeId, name);
  if ('labelColor' in values && values.labelColor !== node.color) setNodeLabelColor(nodeId, values.labelColor);
  if (kind !== 'plain') {
    const w = values.width !== undefined ? sanitizeLayerSize(values.width) : null;
    const h = values.height !== undefined ? sanitizeLayerSize(values.height) : null;
    const writes: Array<{ prop: string; value: number }> = [];
    if (w !== null) writes.push({ prop: 'width', value: w });
    if (h !== null) writes.push({ prop: 'height', value: h });
    if (writes.length) writeTransformProps(nodeId, writes, label);
  }
  if (kind === 'solid' && values.color) defaultSceneGraph.setFill(nodeId, solidFill(values.color));
}

/** Apply Layer / Solid Settings to `nodeId` as one undo step. False when the layer is gone. */
export function applyLayerSettings(nodeId: string, values: LayerSettingsValues): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  const kind = layerSettingsKind(node);
  const label = kind === 'solid' ? 'Solid Settings' : 'Layer Settings';
  runDocumentEdit(label, () => writeSettings(nodeId, kind, values, label));
  return true;
}

/** "Solid N" — one past the number of solids already in the project. */
export function nextSolidName(): string {
  let count = 0;
  defaultSceneGraph.traverse((n) => {
    if (fxProps(n)?.solid === true) count += 1;
  });
  return `Solid ${count + 1}`;
}

/**
 * Layer ▸ New ▸ Solid, confirmed from Solid Settings: insert a solid at the
 * comp centre with the dialog's name, size and colour. One undo step. Returns
 * the new layer's id (it is also selected), or null.
 */
export function createSolidLayer(values: LayerSettingsValues): string | null {
  return runDocumentEdit('New Solid', () => buildSolidLayer(values));
}

/**
 * The New Solid builder alone (no undo scope): the UI runs it off-document
 * and inserts the result as one `pasteLayers` (offDocument.ts).
 */
export function buildSolidLayer(values: LayerSettingsValues): string | null {
  insertSolid(values.color ?? DEFAULT_SOLID_COLOR);
  const id = useSelectionStore.getState().ids[0];
  if (!id) return null;
  writeSettings(id, 'solid', values, 'New Solid');
  return id;
}
