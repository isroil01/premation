import { decodeDpx, isDpxMagic } from './dpx';

/** Build a minimal big-endian 10-bit packed RGB DPX (header + pixels). */
function buildDpx(w: number, h: number, fill: (i: number) => [number, number, number]): ArrayBuffer {
  const header = 2048;
  const buf = new ArrayBuffer(header + w * h * 4);
  const view = new DataView(buf);
  view.setUint32(0, 0x53445058, false); // SDPX
  view.setUint32(4, header, false);
  view.setUint32(772, w, false);
  view.setUint32(776, h, false);
  view.setUint16(800, 50, false); // RGB
  view.setUint16(802, 10, false); // 10-bit
  view.setUint16(806, 0, false); // packed
  view.setUint16(808, 0, false); // uncompressed
  for (let i = 0; i < w * h; i++) {
    const [R, G, B] = fill(i);
    const r = Math.round(R * 1023) & 0x3ff;
    const g = Math.round(G * 1023) & 0x3ff;
    const b = Math.round(B * 1023) & 0x3ff;
    const word = (r << 22) | (g << 12) | (b << 2);
    view.setUint32(header + i * 4, word, false);
  }
  return buf;
}

describe('dpx', () => {
  it('detects magic', () => {
    const buf = buildDpx(2, 2, () => [1, 0, 0]);
    expect(isDpxMagic(buf)).toBe(true);
  });

  it('round-trips a solid red pixel', () => {
    const buf = buildDpx(1, 1, () => [1, 0, 0]);
    const img = decodeDpx(buf);
    expect(img.width).toBe(1);
    expect(img.r[0]).toBeCloseTo(1, 2);
    expect(img.g[0]).toBeCloseTo(0, 2);
    expect(img.b[0]).toBeCloseTo(0, 2);
  });
});
