/**
 * Native plugin effects as editor effect definitions (AE parity 2.9).
 *
 * Built-in effects come from the generated catalog at build time; a plugin's
 * effects exist only while it is installed and loaded, so their definitions
 * come from the engine's `listEffects` (provider ≠ 'builtin') and are replaced
 * whenever plugins change (an install, a rescan, enable / disable). The
 * engine already describes plugin params in the catalog's own types (a point
 * is two numbers `p<id>X` / `p<id>Y`, a popup an `enum`), so the Effects
 * panel, the Add menu and the effect cards read them like any built-in.
 *
 * Pure registry with listeners: no React, no zustand (src/core). The React
 * read is `useAllEffectDefs` (layout/Effects/effectCatalog.ts).
 */

import type { EffectInfo, EngineClient } from '@motion/engine-api';
import type { EffectDef, EffectParamDef } from './effectCatalog';

/** A plugin effect's definition, with what only plugins have. */
export type PluginEffectDef = EffectDef & {
  /** The plugin id that provides it. */
  readonly provider: string;
  readonly category: string;
  /** Buttons: invokeEffectAction's action keys. */
  readonly actions: ReadonlyArray<{ key: string; label: string }>;
};

let defs: readonly PluginEffectDef[] = [];
let byType = new Map<string, PluginEffectDef>();
const listeners = new Set<() => void>();

const TYPE_OF: Record<string, EffectParamDef['type'] | undefined> = {
  scalar: 'number',
  int: 'number',
  color: 'color',
  bool: 'checkbox',
  choice: 'enum',
  layer: 'layer',
  string: 'maskPath',
};

/** One engine `EffectInfo` (a plugin's) → an editor effect definition. */
export function effectInfoToDef(info: EffectInfo): PluginEffectDef {
  const params: EffectParamDef[] = [];
  for (const p of info.params) {
    const type = TYPE_OF[p.valueType];
    if (!type) continue; // arbitrary data and the like: not a control
    const dv = p.defaultValue;
    const def = dv?.kind === 'scalar' || dv?.kind === 'int' ? dv.value : dv?.kind === 'bool' ? dv.value : undefined;
    params.push({
      key: p.matchName,
      label: p.name,
      type,
      ...(p.choices.length > 0 ? { options: p.choices.map((label, i) => ({ value: i + 1, label })) } : {}),
      ...(p.group ? { group: p.group } : {}),
      ...(p.unit ? { unit: p.unit } : {}),
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.precision !== undefined ? { precision: p.precision } : {}),
      ...(def !== undefined ? { default: def } : type === 'checkbox' ? { default: false } : type === 'enum' ? { default: 1 } : {}),
    });
  }
  return {
    type: info.matchName,
    label: info.displayName,
    params,
    ...(info.gpu ? { gpuOnly: true as const } : {}),
    provider: info.provider,
    category: info.category,
    actions: info.actions ?? [],
  };
}

export function setPluginEffectDefs(infos: readonly EffectInfo[]): void {
  defs = infos.filter((e) => e.provider !== 'builtin' && !e.audio).map(effectInfoToDef);
  byType = new Map(defs.map((d) => [d.type, d]));
  for (const l of listeners) l();
}

export function pluginEffectDefs(): readonly PluginEffectDef[] {
  return defs;
}

export function pluginEffectDefFor(type: string): PluginEffectDef | undefined {
  return byType.get(type);
}

export function isPluginEffectDef(def: EffectDef | undefined): def is PluginEffectDef {
  return !!def && typeof (def as Partial<PluginEffectDef>).provider === 'string';
}

export function subscribePluginEffectDefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Ask the engine again (after an install, a rescan, enable / disable). Never throws. */
export async function refreshPluginEffectDefs(client: Pick<EngineClient, 'query'>): Promise<void> {
  try {
    const res = await client.query({ type: 'listEffects', category: '' });
    if (res.ok) setPluginEffectDefs(res.value.effects);
  } catch {
    // The engine is restarting: the next refresh fills it in.
  }
}
