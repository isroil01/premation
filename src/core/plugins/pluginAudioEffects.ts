/**
 * The registry of PLUGIN audio effects — which ones exist, and where the
 * builder finds them.
 *
 * Small and separate from `pluginEffects.ts` on purpose. That file compiles
 * shaders, holds a layout per pass and reports a compile state; an audio
 * effect has none of those. It is a declaration and nothing else, so the thing
 * that holds it is a map, and pretending otherwise would put an `EffectState`
 * on something that can never fail to compile.
 *
 * Registered on ENABLE, like visual effects and layer kinds, and for the same
 * reason: an audio effect has to be addable to a layer before the plugin's
 * worker boots. Nothing here runs plugin code — a declared node chain needs no
 * worker, which is exactly why this shape was chosen (see
 * `audioEffectSchema.ts`).
 */

import { setPluginAudioEffects, type AudioEffectLookup } from './pluginAudioGraph';
import type { AudioEffectContribution } from './audioEffectSchema';

export interface RegisteredAudioEffect {
  /** `<pluginId>.<effectId>` — what a document stores as the effect's type. */
  id: string;
  pluginId: string;
  pluginName: string;
  contribution: AudioEffectContribution;
}

const registry = new Map<string, RegisteredAudioEffect>();
const listeners = new Set<() => void>();

/** `<pluginId>.<effectId>`, the one namespacing rule. */
export function namespacedAudioEffect(pluginId: string, effectId: string): string {
  return `${pluginId}.${effectId}`;
}

export function registerAudioEffects(
  pluginId: string,
  pluginName: string,
  contributions: readonly AudioEffectContribution[],
): void {
  for (const contribution of contributions) {
    const id = namespacedAudioEffect(pluginId, contribution.id);
    registry.set(id, { id, pluginId, pluginName, contribution });
  }
  if (contributions.length > 0) notify();
}

export function unregisterAudioEffects(pluginId: string): void {
  let removed = false;
  for (const [id, entry] of [...registry]) {
    if (entry.pluginId !== pluginId) continue;
    registry.delete(id);
    removed = true;
  }
  /*
    A document that USES one keeps its stored effect entry. The layer does not
    lose its sound chain because a plugin was disabled — the builder finds
    nothing, the signal passes through untouched, and re-enabling the plugin
    makes it audible again with its parameters intact. Same rule as an
    uninstalled visual effect, which stays in the stack and draws nothing.
  */
  if (removed) notify();
}

export function registeredAudioEffects(): RegisteredAudioEffect[] {
  return [...registry.values()];
}

export function audioEffectById(id: string): RegisteredAudioEffect | undefined {
  return registry.get(id);
}

/** Subscribe to the set changing — the audio-effect menu redraws on it. */
export function subscribeToAudioEffects(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** For tests: forget everything. */
export function resetAudioEffectRegistry(): void {
  registry.clear();
  listeners.clear();
}

/*
  Hand the graph builder its lookup.

  Injected the same way the generator runner and the asset host are, and for
  the identical reason: `pluginAudioGraph` is reached from `audioEffects.ts`,
  which the export worker and the render-tests harness both build with no
  store and no plugin host behind them. A builder that imported this registry
  would drag the plugin system into every offline mixdown in the repo.
*/
const lookup: AudioEffectLookup = (type) => registry.get(type)?.contribution;
setPluginAudioEffects(lookup);
