import { packSolid, packTextured, packSolid3D, packShade3D, MAT3_STD140_FLOATS, MAT4_STD140_FLOATS, SHADE3D_FLOATS, MAX_LIGHTS3D, type Shade3DLight } from '../pipeline/uniforms';
import { Mat3 } from '../core/math/Mat3';
import { Mat4 } from '../core/math/Mat4';
import { Color } from '../core/math/Color';
import { toWorkingColor } from '../shaders/linearWorkingSpace';

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

  it('is mat3 + uvRect + tint + 3 colour rows + srcSpace = 36 floats', () => {
    const out = packTextured(I, uv, Color.white(), 1);
    expect(out.length).toBe(MAT3_STD140_FLOATS + 4 + 4 + 12 + 4);
  });

  it('defaults to identity colour rows (no grade): [1,0,0,0][0,1,0,0][0,0,1,0]', () => {
    const out = packTextured(I, uv, Color.white(), 1);
    const rows = Array.from(out.slice(MAT3_STD140_FLOATS + 4 + 4, MAT3_STD140_FLOATS + 4 + 4 + 12));
    expect(rows).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it('packs a colour transform as rows (matrix row + offset in .w)', () => {
    const ct = { m: [2, 0, 0, 0, 2, 0, 0, 0, 2], offset: [0.1, 0.2, 0.3] };
    const out = packTextured(I, uv, Color.white(), 1, ct);
    const rows = Array.from(out.slice(MAT3_STD140_FLOATS + 4 + 4, MAT3_STD140_FLOATS + 4 + 4 + 12));
    const expected = [2, 0, 0, 0.1, 0, 2, 0, 0.2, 0, 0, 2, 0.3];
    rows.forEach((v, i) => {
      expect(v).toBeCloseTo(expected[i]!);
    });
  });

  it('packs sampleLinear into srcSpace.x (layout; RT copies use the *-linear shader)', () => {
    const off = packTextured(I, uv, Color.white(), 1, undefined, false);
    expect(off[MAT3_STD140_FLOATS + 4 + 4 + 12]).toBe(0);
    const on = packTextured(I, uv, Color.white(), 1, undefined, true);
    expect(on[MAT3_STD140_FLOATS + 4 + 4 + 12]).toBe(1);
  });
});

describe('packShade3D (per-fragment 3D lighting tail)', () => {
  const light = (over: Partial<Shade3DLight> = {}): Shade3DLight => ({
    type: 'point', color: { r: 1, g: 0.5, b: 0.25 }, gain: 0.8,
    x: 10, y: 20, z: -30, radius: 500, aimX: 1, aimY: 0, halfConeRad: 0.5,
    ...over,
  });

  it('undefined shade → zero tail (lit flag 0), sized exactly SHADE3D_FLOATS', () => {
    const out = new Float32Array(SHADE3D_FLOATS);
    const next = packShade3D(out, 0, undefined);
    expect(next).toBe(SHADE3D_FLOATS);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('packs model, eye+lit flag, params and the first light in the documented slots', () => {
    const model = Array.from({ length: 16 }, (_, i) => i + 1);
    const out = new Float32Array(SHADE3D_FLOATS);
    packShade3D(out, 0, { model, eye: [7, 8, 9], specular: 0.5, shininess: 32, lights: [light()] });
    // model occupies the first 16 floats verbatim
    expect(Array.from(out.slice(0, 16))).toEqual(model);
    // eye + lit flag
    expect(Array.from(out.slice(16, 20))).toEqual([7, 8, 9, 1]);
    // params: count, specular, shininess, metal (absent ⇒ 0)
    expect(Array.from(out.slice(20, 24))).toEqual([1, 0.5, 32, 0]);
    // light: pos+type(point=1), color+gain, radius/halfCone/aim
    expect(Array.from(out.slice(24, 28))).toEqual([10, 20, -30, 1]);
    const colGain = Array.from(out.slice(28, 32));
    const expected = toWorkingColor({ r: 1, g: 0.5, b: 0.25, a: 1 });
    [expected.r, expected.g, expected.b, 0.8].forEach((v, i) => expect(colGain[i]!).toBeCloseTo(v, 6));
    expect(Array.from(out.slice(32, 36))).toEqual([500, 0.5, 1, 0]);
  });

  it('carries Metal in the spare shadeParams.w slot', () => {
    // Metal fits in padding that was already reserved, so it costs no uniform
    // layout change — but that also means a regression here is silent: the
    // value would simply never reach the shader.
    const out = new Float32Array(SHADE3D_FLOATS);
    packShade3D(out, 0, {
      model: new Array(16).fill(0), eye: [0, 0, 0], specular: 0.4, shininess: 20, metal: 0.75, lights: [light()],
    });
    expect(out[23]).toBeCloseTo(0.75, 6);
    // …and the neighbouring params are undisturbed.
    expect(out[21]).toBeCloseTo(0.4, 6);
    expect(out[22]).toBeCloseTo(20, 6);
  });

  it('toon rides the lit flag (3/4) and the shininess slot carries the bands', () => {
    const out = new Float32Array(SHADE3D_FLOATS);
    packShade3D(out, 0, {
      model: new Array(16).fill(0), eye: [0, 0, 0], specular: 0.4, shininess: 20,
      toonBands: 4, lights: [light()],
    });
    expect(out[19]).toBe(3); // lit flag: toon two-sided
    expect(out[22]).toBe(4); // bands in the shininess slot
    const oneSided = new Float32Array(SHADE3D_FLOATS);
    packShade3D(oneSided, 0, {
      model: new Array(16).fill(0), eye: [0, 0, 0], specular: 0, shininess: 1,
      toonBands: 9, oneSided: true, lights: [light()],
    });
    expect(oneSided[19]).toBe(4); // toon one-sided
    expect(oneSided[22]).toBe(8); // bands clamp to 8
  });

  it('filters zero-gain lights and truncates at MAX_LIGHTS3D', () => {
    const lights = [
      light({ gain: 0 }),
      ...Array.from({ length: MAX_LIGHTS3D + 3 }, () => light()),
    ];
    const out = new Float32Array(SHADE3D_FLOATS);
    packShade3D(out, 0, { model: new Array(16).fill(0), eye: [0, 0, 0], specular: 0, shininess: 1, lights });
    expect(out[20]).toBe(MAX_LIGHTS3D); // count capped, zero-gain dropped
  });

  it('packSolid3D appends the shade tail after mvp+color+shape', () => {
    const out = packSolid3D(Mat4.identity(), Color.white(), 1);
    expect(out.length).toBe(MAT4_STD140_FLOATS + 4 + 4 + SHADE3D_FLOATS);
  });
});
