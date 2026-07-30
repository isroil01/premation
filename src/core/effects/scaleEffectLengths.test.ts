/**
 * Baked layer styles must keep their size RELATIVE to the content they
 * decorate, whatever resolution the raster happens to be built at.
 *
 * The CPU bake chain runs at identity on a canvas that is the layer's box times
 * a raster scale, while the content is drawn through `ctx.scale(ss, ss)`. Raw
 * parameters therefore made a style's weight depend on the raster resolution —
 * and because the raster cache is keyed on a QUANTIZED tier while the draw uses
 * the raw scale, one texture is reused across a whole tier and stretched. On
 * text scaling 0.25×→4× that showed up as a black stroke whose thickness
 * relative to the glyphs held ~5.7%, then snapped to ~3.1% at a tier boundary
 * and stayed there: an edge that visibly thinned out mid-animation.
 *
 * Verified end-to-end in the golden harness (the only faithful rasterizer); this
 * pins the transform the fix rests on.
 */

import { scaleEffectLengths, paramsOf, effectNumber, type Effect } from './effects';

const fx = (type: string, params: Record<string, unknown>): Effect =>
  ({ id: `x:${type}`, type, params } as unknown as Effect);

describe('scaleEffectLengths', () => {
  it('scales px parameters', () => {
    const [out] = scaleEffectLengths([fx('stroke', { width: 5, opacity: 100 })], 4)!;
    expect(effectNumber(out!, 'width')).toBe(20);
  });

  it('leaves angles, percentages and colours ALONE', () => {
    // Scaling an angle would rotate the style as the layer grew; scaling an
    // opacity would fade it out. Only lengths are lengths.
    const [out] = scaleEffectLengths(
      [fx('inner-shadow', { distance: 6, angle: 135, softness: 8, opacity: 55, color: '#123456' })],
      3,
    )!;
    expect(effectNumber(out!, 'distance')).toBe(18);
    expect(effectNumber(out!, 'softness')).toBe(24);
    expect(effectNumber(out!, 'angle')).toBe(135);
    expect(effectNumber(out!, 'opacity')).toBe(55);
    expect(paramsOf(out!).color).toBe('#123456');
  });

  it('scales a parameter left at its DECLARED DEFAULT, not just an explicit one', () => {
    // paramsOf folds defaults in, so a style the user never touched still has
    // to scale — otherwise it is the one that misbehaves.
    const [out] = scaleEffectLengths([fx('stroke', { opacity: 100 })], 2)!;
    expect(effectNumber(out!, 'width')).toBe(6); // declared default 3
  });

  it('is the identity at scale 1, and passes empty/absent through', () => {
    const one = [fx('stroke', { width: 5 })];
    expect(scaleEffectLengths(one, 1)).toBe(one);
    expect(scaleEffectLengths(undefined, 4)).toBeUndefined();
    expect(scaleEffectLengths([], 4)).toEqual([]);
  });

  it('ignores a non-positive scale rather than collapsing every style to zero', () => {
    const one = [fx('stroke', { width: 5 })];
    expect(scaleEffectLengths(one, 0)).toBe(one);
    expect(scaleEffectLengths(one, -2)).toBe(one);
  });

  it('does not mutate the input', () => {
    const src = [fx('stroke', { width: 5 })];
    scaleEffectLengths(src, 4);
    expect(effectNumber(src[0]!, 'width')).toBe(5);
  });

  it('covers every px parameter of a multi-length style', () => {
    const [out] = scaleEffectLengths([fx('bevel', { size: 10, depth: 100, angle: 135, altitude: 45 })], 2)!;
    expect(effectNumber(out!, 'size')).toBe(20);
    // `depth` is a PERCENTAGE of the bevel, not a length — it must not scale.
    expect(effectNumber(out!, 'depth')).toBe(100);
    expect(effectNumber(out!, 'altitude')).toBe(45);
  });
});
