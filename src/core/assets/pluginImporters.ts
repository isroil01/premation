/**
 * Plugin-provided input formats.
 *
 * The mirror of `pluginExporters.ts`. Built by walking installed manifests, so
 * a plugin's format is claimed whether or not its worker is up — dropping a
 * file must not depend on what the user did earlier in the session. Opening one
 * is what starts the plugin.
 */

import { usePluginStore } from '@stores/pluginStore';

export interface PluginImporterEntry {
  pluginId: string;
  pluginName: string;
  importerId: string;
  label: string;
  extensions: readonly string[];
}

/** Every importer an installed, ENABLED plugin declares. */
export function pluginImporters(): PluginImporterEntry[] {
  const out: PluginImporterEntry[] = [];
  for (const entry of usePluginStore.getState().plugins) {
    if (!entry.enabled) continue;
    const m = entry.manifest;
    for (const i of m.contributes?.importers ?? []) {
      out.push({
        pluginId: m.id,
        pluginName: m.name,
        importerId: i.id,
        label: i.label,
        extensions: i.extensions,
      });
    }
  }
  return out;
}

/**
 * The importer claiming a file name, or null.
 *
 * FIRST match wins, in installation order. Two plugins claiming one extension
 * is refused at neither end — each manifest is valid on its own — so the tie is
 * broken here, deterministically, rather than by whichever worker happened to
 * register first.
 */
export function pluginImporterForFile(fileName: string): PluginImporterEntry | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return pluginImporters().find((e) => e.extensions.includes(ext)) ?? null;
}
