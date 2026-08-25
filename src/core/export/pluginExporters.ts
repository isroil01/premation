/**
 * Plugin-provided output formats.
 *
 * The editor writes MP4, WebM, GIF, MOV and three image sequences. A plugin can
 * add to that list: it declares an exporter in its manifest, the host renders
 * the composition and hands it frames, and the plugin returns the finished
 * bytes — which the HOST writes, through the same save dialog and output
 * directory every other format goes through. See `exporterSchema.ts` for why it
 * is arranged that way round.
 *
 * ── Read from the manifest, not from a running worker ──────────────────────
 *
 * The format list is built by walking installed manifests, exactly like the
 * layer-kind registry, so a plugin's format appears in the export dropdown
 * whether or not its worker is up. A dropdown that only lists the formats
 * belonging to plugins that happen to be awake is a dropdown whose contents
 * depend on what the user did earlier in the session.
 *
 * Choosing one is what starts the plugin — `openExport` activates it — which is
 * a stronger signal than any activation event: the user named it.
 */

import { usePluginStore } from '@stores/pluginStore';

/** A format id the rest of the app can pass around: `plugin:<pluginId>.<exporterId>`. */
export type PluginFormatId = `plugin:${string}`;

export interface PluginExporterEntry {
  format: PluginFormatId;
  pluginId: string;
  pluginName: string;
  exporterId: string;
  label: string;
  extension: string;
}

export function pluginFormatId(pluginId: string, exporterId: string): PluginFormatId {
  return `plugin:${pluginId}.${exporterId}`;
}

/**
 * Split a format id back into its parts.
 *
 * The plugin id contains dots (it is reverse-DNS) and the exporter id may not —
 * `exporterSchema` refuses one with a dot for exactly this reason — so the LAST
 * dot is the separator, and the split is unambiguous.
 */
export function parsePluginFormat(format: string): { pluginId: string; exporterId: string } | null {
  if (!format.startsWith('plugin:')) return null;
  const rest = format.slice('plugin:'.length);
  const cut = rest.lastIndexOf('.');
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { pluginId: rest.slice(0, cut), exporterId: rest.slice(cut + 1) };
}

export function isPluginFormat(format: string): format is PluginFormatId {
  return parsePluginFormat(format) !== null;
}

/**
 * Every exporter an installed, enabled plugin declares.
 *
 * Disabled plugins are omitted rather than shown greyed: an export format the
 * user can select and that then refuses is worse than one that is not offered,
 * because the refusal arrives after they have configured a render.
 */
export function pluginExporters(): PluginExporterEntry[] {
  const out: PluginExporterEntry[] = [];
  for (const entry of usePluginStore.getState().plugins) {
    if (!entry.enabled) continue;
    const m = entry.manifest;
    for (const e of m.contributes?.exporters ?? []) {
      out.push({
        format: pluginFormatId(m.id, e.id),
        pluginId: m.id,
        pluginName: m.name,
        exporterId: e.id,
        label: e.label,
        extension: e.extension,
      });
    }
  }
  return out;
}

/** The entry behind a format id, or null when the plugin is gone or disabled. */
export function pluginExporterFor(format: string): PluginExporterEntry | null {
  const split = parsePluginFormat(format);
  if (!split) return null;
  return pluginExporters().find(
    (e) => e.pluginId === split.pluginId && e.exporterId === split.exporterId,
  ) ?? null;
}
