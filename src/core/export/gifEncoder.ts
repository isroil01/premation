/**
 * Growable byte buffer. This was a `number[]` pushed one byte at a time — for
 * a 100MB GIF that is a hundred million boxed array slots plus a final
 * element-by-element copy, and the encode spent longer feeding the array than
 * compressing pixels. A doubling Uint8Array keeps writes at memcpy speed.
 */
class ByteStream {
  private buf = new Uint8Array(64 * 1024);
  private len = 0;

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  write(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  writeBytes(bytes: Uint8Array) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  writeUTF8(s: string) {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) {
      this.buf[this.len++] = s.charCodeAt(i) & 0xff;
    }
  }

  writeUint16(v: number) {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  }

  getUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function compressLZW(pixels: Uint8Array, colorDepth: number): Uint8Array {
  const initCodeSize = colorDepth;
  const clearCode = 1 << initCodeSize;
  const eoiCode = clearCode + 1;

  let codeSize = initCodeSize + 1;
  let nextCode = eoiCode + 1;

  // Dictionary keyed numerically as (prefixCode << 8) | nextByte. The previous
  // implementation built a JavaScript STRING per pixel (`currentStr + c`) and
  // used it as a Map key — for a 1080p frame that is two million string
  // allocations and hashes per frame, and it dominated the whole encode. The
  // root single-byte codes 0..clearCode-1 are implicit (code === byte), so the
  // map only ever holds multi-byte sequences.
  const dict = new Map<number, number>();

  const out = new Uint8Array(pixels.length * 2);
  let outPtr = 0;

  let accum = 0;
  let bits = 0;

  const writeCode = (code: number) => {
    accum |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out[outPtr++] = accum & 0xff;
      accum >>= 8;
      bits -= 8;
    }
  };

  writeCode(clearCode);

  if (pixels.length === 0) {
    writeCode(eoiCode);
    if (bits > 0) out[outPtr++] = accum & 0xff;
    return out.slice(0, outPtr);
  }

  let current = pixels[0]!; // a root code — the first pixel's own value
  for (let i = 1; i < pixels.length; i++) {
    const c = pixels[i]!;
    const key = (current << 8) | c;
    const found = dict.get(key);
    if (found !== undefined) {
      current = found;
    } else {
      writeCode(current);
      dict.set(key, nextCode++);
      if (nextCode === (1 << codeSize) + 1) {
        codeSize++;
      } else if (nextCode > 4095) {
        writeCode(clearCode);
        dict.clear();
        codeSize = initCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      current = c;
    }
  }
  writeCode(current);
  writeCode(eoiCode);

  if (bits > 0) {
    out[outPtr++] = accum & 0xff;
  }

  return out.slice(0, outPtr);
}

function createFixed332Palette(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  for (let r = 0; r < 8; r++) {
    for (let g = 0; g < 8; g++) {
      for (let b = 0; b < 4; b++) {
        const idx = (r << 5) | (g << 2) | b;
        palette[idx * 3] = Math.round((r * 255) / 7);
        palette[idx * 3 + 1] = Math.round((g * 255) / 7);
        palette[idx * 3 + 2] = Math.round((b * 255) / 3);
      }
    }
  }
  return palette;
}

const fixed332Palette = createFixed332Palette();

function generatePalette(rgbaPixels: Uint8ClampedArray): {
  palette: Uint8Array;
  indexMap: Map<number, number> | null;
  hasTransparency: boolean;
} {
  const uniqueColors = new Set<number>();
  let hasTransparency = false;
  for (let i = 0; i < rgbaPixels.length; i += 4) {
    const a = rgbaPixels[i + 3]!;
    if (a < 128) {
      hasTransparency = true;
      continue;
    }
    const r = rgbaPixels[i]!;
    const g = rgbaPixels[i + 1]!;
    const b = rgbaPixels[i + 2]!;
    const key = (r << 16) | (g << 8) | b;
    uniqueColors.add(key);

    if (uniqueColors.size > 255) {
      return { palette: fixed332Palette, indexMap: null, hasTransparency };
    }
  }

  const palette = new Uint8Array(256 * 3);
  const indexMap = new Map<number, number>();
  let idx = 0;
  for (const key of uniqueColors) {
    palette[idx * 3] = (key >> 16) & 0xff;
    palette[idx * 3 + 1] = (key >> 8) & 0xff;
    palette[idx * 3 + 2] = key & 0xff;
    indexMap.set(key, idx);
    idx++;
  }
  for (let i = idx; i < 256; i++) {
    palette[i * 3] = 0;
    palette[i * 3 + 1] = 0;
    palette[i * 3 + 2] = 0;
  }
  return { palette, indexMap, hasTransparency };
}

function mapPixel(
  r: number,
  g: number,
  b: number,
  a: number,
  indexMap: Map<number, number> | null,
  hasTransparency: boolean
): number {
  if (hasTransparency && a < 128) {
    return 255;
  }
  if (indexMap) {
    const key = (r << 16) | (g << 8) | b;
    return indexMap.get(key) ?? 0;
  }
  const rIdx = Math.round((r * 7) / 255);
  const gIdx = Math.round((g * 7) / 255);
  const bIdx = Math.round((b * 3) / 255);
  const val = (rIdx << 5) | (gIdx << 2) | bIdx;
  if (hasTransparency && val === 255) {
    return 254;
  }
  return val;
}

export interface GifFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/**
 * Creates an animated GIF from a sequence of frames and returns it as a Uint8Array of bytes.
 */
export function createAnimatedGIFBytes(frames: GifFrame[], fps: number): Uint8Array {
  if (frames.length === 0) {
    return new Uint8Array(0);
  }

  const stream = new ByteStream();
  const width = frames[0]!.width;
  const height = frames[0]!.height;

  // 1. Header
  stream.writeUTF8('GIF89a');

  // 2. Logical Screen Descriptor
  stream.writeUint16(width);
  stream.writeUint16(height);
  // Packed: No Global Color Table, color resolution 8 bits
  stream.write(0x70);
  stream.write(0); // Background Color Index
  stream.write(0); // Pixel Aspect Ratio

  // 3. Netscape Looping Extension (infinite loop)
  stream.write(0x21); // Extension Introducer
  stream.write(0xff); // Application Extension Label
  stream.write(0x0b); // Block Size (11 bytes)
  stream.writeUTF8('NETSCAPE2.0');
  stream.write(0x03); // Sub-block Size (3 bytes)
  stream.write(0x01); // Loop count ID
  stream.writeUint16(0); // Loop count (0 = infinite)
  stream.write(0x00); // Sub-block Terminator

  // Frame delays in 1/100ths of a second, with the ROUNDING ERROR CARRIED
  // FORWARD frame to frame (what ffmpeg and AE do). A single rounded delay
  // for every frame made 30fps GIFs play at 33.3fps (a 10s clip in 9s) and
  // 24fps at 25 — the accumulator keeps total duration exact by alternating
  // e.g. 3/3/4 centiseconds. GIF's 2cs hardware floor still caps >50fps.
  const delayFor = (i: number): number =>
    Math.max(2, Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps));

  // 4. Frames
  let frameIndex = 0;
  for (const frame of frames) {
    const { palette, indexMap, hasTransparency } = generatePalette(frame.pixels);

    // Graphic Control Extension
    stream.write(0x21); // Extension Introducer
    stream.write(0xf9); // Graphic Control Label
    stream.write(0x04); // Block Size
    // Packed: Disposal method 2 (restore to background), transparency flag
    const packedGce = (2 << 2) | (hasTransparency ? 1 : 0);
    stream.write(packedGce);
    stream.writeUint16(delayFor(frameIndex));
    frameIndex += 1;
    stream.write(hasTransparency ? 255 : 0); // Transparent Color Index (255)
    stream.write(0x00); // Block Terminator

    // Image Descriptor
    stream.write(0x2c); // Image Separator
    stream.writeUint16(0); // Image Left
    stream.writeUint16(0); // Image Top
    stream.writeUint16(frame.width);
    stream.writeUint16(frame.height);
    // Packed: Local Color Table, Size = 256 colors (2^(7+1) = 256)
    stream.write(0x87);

    // Local Color Table
    stream.writeBytes(palette);

    // Indexed pixels
    const indexed = new Uint8Array(frame.width * frame.height);
    for (let i = 0; i < frame.width * frame.height; i++) {
      const idx = i * 4;
      indexed[i] = mapPixel(
        frame.pixels[idx]!,
        frame.pixels[idx + 1]!,
        frame.pixels[idx + 2]!,
        frame.pixels[idx + 3]!,
        indexMap,
        hasTransparency
      );
    }

    // LZW Minimum Code Size
    stream.write(8);

    // Compress pixels
    const compressed = compressLZW(indexed, 8);

    // Pack into blocks of <= 255 bytes
    let ptr = 0;
    while (ptr < compressed.length) {
      const blockSize = Math.min(255, compressed.length - ptr);
      stream.write(blockSize);
      stream.writeBytes(compressed.subarray(ptr, ptr + blockSize));
      ptr += blockSize;
    }
    stream.write(0); // Block Terminator
  }

  // 5. Trailer
  stream.write(0x3b);

  return stream.getUint8Array();
}

/**
 * Creates an animated GIF from a sequence of frames and returns it as a Blob.
 */
export function createAnimatedGIF(frames: GifFrame[], fps: number): Blob {
  const bytes = createAnimatedGIFBytes(frames, fps);
  if (bytes.length === 0) {
    return new Blob([], { type: 'image/gif' });
  }
  return new Blob([bytes as BlobPart], { type: 'image/gif' });
}
