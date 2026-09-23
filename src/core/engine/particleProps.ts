/**
 * PARTICLE EMITTER properties (B3z-a worker E1, ENGINE_API.md §15.9): a
 * particle layer's keyframeable numbers and colours as ordinary catalog
 * properties, addressable BEFORE they are animated (the stopwatch needs a
 * property to switch on).
 *
 *   layer/particle.<key>    scalar, animatable — keys on the `particle.<key>`
 *                           track (particleSim.ts PARTICLE_NUMERIC_KEYS), static
 *                           value `fx.particle[key]` (absent = the emitter
 *                           default, DEFAULT_PARTICLE_CONFIG)
 *   layer/particle.<color>  colour, animatable — keys on `particle.<color>_r/_g/_b/_a`
 *                           (PARTICLE_COLOR_KEYS), static value the hex at
 *                           `fx.particle[color]` (an unset Mid colour reads as
 *                           the Birth colour, as the renderer resolves it)
 *
 * The paths are the ones an animated track already had (`apiPathFor` puts an
 * unclaimed track under `layer/`), so nothing moves when a property becomes
 * animated. The whole emitter config stays addressable as the json field
 * `layer/particle` (layerFieldSpecs.ts) for its non-keyframeable settings.
 *
 * Present while the layer is a particle layer carrying an `fx.particle`
 * config. The C++ engine ports this (native/engine/src/core/props.cpp
 * `add_particle_bindings`); the key lists reach it as `fields.particle` in the
 * generated catalog data.
 */

import type { Value } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { DEFAULT_PARTICLE_CONFIG, PARTICLE_COLOR_KEYS, PARTICLE_NUMERIC_KEYS } from '@core/particles/particleSim';
import type { PropBinding } from './props';

const PREFIX = 'particle.';

function fxParticle(node: SceneNode): Record<string, unknown> | undefined {
  const raw = node.components.find((c) => c.type === 'fx')?.props.particle;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

/** The layer has the emitter properties. */
export function hasParticleProps(node: SceneNode): boolean {
  return readNodeKind(node) === 'particle' && fxParticle(node) !== undefined;
}

/** `particle.<key>` → key, or null for any other member / base. */
function particleKey(member: string): string | null {
  return member.startsWith(PREFIX) && member.length > PREFIX.length ? member.slice(PREFIX.length) : null;
}

const isNumericKey = (k: string): boolean => (PARTICLE_NUMERIC_KEYS as readonly string[]).includes(k);
const isColorKey = (k: string): boolean => (PARTICLE_COLOR_KEYS as readonly string[]).includes(k);

/** The emitter's bindings, numbers then colours, in table order. */
export function addParticleBindings(node: SceneNode, layerId: string, add: (b: PropBinding) => void, claimed: (member: string) => boolean): void {
  if (!hasParticleProps(node)) return;
  const defaults = DEFAULT_PARTICLE_CONFIG as unknown as Record<string, unknown>;
  for (const key of PARTICLE_NUMERIC_KEYS) {
    const member = `${PREFIX}${key}`;
    if (claimed(member)) continue;
    const meta = resolvePropertyMeta(member, layerId);
    const def = defaults[key];
    add({
      path: `layer/${member}`, name: meta.label || member, matchName: member, valueType: 'scalar', members: [member],
      animatable: true, unit: meta.unit ?? '',
      ...(typeof def === 'number' ? { defaultValue: { kind: 'scalar', value: def } as Value } : {}),
    });
  }
  for (const key of PARTICLE_COLOR_KEYS) {
    const base = `${PREFIX}${key}`;
    const members = [`${base}_r`, `${base}_g`, `${base}_b`, `${base}_a`];
    if (members.some(claimed)) continue;
    const meta = resolvePropertyMeta(base, layerId);
    add({
      path: `layer/${base}`, name: meta.label || base, matchName: base, valueType: 'color', members,
      colorBase: base, animatable: true, unit: '',
    });
  }
}

/** The static number of `particle.<key>` (stored, else the emitter default), or undefined when `member` is not one. */
export function readParticleStatic(node: SceneNode, member: string): number | undefined {
  const key = particleKey(member);
  if (key === null || !isNumericKey(key)) return undefined;
  const merged = { ...(DEFAULT_PARTICLE_CONFIG as unknown as Record<string, unknown>), ...(fxParticle(node) ?? {}) };
  const v = merged[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Write `particle.<key>` into the emitter config. Null when `member` is not
 * a particle number (the caller tries its other stores); false when the layer
 * has no config to write into.
 */
export function writeParticleStatic(nodeId: string, node: SceneNode, member: string, value: number): boolean | null {
  const key = particleKey(member);
  if (key === null || !isNumericKey(key)) return null;
  const cur = fxParticle(node);
  if (!cur) return false;
  defaultSceneGraph.setFxKey(nodeId, 'particle', { ...cur, [key]: value });
  return true;
}

/** The hex of colour base `particle.<color>` (an unset Mid = Birth), or undefined when `base` is not one. */
export function readParticleColor(node: SceneNode, base: string): string | undefined {
  const key = particleKey(base);
  if (key === null || !isColorKey(key)) return undefined;
  const merged = { ...(DEFAULT_PARTICLE_CONFIG as unknown as Record<string, unknown>), ...(fxParticle(node) ?? {}) };
  const v = merged[key] ?? merged.colorStart;
  return typeof v === 'string' ? v : undefined;
}

/** Store colour base `particle.<color>` := hex. Null when `base` is not one; false without a config. */
export function writeParticleColor(nodeId: string, node: SceneNode, base: string, hex: string): boolean | null {
  const key = particleKey(base);
  if (key === null || !isColorKey(key)) return null;
  const cur = fxParticle(node);
  if (!cur) return false;
  defaultSceneGraph.setFxKey(nodeId, 'particle', { ...cur, [key]: hex });
  return true;
}
