/**
 * Layered Photoshop PSD import — RGB 8-bit, RLE or raw, one layer → one image.
 *
 * Parses the Image Resources + Layer and Mask Info sections enough to extract
 * each layer's RGBA bitmap. Not a full PSD library (no smart objects, text,
 * adjustment layers as live effects) — those become flat pixels like AE's
 * "Convert to Layers" import of raster content.
 */

export interface PsdLayer {
  name: string;
  width: number;
  height: number;
  /** Top-left of the layer in document space. */
  left: number;
  top: number;
  /** Premultiplied? No — straight RGBA8. */
  rgba: Uint8ClampedArray;
}

export interface PsdDocument {
  width: number;
  height: number;
  layers: PsdLayer[];
}

function readStr(view: DataView, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Decode PackBits RLE (Photoshop channel compression = 1). */
export function decodePackBits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let si = 0;
  let di = 0;
  while (di < expected && si < src.length) {
    const n = src[si++]!;
    if (n <= 127) {
      const count = n + 1;
      for (let i = 0; i < count && di < expected && si < src.length; i++) out[di++] = src[si++]!;
    } else if (n !== 128) {
      const count = 257 - n;
      const b = src[si++]!;
      for (let i = 0; i < count && di < expected; i++) out[di++] = b;
    }
  }
  return out;
}

/**
 * Decode a Photoshop .psd ArrayBuffer into document + layers.
 * Throws with a named reason when the file is unsupported.
 */
export function decodePsd(buf: ArrayBuffer): PsdDocument {
  const view = new DataView(buf);
  if (buf.byteLength < 26) throw new Error('PSD: file too small');
  if (readStr(view, 0, 4) !== '8BPS') throw new Error('PSD: not an 8BPS file');
  const version = view.getUint16(4, false);
  if (version !== 1) throw new Error('PSD: only version 1 (not PSB) is supported');
  const channels = view.getUint16(12, false);
  const height = view.getUint32(14, false);
  const width = view.getUint32(18, false);
  const depth = view.getUint16(22, false);
  const colorMode = view.getUint16(24, false);
  if (depth !== 8) throw new Error(`PSD: only 8-bit (got ${depth})`);
  if (colorMode !== 3) throw new Error(`PSD: only RGB mode (got ${colorMode})`);
  if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) {
    throw new Error('PSD: invalid dimensions');
  }

  let off = 26;
  // Color mode data
  const colorModeLen = view.getUint32(off, false);
  off += 4 + colorModeLen;
  // Image resources
  const resLen = view.getUint32(off, false);
  off += 4 + resLen;
  // Layer and mask info
  const layerMaskLen = view.getUint32(off, false);
  const layerMaskEnd = off + 4 + layerMaskLen;
  off += 4;

  const layers: PsdLayer[] = [];
  if (layerMaskLen > 0) {
    const layerInfoLen = view.getUint32(off, false);
    off += 4;
    if (layerInfoLen > 0) {
      const layerCountSigned = view.getInt16(off, false);
      off += 2;
      const layerCount = Math.abs(layerCountSigned);
      const records: Array<{
        top: number; left: number; bottom: number; right: number;
        channelCount: number;
        channelIds: number[];
        channelLens: number[];
        name: string;
      }> = [];

      for (let li = 0; li < layerCount; li++) {
        const top = view.getInt32(off, false); off += 4;
        const left = view.getInt32(off, false); off += 4;
        const bottom = view.getInt32(off, false); off += 4;
        const right = view.getInt32(off, false); off += 4;
        const channelCount = view.getUint16(off, false); off += 2;
        const channelIds: number[] = [];
        const channelLens: number[] = [];
        for (let c = 0; c < channelCount; c++) {
          channelIds.push(view.getInt16(off, false)); off += 2;
          channelLens.push(view.getUint32(off, false)); off += 4;
        }
        const blendSig = readStr(view, off, 4); off += 4;
        if (blendSig !== '8BIM') throw new Error('PSD: bad blend signature');
        off += 4; // blend mode key
        off += 1; // opacity
        off += 1; // clipping
        off += 1; // flags
        off += 1; // filler
        const extraLen = view.getUint32(off, false); off += 4;
        const extraEnd = off + extraLen;
        // Layer mask / blending ranges — skip to Pascal name at end of extra
        // Structure: mask data len, then blending ranges len, then name.
        if (extraLen >= 4) {
          const maskDataLen = view.getUint32(off, false);
          let p = off + 4 + maskDataLen;
          if (p + 4 <= extraEnd) {
            const blendRangeLen = view.getUint32(p, false);
            p += 4 + blendRangeLen;
          }
          // Pascal string name, padded to 4 bytes
          if (p < extraEnd) {
            const nameLen = view.getUint8(p);
            const name = readStr(view, p + 1, nameLen);
            records.push({
              top, left, bottom, right, channelCount, channelIds, channelLens, name: name || `Layer ${li + 1}`,
            });
          } else {
            records.push({
              top, left, bottom, right, channelCount, channelIds, channelLens, name: `Layer ${li + 1}`,
            });
          }
        }
        off = extraEnd;
      }

      // Channel image data follows records in the same order.
      for (const rec of records) {
        const lw = Math.max(0, rec.right - rec.left);
        const lh = Math.max(0, rec.bottom - rec.top);
        if (lw === 0 || lh === 0) {
          // Skip empty channel payloads
          for (const len of rec.channelLens) off += len;
          continue;
        }
        const planes = new Map<number, Uint8Array>();
        for (let c = 0; c < rec.channelCount; c++) {
          const id = rec.channelIds[c]!;
          const len = rec.channelLens[c]!;
          const chunk = new Uint8Array(buf, off, len);
          off += len;
          if (len < 2) continue;
          const compression = new DataView(chunk.buffer, chunk.byteOffset, 2).getUint16(0, false);
          const payload = chunk.subarray(2);
          const expected = lw * lh;
          let plane: Uint8Array;
          if (compression === 0) {
            plane = payload.subarray(0, expected);
          } else if (compression === 1) {
            // Row byte counts then RLE
            const rowCounts = new Uint16Array(lh);
            let p = 0;
            for (let y = 0; y < lh; y++) {
              rowCounts[y] = (payload[p]! << 8) | payload[p + 1]!;
              p += 2;
            }
            const packed = payload.subarray(p);
            plane = decodePackBits(packed, expected);
          } else {
            continue; // zip etc.
          }
          planes.set(id, plane.length >= expected ? plane : (() => {
            const full = new Uint8Array(expected);
            full.set(plane.subarray(0, Math.min(plane.length, expected)));
            return full;
          })());
        }
        const rgba = new Uint8ClampedArray(lw * lh * 4);
        const R = planes.get(0);
        const G = planes.get(1);
        const B = planes.get(2);
        const A = planes.get(-1) ?? planes.get(3);
        for (let i = 0; i < lw * lh; i++) {
          rgba[i * 4] = R?.[i] ?? 0;
          rgba[i * 4 + 1] = G?.[i] ?? 0;
          rgba[i * 4 + 2] = B?.[i] ?? 0;
          rgba[i * 4 + 3] = A?.[i] ?? 255;
        }
        layers.push({
          name: rec.name,
          width: lw,
          height: lh,
          left: rec.left,
          top: rec.top,
          rgba,
        });
      }
      void channels;
      void layerInfoLen;
    }
  }
  off = layerMaskEnd;

  // If no layers, synthesize one from the merged image data.
  if (layers.length === 0) {
    const compression = view.getUint16(off, false);
    off += 2;
    const expected = width * height;
    const planes: Uint8Array[] = [];
    if (compression === 0) {
      for (let c = 0; c < Math.min(channels, 4); c++) {
        planes.push(new Uint8Array(buf, off + c * expected, expected));
      }
    } else if (compression === 1) {
      // Skip row counts for all channels then decode — simplified: treat as unsupported merged RLE
      throw new Error('PSD: flat RLE merged image without layers is not supported — save with layers');
    }
    if (planes.length >= 3) {
      const rgba = new Uint8ClampedArray(expected * 4);
      for (let i = 0; i < expected; i++) {
        rgba[i * 4] = planes[0]![i]!;
        rgba[i * 4 + 1] = planes[1]![i]!;
        rgba[i * 4 + 2] = planes[2]![i]!;
        rgba[i * 4 + 3] = planes[3]?.[i] ?? 255;
      }
      layers.push({ name: 'Background', width, height, left: 0, top: 0, rgba });
    }
  }

  return { width, height, layers };
}

export function isPsdFile(file: File): boolean {
  return /\.psd$/i.test(file.name);
}

/** Convert one PSD layer to a PNG File for the asset pipeline. */
export async function psdLayerToPngFile(layer: PsdLayer, docName: string): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = layer.width;
  canvas.height = layer.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('PSD: no 2d context');
  ctx.putImageData(new ImageData(layer.rgba, layer.width, layer.height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PSD: PNG encode failed'))), 'image/png');
  });
  const safe = layer.name.replace(/[^\w.-]+/g, '_') || 'layer';
  const base = docName.replace(/\.psd$/i, '');
  return new File([blob], `${base}_${safe}.png`, { type: 'image/png' });
}
