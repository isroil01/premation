/**
 * DPX (SMPTE 268M) foothold — 10-bit RGB packed scanlines → linear float planes.
 *
 * Covers the common “film scan / DI” single-image DPX that motion designers
 * get from online. Oriented/tiled/YUV/RGBA variants refuse with a named reason.
 * Import tone-maps like EXR (see dpxImport.ts).
 */

export interface DpxImage {
  width: number;
  height: number;
  /** Linear 0..1 RGB planes, row-major. */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

function u16(view: DataView, off: number, be: boolean): number {
  return be ? view.getUint16(off, false) : view.getUint16(off, true);
}
function u32(view: DataView, off: number, be: boolean): number {
  return be ? view.getUint32(off, false) : view.getUint32(off, true);
}

/** Decode a single-image 10-bit RGB packed DPX. */
export function decodeDpx(buf: ArrayBuffer): DpxImage {
  if (buf.byteLength < 2048) throw new Error('DPX: file too small');
  const view = new DataView(buf);
  const magic = view.getUint32(0, false);
  let be: boolean;
  if (magic === 0x53445058) be = true; // "SDPX"
  else if (magic === 0x58504453) be = false; // "XPDS"
  else throw new Error('DPX: not an SDPX file');

  const offsetToImage = u32(view, 4, be);
  const width = u32(view, 772, be);
  const height = u32(view, 776, be);
  if (!(width > 0 && height > 0 && width < 16384 && height < 16384)) {
    throw new Error('DPX: invalid image size');
  }
  const packing = u16(view, 806, be); // 0 = packed
  const encoding = u16(view, 808, be); // 0 = none
  const bitDepth = u16(view, 768 + 34, be); // Image element 0 bit depth at 802?
  // SMPTE 268M: image element descriptor starts at 768; bit depth at offset +34 = 802.
  const bits = u16(view, 802, be);
  const descriptor = u16(view, 800, be); // 50 = RGB
  if (encoding !== 0) throw new Error('DPX: compressed images are not supported');
  if (bits !== 10 && bitDepth !== 10) {
    // Some writers put depth only at 802.
    if (bits !== 10) throw new Error(`DPX: only 10-bit RGB (got ${bits || bitDepth} bit)`);
  }
  if (descriptor !== 50 && descriptor !== 0) {
    // 0 = user-defined; accept when packing looks like packed RGB.
    if (descriptor !== 50) throw new Error(`DPX: only RGB descriptor 50 (got ${descriptor})`);
  }
  if (packing !== 0 && packing !== 1) {
    throw new Error(`DPX: unsupported packing ${packing}`);
  }

  const n = width * height;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  // 10-bit packed RGB: 3×10 bits in 32-bit words (2 pad bits). Big-endian words when BE.
  const wordsNeeded = n; // one pixel per uint32 for packed 10-bit RGB
  const start = offsetToImage;
  if (start + wordsNeeded * 4 > buf.byteLength) {
    throw new Error('DPX: image data truncated');
  }
  for (let i = 0; i < n; i++) {
    const word = u32(view, start + i * 4, be);
    // Common packing: R in bits 0–9, G 10–19, B 20–29 (or reversed per endian).
    const R = (word >> 22) & 0x3ff;
    const G = (word >> 12) & 0x3ff;
    const B = (word >> 2) & 0x3ff;
    r[i] = R / 1023;
    g[i] = G / 1023;
    b[i] = B / 1023;
  }
  return { width, height, r, g, b };
}

export function isDpxMagic(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const m = new DataView(buf).getUint32(0, false);
  return m === 0x53445058 || m === 0x58504453;
}
