/**
 * Animation presets contributed by plugins.
 *
 * The third registry of this shape (after layer kinds and exporters) and it
 * follows the same rule: read from installed MANIFESTS, so a plugin's presets
 * appear in the Presets panel whether or not its worker is up. A preset is
 * data — tracks, expressions, animators — so applying one never needs the
 * plugin running at all.
 *
 * Foldered under the plugin's name rather than merged into the app's tree. A
 * preset that behaves oddly should be attributable without opening the plugin
 * manager, and a plugin should not be able to file itself among the built-ins
 * by naming a folder that already exists.
 */

import { usePluginStore } from '@stores/pluginStore';
import type { AnimationPreset } from './animationPresets';

export function pluginPresets(): AnimationPreset[] {
  const out: AnimationPreset[] = [];
  for (const entry of usePluginStore.getState().plugins) {
    if (!entry.enabled) continue;
    const m = entry.manifest;
    for (const p of m.contributes?.presets ?? []) {
      out.push({
        ...p,
        // Never `builtin` — the schema refuses the key, and this is the other
        // half of that promise.
        builtin: false,
        folder: p.folder ? `${m.name}/${p.folder}` : m.name,
      } as unknown as AnimationPreset);
    }
  }
  return out;
}
