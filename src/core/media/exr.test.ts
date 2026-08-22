/**
 * EXR codec: encode→decode round-trips, the ZIP predictor transform, RLE and
 * ZIPS files assembled by hand (so the decoder is tested against the FORMAT,
 * not against our own encoder's habits), and named refusals for the variants
 * we do not read.
 */

import zlib from 'zlib';
import {
  decodeExr,
  encodeExr,
  exrPredictorDecode,
  exrPredictorEncode,
  floatToHalf,
  halfToFloat,
  type ExrImage,
} from './exr';

const W = 5;
const H = 4;

function testImage(): ExrImage {
  const n = W * H;
  const mk = (f: (i: number) => number): Float32Array => Float32Array.from({ length: n }, (_, i) => f(i));
  return {
    width: W,
    height: H,
    channels: [
      { name: 'R', data: mk((i) => i / n) },
      { name: 'G', data: mk((i) => 2 + Math.sin(i)) },      // > 1 — HDR range
      { name: 'B', data: mk((i) => (i % 3 === 0 ? 0 : 0.5)) },
      { name: 'A', data: mk(() => 1) },
    ],
  };
}

describe('half float', () => {
  it('round-trips representable values', () => {
    for (const v of [0, 1, -1, 0.5, 2, 1024, -0.25, 65504]) {
      expect(halfToFloat(floatToHalf(v))).toBeCloseTo(v, 3);
    }
  });
  it('handles infinities and overflow', () => {
    expect(halfToFloat(floatToHalf(Infinity))).toBe(Infinity);
    expect(halfToFloat(floatToHalf(1e6))).toBe(Infinity);
    expect(halfToFloat(floatToHalf(-Infinity))).toBe(-Infinity);
  });
});

describe('predictor transform', () => {
  it('round-trips arbitrary bytes', () => {
    const data = Uint8Array.from({ length: 257 }, (_, i) => (i * 37 + 11) % 256);
    expect([...exrPredictorDecode(exrPredictorEncode(data))]).toEqual([...data]);
  });
  it('round-trips odd and even lengths', () => {
    for (const len of [1, 2, 3, 8, 15]) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 91) % 256);
      expect([...exrPredictorDecode(exrPredictorEncode(data))]).toEqual([...data]);
    }
  });
});

describe('encode → decode round-trip', () => {
  it('is lossless for FLOAT', async () => {
    const img = testImage();
    const out = await decodeExr(encodeExr(img, { pixelType: 'float' }));
    expect(out.width).toBe(W);
    expect(out.height).toBe(H);
    // Encoder sorts channels by name (EXR requirement) — compare by name.
    for (const ch of img.channels) {
      const got = out.channels.find((c) => c.name === ch.name)!;
      expect([...got.data]).toEqual([...ch.data]);
    }
  });

  it('is half-precision-close for HALF', async () => {
    const img = testImage();
    const out = await decodeExr(encodeExr(img));
    for (const ch of img.channels) {
      const got = out.channels.find((c) => c.name === ch.name)!;
      for (let i = 0; i < ch.data.length; i++) {
        expect(got.data[i]!).toBeCloseTo(ch.data[i]!, 2);
      }
    }
  });
});

// ── Hand-assembled files (independent of our encoder) ────────────────

/** Build a single-channel HALF scanline EXR with the given compression. */
function buildExr(compression: number, values: number[][], transform: (raw: Uint8Array) => Uint8Array): ArrayBuffer {
  const h = values.length;
  const w = values[0]!.length;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const pushI32 = (v: number): void => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); parts.push(b); };
  const pushStr = (s: string): void => { parts.push(enc.encode(s), new Uint8Array([0])); };

  pushI32(20000630);
  pushI32(2);
  pushStr('channels'); pushStr('chlist');
  pushI32(2 + 16 + 1); // "Y\0" + 16-byte spec + terminator
  pushStr('Y');
  const spec = new Uint8Array(16);
  const sdv = new DataView(spec.buffer);
  sdv.setInt32(0, 1, true); // HALF
  sdv.setInt32(8, 1, true);
  sdv.setInt32(12, 1, true);
  parts.push(spec, new Uint8Array([0]));
  pushStr('compression'); pushStr('compression'); pushI32(1); parts.push(new Uint8Array([compression]));
  const box = new Uint8Array(16);
  new DataView(box.buffer).setInt32(8, w - 1, true);
  new DataView(box.buffer).setInt32(12, h - 1, true);
  pushStr('dataWindow'); pushStr('box2i'); pushI32(16); parts.push(box);
  pushStr('displayWindow'); pushStr('box2i'); pushI32(16); parts.push(box);
  pushStr('lineOrder'); pushStr('lineOrder'); pushI32(1); parts.push(new Uint8Array([0]));
  parts.push(new Uint8Array([0])); // header end

  // One line per block for NONE/RLE/ZIPS.
  const chunks: Uint8Array[] = [];
  for (let y = 0; y < h; y++) {
    const raw = new Uint8Array(w * 2);
    const dv = new DataView(raw.buffer);
    for (let x = 0; x < w; x++) dv.setUint16(x * 2, floatToHalf(values[y]![x]!), true);
    const packed = transform(raw);
    const chunk = new Uint8Array(8 + packed.length);
    const cdv = new DataView(chunk.buffer);
    cdv.setInt32(0, y, true);
    cdv.setInt32(4, packed.length, true);
    chunk.set(packed, 8);
    chunks.push(chunk);
  }

  const headerSize = parts.reduce((s, b) => s + b.length, 0);
  const table = new Uint8Array(h * 8);
  let off = headerSize + table.length;
  for (let y = 0; y < h; y++) {
    new DataView(table.buffer).setUint32(y * 8, off, true);
    off += chunks[y]!.length;
  }
  const total = headerSize + table.length + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of [...parts, table, ...chunks]) { out.set(b, o); o += b.length; }
  return out.buffer;
}

const GRID = [
  [0, 0.25, 0.5, 1],
  [2, 4, 8, 16],
  [1, 1, 1, 1],
];

describe('hand-assembled files', () => {
  it('decodes ZIPS (zlib + predictor)', async () => {
    const buf = buildExr(2, GRID, (raw) => new Uint8Array(zlib.deflateSync(exrPredictorEncode(raw))));
    const img = await decodeExr(buf);
    expect(img.width).toBe(4);
    expect(img.height).toBe(3);
    const y = img.channels.find((c) => c.name === 'Y')!;
    GRID.flat().forEach((v, i) => expect(y.data[i]!).toBeCloseTo(v, 3));
  });

  it('decodes RLE runs', async () => {
    // A constant row compresses to a run; EXR RLE shares the predictor step.
    const rle = (raw: Uint8Array): Uint8Array => {
      const t = exrPredictorEncode(raw);
      // Naive literal encoding: chunks of ≤127 literals — valid RLE, no runs.
      const out: number[] = [];
      for (let i = 0; i < t.length; i += 127) {
        const n = Math.min(127, t.length - i);
        out.push(256 - n, ...t.subarray(i, i + n));
      }
      return Uint8Array.from(out);
    };
    const img = await decodeExr(buildExr(1, GRID, rle));
    const y = img.channels.find((c) => c.name === 'Y')!;
    GRID.flat().forEach((v, i) => expect(y.data[i]!).toBeCloseTo(v, 3));
  });

  it('decodes uncompressed', async () => {
    const img = await decodeExr(buildExr(0, GRID, (raw) => raw));
    const y = img.channels.find((c) => c.name === 'Y')!;
    GRID.flat().forEach((v, i) => expect(y.data[i]!).toBeCloseTo(v, 3));
  });

  it('refuses PIZ with the reason named', async () => {
    await expect(decodeExr(buildExr(4, GRID, (raw) => raw))).rejects.toThrow(/PIZ/);
  });

  it('refuses non-EXR bytes', async () => {
    await expect(decodeExr(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).rejects.toThrow(/Not an OpenEXR/);
  });
});
