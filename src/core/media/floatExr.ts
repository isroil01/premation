/**
 * Float EXR working media — keep linear float planes beside the 8-bit preview.
 *
 * Import still produces a PNG for the asset `src` (thumbnails, SDR fallback),
 * but the original float RGBA is retained in {@link floatExrCache} keyed by
 * asset id. Image layers can sample HDR values when the renderer asks.
 */

import { decodeExr, type ExrImage } from './exr';
import { exrToRgba8 } from './exrImport';

export interface FloatRgbaImage {
  width: number;
  height: number;
  /** Linear RGBA, length width*height*4. */
  rgba: Float32Array;
}

const cache = new Map<string, FloatRgbaImage>();

function findChannel(img: ExrImage, name: string): Float32Array | null {
  const lower = name.toLowerCase();
  const exact = img.channels.find((c) => c.name.toLowerCase() === lower);
  if (exact) return exact.data;
  const suffix = img.channels.find((c) => c.name.toLowerCase().endsWith(`.${lower}`));
  return suffix ? suffix.data : null;
}

export function exrToFloatRgba(img: ExrImage, exposure = 0): FloatRgbaImage {
  const gain = 2 ** exposure;
  const n = img.width * img.height;
  const y = findChannel(img, 'y');
  const r = findChannel(img, 'r') ?? y;
  const g = findChannel(img, 'g') ?? y;
  const b = findChannel(img, 'b') ?? y;
  const a = findChannel(img, 'a');
  if (!r || !g || !b) throw new Error('EXR has no displayable color channels');
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = (r[i]! || 0) * gain;
    rgba[i * 4 + 1] = (g[i]! || 0) * gain;
    rgba[i * 4 + 2] = (b[i]! || 0) * gain;
    rgba[i * 4 + 3] = a ? Math.max(0, a[i]!) : 1;
  }
  return { width: img.width, height: img.height, rgba };
}

export function setFloatExrForAsset(assetId: string, img: FloatRgbaImage): void {
  cache.set(assetId, img);
}

export function getFloatExrForAsset(assetId: string): FloatRgbaImage | undefined {
  return cache.get(assetId);
}

export function clearFloatExr(assetId: string): void {
  cache.delete(assetId);
}

/**
 * Decode EXR → float cache entry + tone-mapped PNG File for the asset `src`.
 */
export async function importExrWithFloat(
  file: File,
  assetId: string,
  exposure = 0,
): Promise<File> {
  const img = await decodeExr(await file.arrayBuffer());
  setFloatExrForAsset(assetId, exrToFloatRgba(img, exposure));
  const rgba8 = exrToRgba8(img, exposure);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('EXR: no 2d context');
  ctx.putImageData(new ImageData(rgba8, img.width, img.height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('EXR: PNG encode failed'))), 'image/png');
  });
  return new File([blob], file.name.replace(/\.exr$/i, '.png'), { type: 'image/png' });
}
