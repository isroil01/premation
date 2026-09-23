/**
 * layerFieldEdits — command builders for the B3z LAYER FIELDS
 * (src/core/engine/layerFieldSpecs.ts, docs/ENGINE_API.md §15.9): the
 * structured configs a layer stores outside its keyframe tracks (Particle
 * emitter, Cloner, Physics, modifier stacks, Precompose, Essential Properties
 * overrides).
 *
 * A json field is written WHOLE: the panel computes the next value (its
 * current config with one key changed) and sends it; `null` clears it. The
 * engine stores it verbatim and records the exact inverse. Sending is the
 * caller's (`edit` for a click, `useEngineEdit().send` for a scrub).
 */

import type { Command, Value } from '@motion/engine-api';
import { isLayer } from '@core/engine/doc';
import { catalogFor } from '@core/engine/props';
import { values } from '@core/engine/propRefs';

/** True when the engine addresses `path` on this layer (the field's `when` holds). */
export function hasLayerField(nodeId: string, path: string): boolean {
  if (!isLayer(nodeId)) return false;
  try {
    return catalogFor(nodeId).byPath.has(path);
  } catch {
    return false;
  }
}

/** `setProperty` of a json field (`null` / `undefined` clears it), or [] when the layer has no such field. */
export function jsonFieldCommands(nodeId: string, path: string, value: unknown): Command[] {
  if (!hasLayerField(nodeId, path)) return [];
  // JSON drops `undefined` members, exactly like a save/reopen of the old fx write.
  const v: Value = values.json(value === undefined ? null : value);
  return [{ type: 'setProperty', prop: { layer: nodeId, path }, value: v }];
}

/** `setProperty` of a bool field, or [] when the layer has no such field. */
export function boolFieldCommands(nodeId: string, path: string, value: boolean): Command[] {
  if (!hasLayerField(nodeId, path)) return [];
  return [{ type: 'setProperty', prop: { layer: nodeId, path }, value: values.bool(value) }];
}
