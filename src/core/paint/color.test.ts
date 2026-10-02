import { Color } from './color';

describe('Color', () => {
  it('parses hex forms', () => {
    expect(Color.equals(Color.fromHex('#ff0000'), Color.of(1, 0, 0, 1))).toBe(true);
    expect(Color.equals(Color.fromHex('#00ff0080'), Color.of(0, 1, 0, 128 / 255))).toBe(true);
    expect(Color.equals(Color.fromHex('#f00'), Color.of(1, 0, 0, 1))).toBe(true);
  });

  it('parses rgb() and rgba()', () => {
    expect(Color.equals(Color.fromHex('rgb(255, 0, 0)'), Color.of(1, 0, 0, 1))).toBe(true);
    expect(Color.equals(Color.fromHex('rgba(0,255,0,0.5)'), Color.of(0, 1, 0, 0.5))).toBe(true);
    expect(Color.equals(Color.fromHex('rgba(0 0 255 / 0.25)'), Color.of(0, 0, 1, 0.25))).toBe(true);
  });

  it('reads anything it cannot parse as opaque black', () => {
    expect(Color.fromHex('nope')).toEqual(Color.black());
    expect(Color.fromHex('#12345')).toEqual(Color.black());
    expect(Color.fromHex('rgb(a, b, c)')).toEqual(Color.black());
  });

  it('hands out a copy, so a caller cannot mutate the memoised parse', () => {
    const first = Color.fromHex('#336699');
    first.r = 0;
    expect(Color.fromHex('#336699').r).toBeCloseTo(0x33 / 255, 6);
  });

  it('writes an 8-digit hex and round-trips through it', () => {
    expect(Color.toHex(Color.of(1, 0, 0, 1))).toBe('#ff0000ff');
    expect(Color.toHex(Color.of(2, -1, 0.5, 0.5))).toBe('#ff008080');
    const c = Color.fromHex('#1a2b3c4d');
    expect(Color.toHex(c)).toBe('#1a2b3c4d');
  });

  it('premultiplies and unpacks', () => {
    expect(Color.premultiply(Color.of(1, 0.5, 0, 0.5))).toEqual({ r: 0.5, g: 0.25, b: 0, a: 0.5 });
    expect(Color.toArray(Color.of(0.1, 0.2, 0.3, 0.4))).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});
