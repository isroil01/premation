/**
 * materialEdits — Material Options writes over the engine API (B3z,
 * docs/ENGINE_API.md §15.9). Pure command builders; sending is the caller's.
 *
 *   Material Options ▸ Casts Shadows / Accepts Shadows (Off · On · Only) and
 *   Accepts Lights (Off · On) are the catalog's scalar rows `material/…`
 *   (0/1/2 and 0/1, hold-friendly keyframe values — After Effects keys them as
 *   enum properties). Their STATIC form stays the legacy one (absent / false /
 *   'only', true / absent): both engines' static seam translates.
 *
 *   Shading model, Toon Bands, Height Map, Displacement Subdivisions and the
 *   per-face overrides are static LAYER FIELDS (layerFieldSpecs.ts).
 *
 *   A material (a library entry or a Material preset) is ONE batch: every
 *   Material Option of every target layer, keyed at the playhead where the
 *   option is animated (AE: applying a preset to an animated property sets a
 *   key) — a client macro (§1 rule 7).
 */

import type { Command, PropertyWrite, Value } from '@motion/engine-api';
import { isLayer } from '@core/engine/doc';
import { catalogFor } from '@core/engine/props';
import { compTime, values } from '@core/engine/propRefs';
import { normalizeMaterialParams, type MaterialParams } from '@core/scene/material';
import { valueCommands } from './inspectorEdits';

type ShadowMode = 'off' | 'on' | 'only';

/** A shadow tri-state as its track value (AE parity: 0 = Off, 1 = On, 2 = Only). */
export function shadowModeValue(mode: ShadowMode): number {
  return mode === 'off' ? 0 : mode === 'only' ? 2 : 1;
}

/** True when the engine addresses `path` on this layer. */
export function hasPath(nodeId: string, path: string): boolean {
  if (!isLayer(nodeId)) return false;
  try {
    return catalogFor(nodeId).byPath.has(path);
  } catch {
    return false;
  }
}

/** `setProperty` of one static field on each layer that has it (empty when none does). */
export function fieldCommands(nodeIds: ReadonlyArray<string>, path: string, value: Value): Command[] {
  const writes: PropertyWrite[] = nodeIds.filter((id) => hasPath(id, path)).map((layer) => ({ prop: { layer, path }, value }));
  return writes.length > 0 ? [{ type: 'setProperties', writes }] : [];
}

/** The numeric Material Options of a material, as stored track values. */
function numericOptions(p: MaterialParams): Record<string, number> {
  return {
    acceptsLights: p.acceptsLights ? 1 : 0,
    castsShadows: shadowModeValue(p.castsShadows),
    acceptsShadows: shadowModeValue(p.acceptsShadows),
    lightTransmission: p.lightTransmission,
    ambient: p.ambient,
    diffuse: p.diffuse,
    metal: p.metal,
    specular: p.specular,
    shininess: p.shininess,
    roughness: p.roughness,
    reflectionIntensity: p.reflectionIntensity,
    reflectionSharpness: p.reflectionSharpness,
    reflectionRolloff: p.reflectionRolloff,
    transparency: p.transparency,
    transparencyRolloff: p.transparencyRolloff,
    ior: p.ior,
  };
}

/**
 * A whole material onto every target layer as ONE command list: every axis is
 * written (a material states a COMPLETE surface — Plastic after Gold must not
 * keep Gold's roughness), nothing outside Material Options is touched.
 */
export function materialCommands(nodeIds: ReadonlyArray<string>, raw: unknown, seconds: number): Command[] {
  const p = normalizeMaterialParams(raw);
  const layers = nodeIds.filter((id) => isLayer(id));
  const out: Command[] = [...valueCommands(layers.map((nodeId) => ({ nodeId, values: numericOptions(p) })), { seconds })];
  const time = compTime(seconds);
  const writes: PropertyWrite[] = [];
  for (const layer of layers) {
    if (hasPath(layer, 'material/shading')) writes.push({ prop: { layer, path: 'material/shading' }, value: values.choice(p.shading), time });
    if (hasPath(layer, 'material/toonBands')) writes.push({ prop: { layer, path: 'material/toonBands' }, value: values.scalar(p.toonBands), time });
  }
  if (writes.length > 0) out.push({ type: 'setProperties', writes });
  return out;
}
