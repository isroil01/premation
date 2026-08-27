/**
 * The seam between the export pipeline and the plugin host.
 *
 * One indirection, and it earns its file: `videoSink.ts` is imported by the
 * render worker path and by both dialogs, and a static import of `PluginHost`
 * from there pulls the entire plugin runtime — workers, storage, the registry —
 * into every one of those bundles. Loaded on demand, it costs nothing until a
 * user actually picks a plugin format.
 */

import type { PluginExporterEntry } from './pluginExporters';

export interface PluginExportSession {
  addFrame(index: number, width: number, height: number, pixels: ArrayBuffer): Promise<void>;
  finish(): Promise<ArrayBuffer>;
  dispose(): Promise<void>;
}

export async function openPluginExport(
  entry: PluginExporterEntry,
  info: { width: number; height: number; fps: number; durationSec: number; compositionName: string },
): Promise<PluginExportSession> {
  const { pluginHost } = await import('@core/plugins/PluginHost');
  return pluginHost.openExport(entry.pluginId, entry.exporterId, info);
}
