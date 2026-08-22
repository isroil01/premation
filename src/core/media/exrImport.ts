/**
 * EXR → importable image. The asset pipeline (and the whole 8-bit renderer)
 * speaks browser-decodable images, so an imported .exr becomes a tone-mapped
 * PNG at the import seam: linear light → sRGB, alpha preserved, NaN/negative
 * lifted to black. The float planes themselves come from `decodeExr`; when
 * the compositor grows a float path this module is the one place to widen.
 *
 * Channel policy: R/G/B (case-insensitive) drive color; a lone Y (luminance)
 * channel becomes gray; A drives alpha when present. Renderer AOV channels
 * beyond those are ignored — this is footage import, not an AOV browser.
 */

import { decodeExr, type ExrImage } from './exr';

/** Linear-light → sRGB transfer, clamped. */
function srgb(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

function findChannel(img: ExrImage, name: string): Float32Array | null {
  const lower = name.toLowerCase();
  // Prefer exact name; layered files ("beauty.R") fall back to a suffix match.
  const exact = img.channels.find((c) => c.name.toLowerCase() === lower);
  if (exact) return exact.data;
  const suffix = img.channels.find((c) => c.name.toLowerCase().endsWith(`.${lower}`));
  return suffix ? suffix.data : null;
}

/** Tone-map decoded EXR planes into RGBA8 pixels. */
export function exrToRgba8(img: ExrImage, exposure = 0): Uint8ClampedArray<ArrayBuffer> {
  const gain = 2 ** exposure;
  const n = img.width * img.height;
  const y = findChannel(img, 'y');
  const r = findChannel(img, 'r') ?? y;
  const g = findChannel(img, 'g') ?? y;
  const b = findChannel(img, 'b') ?? y;
  const a = findChannel(img, 'a');
  if (!r || !g || !b) throw new Error('EXR has no displayable color channels (need R/G/B or Y).');
  const out = new Uint8ClampedArray(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    out[i * 4] = srgb((r[i]! || 0) * gain);
    out[i * 4 + 1] = srgb((g[i]! || 0) * gain);
    out[i * 4 + 2] = srgb((b[i]! || 0) * gain);
    out[i * 4 + 3] = a ? Math.round(Math.max(0, Math.min(1, a[i]!)) * 255) : 255;
  }
  return out;
}

/** Is this file an EXR by name (the browser reports no MIME for .exr)? */
export function isExrFile(file: File): boolean {
  return /\.exr$/i.test(file.name);
}

/**
 * Convert an .exr File into a PNG File the rest of the import pipeline can
 * treat as any other image. The PNG keeps the original basename so the asset
 * still reads as the file the user dropped.
 */
export async function convertExrToPngFile(file: File): Promise<File> {
  const img = await decodeExr(await file.arrayBuffer());
  const rgba = exrToRgba8(img);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable.');
  ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encode failed.');
  return new File([blob], file.name.replace(/\.exr$/i, '.png'), { type: 'image/png' });
}
