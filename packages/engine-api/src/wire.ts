/**
 * The byte-level half of the engine API codec (docs/ENGINE_API.md §9).
 *
 * The generated codec (./generated/codec.ts) is a list of calls into these two
 * classes. The encoding is the protobuf wire format — varint keys
 * `field << 3 | wireType`, zigzag signed varints, little-endian fixed32 /
 * fixed64 floats, length-delimited strings, messages and packed numeric lists —
 * written canonically so the TypeScript and C++ encoders agree byte for byte.
 *
 * Integers: every 64-bit field is a JS `number`, so it must be a safe integer
 * (|n| ≤ 2^53 − 1). The encoder throws on anything else rather than silently
 * rounding; engine ids and flick times (§3) stay far inside that range.
 *
 * No React, no DOM, no editor state (CLAUDE.md layering).
 */

/** Wire types. */
export const WT_VARINT = 0;
export const WT_FIXED64 = 1;
export const WT_LEN = 2;
export const WT_FIXED32 = 5;

export type DecodeErrorCode = 'truncated' | 'malformed' | 'missingField' | 'unknownVariant' | 'badEnum' | 'badValue';

/** Any failure to decode. A decode error never yields a partial value. */
export class DecodeError extends Error {
  constructor(
    message: string,
    readonly code: DecodeErrorCode = 'malformed',
  ) {
    super(message);
    this.name = 'DecodeError';
  }
}

const TWO_32 = 4294967296;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class Writer {
  buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(initialSize = 256) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
  }

  reset(): void {
    this.pos = 0;
  }

  /** A copy of the bytes written so far (the writer is reused). */
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  /** A view of the bytes written so far — valid until the next write/reset. */
  written(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  /** Unsigned varint of a non-negative safe integer. */
  varint(n: number): void {
    this.ensure(10);
    const buf = this.buf;
    let pos = this.pos;
    if (n < 0x80000000) {
      // Fast path: bit ops are exact below 2^31.
      while (n > 0x7f) {
        buf[pos++] = (n & 0x7f) | 0x80;
        n >>>= 7;
      }
      buf[pos++] = n;
    } else {
      while (n >= 0x80) {
        buf[pos++] = (n % 128) + 128;
        n = Math.floor(n / 128);
      }
      buf[pos++] = n;
    }
    this.pos = pos;
  }

  bool(b: boolean): void {
    this.byte(b ? 1 : 0);
  }

  u32(n: number): void {
    if (!(n >= 0 && n <= 0xffffffff && Number.isInteger(n))) throw new RangeError(`u32 out of range: ${n}`);
    this.varint(n);
  }

  i32(n: number): void {
    if (!(n >= -0x80000000 && n <= 0x7fffffff && Number.isInteger(n))) throw new RangeError(`i32 out of range: ${n}`);
    this.varint(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  u64(n: number): void {
    if (!(n >= 0 && Number.isSafeInteger(n))) throw new RangeError(`u64 must be a non-negative safe integer: ${n}`);
    this.varint(n);
  }

  i64(n: number): void {
    // zigzag doubles the magnitude, so the encodable range is [-2^52, 2^52 - 1].
    if (!(Number.isSafeInteger(n) && n >= -(2 ** 52) && n < 2 ** 52)) throw new RangeError(`i64 must be an integer in [-2^52, 2^52): ${n}`);
    this.varint(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  f32(x: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, x, true);
    this.pos += 4;
  }

  f64(x: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, x, true);
    this.pos += 8;
  }

  /** Length-prefixed UTF-8. ASCII (every id and path) takes the copy-free fast path. */
  str(s: string): void {
    const n = s.length;
    if (n < 128) {
      this.ensure(n + 1);
      const buf = this.buf;
      let pos = this.pos + 1;
      let ascii = true;
      for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i);
        if (c > 0x7f) {
          ascii = false;
          break;
        }
        buf[pos++] = c;
      }
      if (ascii) {
        buf[this.pos] = n;
        this.pos = pos;
        return;
      }
    }
    const bytes = utf8Encoder.encode(s);
    this.varint(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  bytes(b: Uint8Array): void {
    this.varint(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  /** Start a length-delimited body: reserve one length byte, return the body start. */
  beginLd(): number {
    this.ensure(1);
    this.pos += 1;
    return this.pos;
  }

  /** Finish a body begun at `start`; widens the length prefix (and shifts) past 127 bytes. */
  endLd(start: number): void {
    const len = this.pos - start;
    if (len < 128) {
      this.buf[start - 1] = len;
      return;
    }
    let extra = 0;
    for (let v = len; v >= 128; v = Math.floor(v / 128)) extra++;
    this.ensure(extra);
    this.buf.copyWithin(start + extra, start, this.pos);
    let p = start - 1;
    let v = len;
    while (v >= 128) {
      this.buf[p++] = (v % 128) + 128;
      v = Math.floor(v / 128);
    }
    this.buf[p] = v;
    this.pos += extra;
  }
}

export class Reader {
  readonly buf: Uint8Array;
  private readonly view: DataView;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  varint(): number {
    const buf = this.buf;
    let pos = this.pos;
    let b = buf[pos++];
    if (b === undefined) throw new DecodeError('truncated varint', 'truncated');
    if (b < 0x80) {
      this.pos = pos;
      return b;
    }
    let result = b & 0x7f;
    let mul = 128;
    for (let i = 1; i < 10; i++) {
      b = buf[pos++];
      if (b === undefined) throw new DecodeError('truncated varint', 'truncated');
      result += (b & 0x7f) * mul;
      if (b < 0x80) {
        this.pos = pos;
        if (result > Number.MAX_SAFE_INTEGER) throw new DecodeError('varint exceeds 2^53', 'badValue');
        return result;
      }
      mul *= 128;
    }
    throw new DecodeError('varint longer than 10 bytes', 'malformed');
  }

  bool(): boolean {
    const n = this.varint();
    if (n > 1) throw new DecodeError(`bool out of range: ${n}`, 'badValue');
    return n === 1;
  }

  u32(): number {
    const n = this.varint();
    if (n >= TWO_32) throw new DecodeError(`u32 out of range: ${n}`, 'badValue');
    return n;
  }

  i32(): number {
    const n = this.i64();
    if (n < -0x80000000 || n > 0x7fffffff) throw new DecodeError(`i32 out of range: ${n}`, 'badValue');
    return n;
  }

  u64(): number {
    return this.varint();
  }

  i64(): number {
    const z = this.varint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  f32(): number {
    if (this.pos + 4 > this.buf.length) throw new DecodeError('truncated f32', 'truncated');
    const x = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return x;
  }

  f64(): number {
    if (this.pos + 8 > this.buf.length) throw new DecodeError('truncated f64', 'truncated');
    const x = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return x;
  }

  /** Read a length prefix and return where that body ends (bounds-checked). */
  ldEnd(): number {
    const len = this.varint();
    const end = this.pos + len;
    if (end > this.buf.length) throw new DecodeError('length-delimited field runs past the end', 'truncated');
    return end;
  }

  str(): string {
    const end = this.ldEnd();
    const buf = this.buf;
    const start = this.pos;
    const n = end - start;
    if (n < 64) {
      let s = '';
      let ascii = true;
      for (let i = start; i < end; i++) {
        const c = buf[i]!;
        if (c > 0x7f) {
          ascii = false;
          break;
        }
        s += String.fromCharCode(c);
      }
      if (ascii) {
        this.pos = end;
        return s;
      }
    }
    let s: string;
    try {
      s = utf8Decoder.decode(buf.subarray(start, end));
    } catch {
      throw new DecodeError('invalid UTF-8', 'badValue');
    }
    this.pos = end;
    return s;
  }

  bytes(): Uint8Array {
    const end = this.ldEnd();
    const out = this.buf.slice(this.pos, end);
    this.pos = end;
    return out;
  }

  /** Skip an unknown field (forward compatibility), given its full key. */
  skip(key: number): void {
    switch (key & 7) {
      case WT_VARINT:
        this.varint();
        return;
      case WT_FIXED64:
        this.pos += 8;
        break;
      case WT_LEN:
        this.pos = this.ldEnd();
        return;
      case WT_FIXED32:
        this.pos += 4;
        break;
      default:
        throw new DecodeError(`unsupported wire type ${key & 7}`, 'malformed');
    }
    if (this.pos > this.buf.length) throw new DecodeError('truncated field', 'truncated');
  }

  /** A body must end exactly where its length said it would. */
  expectAt(end: number): void {
    if (this.pos !== end) throw new DecodeError('field overran its enclosing message', 'malformed');
  }
}
