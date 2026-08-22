/**
 * DPX → importable PNG (tone-map at the import seam, same posture as EXR).
 */

import { decodeDpx } from './dpx';

function srgb(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

export function isDpxFile(file: File): boolean {
  return /\.dpx$/i.test(file.name);
}

export async function convertDpxToPngFile(file: File, exposure = 0): Promise<File> {
  const img = decodeDpx(await file.arrayBuffer());
  const gain = 2 ** exposure;
  const n = img.width * img.height;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = srgb(img.r[i]! * gain);
    rgba[i * 4 + 1] = srgb(img.g[i]! * gain);
    rgba[i * 4 + 2] = srgb(img.b[i]! * gain);
    rgba[i * 4 + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('DPX: no 2d context');
  ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('DPX: PNG encode failed'))), 'image/png');
  });
  return new File([blob], file.name.replace(/\.dpx$/i, '.png'), { type: 'image/png' });
}
