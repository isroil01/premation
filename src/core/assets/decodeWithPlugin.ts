/**
 * Turn a file a plugin can read into one the rest of the app already can.
 *
 * The PSD branch in `addAsset` established the shape: decode the exotic thing
 * into a PNG `File` and recurse. Everything downstream — the bundle, the
 * thumbnail, the asset record, the undo entry — then works with no knowledge
 * that a plugin was involved, which is what keeps a plugin format a first-class
 * import rather than a parallel one.
 *
 * `PluginHost` is imported lazily so the asset store does not pull the plugin
 * runtime into its bundle for a branch most imports never take.
 */

import { pluginImporterForFile, type PluginImporterEntry } from './pluginImporters';

/** RGBA pixels → a PNG File, via a canvas the browser already knows how to encode. */
async function pixelsToPngFile(
  width: number,
  height: number,
  pixels: ArrayBuffer,
  name: string,
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas to hold the decoded image.');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode the decoded image.');
  const base = name.replace(/\.[^.]+$/, '') || 'import';
  return new File([blob], `${base}.png`, { type: 'image/png' });
}

/**
 * Decode `file` with whichever plugin claims its extension, or null when none
 * does — which is the ordinary case and not an error.
 */
export async function decodeWithPlugin(file: File): Promise<File | null> {
  const entry: PluginImporterEntry | null = pluginImporterForFile(file.name);
  if (!entry) return null;

  const { pluginHost } = await import('@core/plugins/PluginHost');
  const bytes = await file.arrayBuffer();
  const image = await pluginHost.runImport(entry.pluginId, entry.importerId, file.name, bytes);
  return pixelsToPngFile(image.width, image.height, image.pixels, file.name);
}
