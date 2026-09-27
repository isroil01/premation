/**
 * Section presets — what each preset-capable section captures and how it
 * applies a saved bag back, for every selected layer, as one undo entry.
 *
 * The store (`sectionPresetStore`) holds flat `{ key: number | string |
 * boolean }` bags and knows nothing about what a key means; this module is
 * the schema. Four sections take presets:
 *
 *   transform   numeric transform props, written through the multi-selection
 *               seam (keyframed where the target is animated);
 *   text        the Text component's style props (family, size, weight,
 *               tracking, leading …), written as static component props;
 *   appearance  a solid fill colour and the stroke's scalar fields;
 *   material    the whole `MaterialParams` surface.
 *
 * Capture reads the PRIMARY layer; apply writes EVERY selected layer that can
 * take the value — so "make these three lower-thirds match the house style"
 * is one pick.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { updateNodeComponentProp } from './InspectorAPI';
import { getNodeFill, setNodeFill, solidFill } from '@core/paint/fill';
import { getNodeStroke, updateNodeStroke, type Stroke } from '@core/paint/stroke';
import { applyMaterialParams, normalizeMaterialParams, readNodeMaterialParams } from '@core/scene/material';
import type { PresetValues, PresetValue } from '@stores/sectionPresetStore';
import { applyPropertyBag, readPropertyValue, type ApplyOptions } from './multiSelection';

export type PresetSectionId = 'transform' | 'text' | 'appearance' | 'material';

/** The transform props a preset carries, in the order the section lists them. */
export const TRANSFORM_PRESET_PROPS: ReadonlyArray<string> = [
  'anchorX', 'anchorY', 'anchorZ',
  'x', 'y', 'z',
  'scaleX', 'scaleY',
  'width', 'height',
  'rotation', 'rotationX', 'rotationY',
  'orientationX', 'orientationY', 'orientationZ',
  'skew', 'skewAxis',
  'opacity', 'fillOpacity',
];

/** The Text component props a text-style preset carries. */
export const TEXT_PRESET_PROPS: ReadonlyArray<string> = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
  'letterSpacing', 'lineHeight', 'textTransform', 'fontVariant',
  'verticalScale', 'horizontalScale', 'baselineShift',
  'fill', 'stroke', 'strokeWidth', 'strokeOverFill',
];

const STROKE_PRESET_KEYS: ReadonlyArray<keyof Stroke> = ['enabled', 'color', 'width', 'opacity', 'align', 'cap', 'join'];

function isPresetValue(v: unknown): v is PresetValue {
  return typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' || typeof v === 'boolean';
}

function numericEntries(values: PresetValues): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

// ── Transform ───────────────────────────────────────────────────────

export function captureTransformPreset(nodeId: string, compTime: number): PresetValues {
  const out: Record<string, PresetValue> = {};
  for (const prop of TRANSFORM_PRESET_PROPS) {
    const v = readPropertyValue(nodeId, prop, compTime);
    if (v !== undefined) out[prop] = v;
  }
  return out;
}

export function applyTransformPreset(
  nodeIds: ReadonlyArray<string>,
  values: PresetValues,
  opts: Omit<ApplyOptions, 'label'>,
): void {
  applyPropertyBag(nodeIds, numericEntries(values), { ...opts, label: 'Apply Transform preset' });
}

// ── Component-prop bags (text) ──────────────────────────────────────

function componentOf(nodeId: string, type: string): { id: string; props: Record<string, unknown> } | null {
  const node = defaultSceneGraph.getNode(nodeId);
  const c = node?.components.find((x) => x.type === type);
  return c ? { id: c.id, props: c.props as Record<string, unknown> } : null;
}

export function captureTextPreset(nodeId: string): PresetValues {
  const text = componentOf(nodeId, 'Text');
  const out: Record<string, PresetValue> = {};
  if (!text) return out;
  for (const key of TEXT_PRESET_PROPS) {
    const v = text.props[key];
    if (isPresetValue(v)) out[key] = v;
  }
  return out;
}

/** Write a bag of component props onto every node that has the component. Returns how many props were written. */
export function applyComponentPropsPreset(
  nodeIds: ReadonlyArray<string>,
  componentType: string,
  values: PresetValues,
): number {
  let written = 0;
  for (const nodeId of nodeIds) {
    const comp = componentOf(nodeId, componentType);
    if (!comp) continue;
    for (const [key, value] of Object.entries(values)) {
      if (!isPresetValue(value)) continue;
      if (updateNodeComponentProp(defaultSceneGraph, nodeId, comp.id, key, value)) written += 1;
    }
  }
  return written;
}

export function applyTextPreset(nodeIds: ReadonlyArray<string>, values: PresetValues): number {
  return applyComponentPropsPreset(nodeIds, 'Text', values);
}

// ── Appearance ──────────────────────────────────────────────────────

export function captureAppearancePreset(nodeId: string): PresetValues {
  const out: Record<string, PresetValue> = {};
  const fill = getNodeFill(nodeId);
  if (fill?.type === 'solid') out.fillColor = fill.color;
  else if (fill === undefined) out.fillColor = '';
  const stroke = getNodeStroke(nodeId);
  if (stroke) {
    for (const key of STROKE_PRESET_KEYS) {
      const v = stroke[key];
      if (isPresetValue(v)) out[`stroke.${key}`] = v;
    }
  }
  return out;
}

export function applyAppearancePreset(nodeIds: ReadonlyArray<string>, values: PresetValues): number {
  let written = 0;
  const strokePatch: Partial<Stroke> = {};
  for (const key of STROKE_PRESET_KEYS) {
    const v = values[`stroke.${key}`];
    if (v !== undefined) (strokePatch as Record<string, PresetValue>)[key] = v;
  }
  const fillColor = values.fillColor;
  for (const nodeId of nodeIds) {
    if (!defaultSceneGraph.getNode(nodeId)) continue;
    if (typeof fillColor === 'string') {
      setNodeFill(nodeId, fillColor ? solidFill(fillColor) : undefined);
      written += 1;
    }
    if (Object.keys(strokePatch).length > 0) {
      updateNodeStroke(nodeId, strokePatch);
      written += 1;
    }
  }
  return written;
}

// ── Material ────────────────────────────────────────────────────────

export function captureMaterialPreset(nodeId: string): PresetValues {
  const params = readNodeMaterialParams(nodeId);
  const out: Record<string, PresetValue> = {};
  if (!params) return out;
  for (const [k, v] of Object.entries(params)) if (isPresetValue(v)) out[k] = v;
  return out;
}

export function applyMaterialPreset(nodeIds: ReadonlyArray<string>, values: PresetValues): number {
  let written = 0;
  const params = normalizeMaterialParams(values);
  for (const nodeId of nodeIds) {
    if (!defaultSceneGraph.getNode(nodeId)) continue;
    applyMaterialParams(nodeId, params);
    written += 1;
  }
  return written;
}
