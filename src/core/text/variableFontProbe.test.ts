/**
 * The variable-font probe reads only the sfnt table directory.
 */

import { hasVariableAxes } from './variableFontProbe';

/** Build a minimal sfnt header with the given table tags. */
function sfnt(tags: string[], magic = 0x00010000): ArrayBuffer {
  const buf = new ArrayBuffer(12 + tags.length * 16);
  const v = new DataView(buf);
  v.setUint32(0, magic);
  v.setUint16(4, tags.length);
  tags.forEach((t, i) => {
    const o = 12 + i * 16;
    for (let c = 0; c < 4; c++) v.setUint8(o + c, t.charCodeAt(c));
    v.setUint32(o + 8, 0); v.setUint32(o + 12, 0);
  });
  return buf;
}

it('finds fvar in a TrueType directory', () => {
  expect(hasVariableAxes(sfnt(['head', 'fvar', 'glyf']))).toBe(true);
});
it('reports a static face as not variable', () => {
  expect(hasVariableAxes(sfnt(['head', 'glyf', 'hmtx']))).toBe(false);
});
it('handles CFF faces and a collection by its first face', () => {
  expect(hasVariableAxes(sfnt(['CFF ', 'fvar'], 0x4f54544f))).toBe(true);
  const face = sfnt(['fvar']);
  const ttc = new ArrayBuffer(16 + face.byteLength);
  const v = new DataView(ttc);
  v.setUint32(0, 0x74746366); v.setUint32(4, 0x00010000); v.setUint32(8, 1); v.setUint32(12, 16);
  new Uint8Array(ttc, 16).set(new Uint8Array(face));
  expect(hasVariableAxes(ttc)).toBe(true);
});
it('is false, not a throw, on garbage or a truncated directory', () => {
  expect(hasVariableAxes(new ArrayBuffer(3))).toBe(false);
  const v = new DataView(new ArrayBuffer(12)); v.setUint32(0, 0x00010000); v.setUint16(4, 40);
  expect(hasVariableAxes(v.buffer)).toBe(false);
});
