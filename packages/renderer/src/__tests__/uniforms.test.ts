import { packSolid, packTextured, MAT3_STD140_FLOATS } from '../pipeline/uniforms';
import { Mat3 } from '../core/math/Mat3';
import { Color } from '../core/math/Color';

const I = Mat3.identity();

describe('packSolid', () => {
  it('lays out mat3 (std140) + color + shape = 20 floats', () => {
    const out = packSolid(I, Color.white(), 1);
    expect(out.length).toBe(MAT3_STD140_FLOATS + 4 + 4); // 12 + 4 + 4 = 20
  });

  it('defaults the shape to a plain rect (kind 0) — masks/solids unchanged', () => {
    const out = packSolid(I, Color.white(), 1);
    const shape = out.slice(MAT3_STD140_FLOATS + 4);
    expect(Array.from(shape)).toEqual([0, 0, 0, 0]);
  });

  it('packs rounded-rect shape params (kind, radiusPx, w, h) after the color', () => {
    const out = packSolid(I, Color.white(), 1, { kind: 1, radiusPx: 12, width: 220, height: 140 });
    const shape = out.slice(MAT3_STD140_FLOATS + 4);
    expect(Array.from(shape)).toEqual([1, 12, 220, 140]);
  });

  it('packs ellipse shape kind 2', () => {
    const out = packSolid(I, Color.white(), 1, { kind: 2, radiusPx: 0, width: 200, height: 200 });
    expect(out[MAT3_STD140_FLOATS + 4]).toBe(2);
  });

  it('folds opacity into the color alpha', () => {
    const out = packSolid(I, Color.of(1, 1, 1, 1), 0.5);
    expect(out[MAT3_STD140_FLOATS + 3]).toBeCloseTo(0.5); // color.a * opacity
  });
});

describe('packTextured', () => {
  const uv = { x: 0, y: 0, width: 1, height: 1 };

  it('is mat3 + uvRect + tint + 3 colour rows = 32 floats', () => {
    const out = packTextured(I, uv, Color.white(), 1);
    expect(out.length).toBe(MAT3_STD140_FLOATS + 4 + 4 + 12);
  });

  it('defaults to identity colour rows (no grade): [1,0,0,0][0,1,0,0][0,0,1,0]', () => {
    const out = packTextured(I, uv, Color.white(), 1);
    const rows = Array.from(out.slice(MAT3_STD140_FLOATS + 4 + 4));
    expect(rows).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it('packs a colour transform as rows (matrix row + offset in .w)', () => {
    const ct = { m: [2, 0, 0, 0, 2, 0, 0, 0, 2], offset: [0.1, 0.2, 0.3] };
    const out = packTextured(I, uv, Color.white(), 1, ct);
    const rows = Array.from(out.slice(MAT3_STD140_FLOATS + 4 + 4));
    const expected = [2, 0, 0, 0.1, 0, 2, 0, 0.2, 0, 0, 2, 0.3];
    rows.forEach((v, i) => {
      expect(v).toBeCloseTo(expected[i]!);
    });
  });
});
