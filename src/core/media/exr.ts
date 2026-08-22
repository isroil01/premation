/**
 * OpenEXR codec — the file-format half of the EXR/HDR pipeline.
 *
 * DECODE: single-part SCANLINE images, compressions NONE / RLE / ZIPS / ZIP,
 * pixel types HALF / FLOAT / UINT, both line orders. That covers what
 * renderers actually hand motion designers (Blender/Arnold/Nuke zip16 or
 * uncompressed exports). Tiled, deep, multipart, PIZ/PXR24/B44/DWA refuse
 * with a named reason instead of an opaque parse error — re-export as ZIP.
 *
 * ENCODE: uncompressed HALF/FLOAT scanline files, enough to round-trip float
 * planes losslessly (FLOAT) and to hand frames to other packages.
 *
 * Deliberately DOM-free (ArrayBuffer in, Float32 planes out) so jest can
 * round-trip synthetic images; the canvas/tone-map leg lives in exrImport.ts.
 * The zlib inflate is the runtime's own (DecompressionStream, or node:zlib
 * under jest) — EXR's ZIP blocks are plain zlib streams after the
 * predictor+interleave transform, both implemented here.
 */

export interface ExrChannel {
  name: string;
  /** Row-major, dataWindow width × height. UINT channels are cast to float. */
  data: Float32Array;
}

export interface ExrImage {
  width: number;
  height: number;
  channels: ExrChannel[];
}

const MAGIC = 20000630;

const PIXEL_BYTES = [4, 2, 4] as const; // UINT, HALF, FLOAT

// ── half-float ───────────────────────────────────────────────────────

export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24; // subnormal
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

export function floatToHalf(f: number): number {
  if (Number.isNaN(f)) return 0x7e00;
  const sign = f < 0 || Object.is(f, -0) ? 0x8000 : 0;
  const a = Math.abs(f);
  if (a === 0) return sign;
  if (a === Infinity || a >= 65520) return sign | 0x7c00; // > half max → inf
  if (a < 2 ** -24) return sign; // underflow to zero
  if (a < 2 ** -14) return sign | Math.round(a * 2 ** 24); // subnormal
  const exp = Math.floor(Math.log2(a));
  const frac = a / 2 ** exp - 1;
  let e = exp + 15;
  let m = Math.round(frac * 1024);
  if (m === 1024) { m = 0; e += 1; }
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | m;
}

// ── zlib inflate (runtime-appropriate) ───────────────────────────────

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate'); // zlib-wrapped, as EXR writes
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  // jest / node fallback.
  const zlib = await import('zlib');
  return new Uint8Array(zlib.inflateSync(bytes));
}

// ── EXR's predictor + interleave transform (ZIP and RLE share it) ────

/** Forward transform (encode side): interleave then delta-predict. */
export function exrPredictorEncode(data: Uint8Array): Uint8Array {
  const n = data.length;
  const out = new Uint8Array(n);
  // Split: first half = even indices, second half = odd indices.
  const half = Math.floor((n + 1) / 2);
  for (let i = 0, j = 0; j < n; i++, j += 2) out[i] = data[j]!;
  for (let i = half, j = 1; j < n; i++, j += 2) out[i] = data[j]!;
  // Delta with +128 bias, in place, front to back — mirror of the decoder's
  // cumulative sum. Walk BACKWARDS so each delta reads the original byte.
  for (let i = n - 1; i >= 1; i--) out[i] = (out[i]! - out[i - 1]! + 128 + 256) & 0xff;
  return out;
}

/** Inverse transform (decode side): un-delta then de-interleave. */
export function exrPredictorDecode(data: Uint8Array): Uint8Array {
  const n = data.length;
  const tmp = new Uint8Array(data);
  for (let i = 1; i < n; i++) tmp[i] = (tmp[i - 1]! + tmp[i]! - 128 + 256) & 0xff;
  const out = new Uint8Array(n);
  const half = Math.floor((n + 1) / 2);
  for (let i = 0, j = 0; i < half && j < n; i++, j += 2) out[j] = tmp[i]!;
  for (let i = half, j = 1; i < n && j < n; i++, j += 2) out[j] = tmp[i]!;
  return out;
}

// ── EXR RLE ──────────────────────────────────────────────────────────

function rleDecode(data: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < data.length && o < expected) {
    let n = data[i++]!;
    if (n > 127) n -= 256; // signed byte
    if (n < 0) {
      const count = -n;
      out.set(data.subarray(i, i + count), o);
      i += count;
      o += count;
    } else {
      const count = n + 1;
      const v = data[i++]!;
      out.fill(v, o, o + count);
      o += count;
    }
  }
  return out;
}

// ── header parsing ───────────────────────────────────────────────────

class Reader {
  pos = 0;
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
    this.bytes = new Uint8Array(buf);
  }
  u8(): number { return this.view.getUint8(this.pos++); }
  i32(): number { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  str(): string {
    let end = this.pos;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    const s = new TextDecoder().decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }
  raw(n: number): Uint8Array { const v = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return v; }
}

interface ChannelSpec {
  name: string;
  pixelType: number; // 0 UINT, 1 HALF, 2 FLOAT
}

/** Decode a single-part scanline EXR into per-channel float planes. */
export async function decodeExr(buf: ArrayBuffer): Promise<ExrImage> {
  const r = new Reader(buf);
  if (r.i32() !== MAGIC) throw new Error('Not an OpenEXR file.');
  const version = r.i32();
  if (version & 0x200) throw new Error('Tiled EXR is not supported — re-export as scanline.');
  if (version & 0x800) throw new Error('Deep EXR is not supported.');
  if (version & 0x1000) throw new Error('Multi-part EXR is not supported — export a single part.');

  const channels: ChannelSpec[] = [];
  let compression = -1;
  let dataWindow: { xMin: number; yMin: number; xMax: number; yMax: number } | null = null;
  let lineOrder = 0;

  for (;;) {
    const name = r.str();
    if (name === '') break;
    const type = r.str();
    const size = r.i32();
    const attrEnd = r.pos + size;
    if (name === 'channels' && type === 'chlist') {
      for (;;) {
        const ch = r.str();
        if (ch === '') break;
        const pixelType = r.i32();
        r.pos += 4; // pLinear + reserved
        const xs = r.i32();
        const ys = r.i32();
        if (xs !== 1 || ys !== 1) throw new Error(`Subsampled channel "${ch}" is not supported.`);
        if (pixelType < 0 || pixelType > 2) throw new Error(`Unknown pixel type in channel "${ch}".`);
        channels.push({ name: ch, pixelType });
      }
    } else if (name === 'compression' && type === 'compression') {
      compression = r.u8();
    } else if (name === 'dataWindow' && type === 'box2i') {
      dataWindow = { xMin: r.i32(), yMin: r.i32(), xMax: r.i32(), yMax: r.i32() };
    } else if (name === 'lineOrder' && type === 'lineOrder') {
      lineOrder = r.u8();
    }
    r.pos = attrEnd;
  }

  if (!dataWindow) throw new Error('EXR header has no dataWindow.');
  if (channels.length === 0) throw new Error('EXR header has no channels.');
  // 0 NONE, 1 RLE, 2 ZIPS (1 line), 3 ZIP (16 lines) — the supported set.
  const linesPerBlock = compression === 3 ? 16 : 1;
  if (compression < 0 || compression > 3) {
    const names: Record<number, string> = { 4: 'PIZ', 5: 'PXR24', 6: 'B44', 7: 'B44A', 8: 'DWAA', 9: 'DWAB' };
    throw new Error(`EXR compression ${names[compression] ?? compression} is not supported — re-export as ZIP or uncompressed.`);
  }
  if (lineOrder > 1) throw new Error('Random-Y line order is not supported.');

  const width = dataWindow.xMax - dataWindow.xMin + 1;
  const height = dataWindow.yMax - dataWindow.yMin + 1;
  if (width <= 0 || height <= 0 || width * height > 268_435_456) {
    throw new Error('EXR data window is empty or unreasonably large.');
  }

  const bytesPerPixel = channels.reduce((sum, c) => sum + PIXEL_BYTES[c.pixelType as 0 | 1 | 2], 0);
  const blocks = Math.ceil(height / linesPerBlock);
  r.pos += blocks * 8; // offset table — chunks follow sequentially anyway

  const planes = channels.map((c) => ({ spec: c, data: new Float32Array(width * height) }));

  for (let b = 0; b < blocks; b++) {
    // Each chunk names its own first scanline, so DECREASING_Y only changes
    // the order chunks appear in the file — the same addressing works.
    const yStart = r.i32() - dataWindow.yMin; // block's first line, 0-based
    const packedSize = r.i32();
    const nLines = Math.max(1, Math.min(linesPerBlock, height - yStart));
    const expected = nLines * width * bytesPerPixel;
    const packed = r.raw(packedSize);

    let raw: Uint8Array;
    if (compression === 0 || packedSize === expected) {
      // NONE, or a ZIP/RLE block stored raw because compression didn't help —
      // writers fall back to the ORIGINAL bytes then, so packed size equals
      // (never exceeds) the unpacked size. `>=` here misread small compressed
      // blocks whose zlib overhead outweighed the win.
      raw = packed.subarray(0, expected);
    } else if (compression === 1) {
      raw = exrPredictorDecode(rleDecode(packed, expected));
    } else {
      raw = exrPredictorDecode((await inflate(packed)).subarray(0, expected));
    }

    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let off = 0;
    for (let line = 0; line < nLines; line++) {
      const row = yStart + line;
      for (const plane of planes) {
        const base = row * width;
        const pt = plane.spec.pixelType;
        if (pt === 1) {
          for (let x = 0; x < width; x++, off += 2) plane.data[base + x] = halfToFloat(dv.getUint16(off, true));
        } else if (pt === 2) {
          for (let x = 0; x < width; x++, off += 4) plane.data[base + x] = dv.getFloat32(off, true);
        } else {
          for (let x = 0; x < width; x++, off += 4) plane.data[base + x] = dv.getUint32(off, true);
        }
      }
    }
  }

  return { width, height, channels: planes.map((p) => ({ name: p.spec.name, data: p.data })) };
}

// ── encode (uncompressed scanline) ───────────────────────────────────

export interface EncodeExrOptions {
  /** 'half' (file-size, standard) or 'float' (lossless round-trip). */
  pixelType?: 'half' | 'float';
}

/** Encode float planes as an uncompressed single-part scanline EXR. */
export function encodeExr(image: ExrImage, opts: EncodeExrOptions = {}): ArrayBuffer {
  const { width, height } = image;
  const half = (opts.pixelType ?? 'half') === 'half';
  const ptCode = half ? 1 : 2;
  const pixelBytes = half ? 2 : 4;
  // EXR requires channels sorted by name.
  const channels = [...image.channels].sort((a, b) => (a.name < b.name ? -1 : 1));

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const push = (v: Uint8Array): void => { parts.push(v); };
  const pushI32 = (v: number): void => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); push(b); };
  const pushStr = (s: string): void => { push(enc.encode(s)); push(new Uint8Array([0])); };

  pushI32(MAGIC);
  pushI32(2); // version 2, no flags

  // channels attribute
  {
    pushStr('channels'); pushStr('chlist');
    const body: Uint8Array[] = [];
    for (const c of channels) {
      body.push(enc.encode(c.name), new Uint8Array([0]));
      const b = new Uint8Array(16);
      const dv = new DataView(b.buffer);
      dv.setInt32(0, ptCode, true);
      dv.setInt32(8, 1, true); // xSampling
      dv.setInt32(12, 1, true); // ySampling
      body.push(b);
    }
    body.push(new Uint8Array([0]));
    const size = body.reduce((s, b) => s + b.length, 0);
    pushI32(size);
    for (const b of body) push(b);
  }
  pushStr('compression'); pushStr('compression'); pushI32(1); push(new Uint8Array([0])); // NONE
  const box = new Uint8Array(16);
  {
    const dv = new DataView(box.buffer);
    dv.setInt32(8, width - 1, true);
    dv.setInt32(12, height - 1, true);
  }
  pushStr('dataWindow'); pushStr('box2i'); pushI32(16); push(box);
  pushStr('displayWindow'); pushStr('box2i'); pushI32(16); push(box);
  pushStr('lineOrder'); pushStr('lineOrder'); pushI32(1); push(new Uint8Array([0]));
  const one = new Uint8Array(4);
  new DataView(one.buffer).setFloat32(0, 1, true);
  pushStr('pixelAspectRatio'); pushStr('float'); pushI32(4); push(one);
  const swc = new Uint8Array(8);
  pushStr('screenWindowCenter'); pushStr('v2f'); pushI32(8); push(swc);
  pushStr('screenWindowWidth'); pushStr('float'); pushI32(4); push(one);
  push(new Uint8Array([0])); // end of header

  const headerSize = parts.reduce((s, b) => s + b.length, 0);
  const lineBytes = width * pixelBytes * channels.length;
  const chunkBytes = 8 + lineBytes;
  const offsetTable = new Uint8Array(height * 8);
  {
    const dv = new DataView(offsetTable.buffer);
    for (let y = 0; y < height; y++) {
      const off = headerSize + offsetTable.length + y * chunkBytes;
      dv.setUint32(y * 8, off >>> 0, true);
      dv.setUint32(y * 8 + 4, Math.floor(off / 2 ** 32), true);
    }
  }
  push(offsetTable);

  for (let y = 0; y < height; y++) {
    const chunk = new Uint8Array(chunkBytes);
    const dv = new DataView(chunk.buffer);
    dv.setInt32(0, y, true);
    dv.setInt32(4, lineBytes, true);
    let off = 8;
    for (const c of channels) {
      const base = y * width;
      if (half) {
        for (let x = 0; x < width; x++, off += 2) dv.setUint16(off, floatToHalf(c.data[base + x]!), true);
      } else {
        for (let x = 0; x < width; x++, off += 4) dv.setFloat32(off, c.data[base + x]!, true);
      }
    }
    push(chunk);
  }

  const total = parts.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out.buffer;
}
