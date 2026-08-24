/**
 * Export-preview measurement tests.
 *
 * The "this export would be blank" warning is only useful if it is right in both
 * directions: a false positive trains users to ignore it, and a false negative is
 * the original bug (a black file that nothing warned about). The rule is pure, so
 * it is pinned here without a GPU.
 */

import { frameCoverage, parseCssColor } from './exportPreview';

/** A `width × height` RGBA buffer filled with one colour. */
function solid(width: number, height: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = rgba[0];
    out[i + 1] = rgba[1];
    out[i + 2] = rgba[2];
    out[i + 3] = rgba[3];
  }
  return out;
}

describe('parseCssColor', () => {
  it('reads the hex and rgb forms the comp background uses', () => {
    expect(parseCssColor('#101014')).toEqual({ r: 16, g: 16, b: 20 });
    expect(parseCssColor('101014')).toEqual({ r: 16, g: 16, b: 20 });
    expect(parseCssColor('#101014ff')).toEqual({ r: 16, g: 16, b: 20 });
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseCssColor('#ffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('returns null for anything it cannot read, rather than guessing', () => {
    // A wrong guess here would misjudge every frame against the wrong colour.
    expect(parseCssColor(undefined)).toBeNull();
    expect(parseCssColor('rebeccapurple')).toBeNull();
    expect(parseCssColor('')).toBeNull();
  });
});

describe('frameCoverage', () => {
  const bg = { r: 16, g: 16, b: 20 };

  it('reports zero for a frame that is nothing but the background', () => {
    expect(frameCoverage(solid(8, 8, [16, 16, 20, 255]), bg)).toBe(0);
  });

  it('ignores compositor rounding around the background colour', () => {
    // A pixel one or two levels off the background is the same flat colour, not
    // content — flagging it would make the warning meaningless.
    expect(frameCoverage(solid(8, 8, [18, 15, 22, 255]), bg)).toBe(0);
  });

  it('reports one for a frame entirely covered by content', () => {
    expect(frameCoverage(solid(8, 8, [255, 255, 255, 255]), bg)).toBe(1);
  });

  it('measures the fraction of the frame that is content', () => {
    const px = solid(10, 10, [16, 16, 20, 255]);
    // Paint 25 of the 100 pixels white.
    for (let i = 0; i < 25; i++) {
      px[i * 4] = 255;
      px[i * 4 + 1] = 255;
      px[i * 4 + 2] = 255;
    }
    expect(frameCoverage(px, bg)).toBeCloseTo(0.25, 5);
  });

  it('catches dark content on a dark background', () => {
    // The case a naive "is it black?" check misses entirely: a #303038 shape on a
    // #101014 comp is visible, and an export of it is not blank.
    expect(frameCoverage(solid(4, 4, [48, 48, 56, 255]), bg)).toBe(1);
  });

  it('treats fully transparent pixels over an opaque comp as background', () => {
    expect(frameCoverage(solid(8, 8, [255, 255, 255, 0]), bg)).toBe(0);
  });

  it('judges a transparent export on alpha alone', () => {
    // With no background being drawn, colour says nothing: an opaque black shape
    // on a transparent comp is content, and a transparent frame is empty.
    expect(frameCoverage(solid(8, 8, [0, 0, 0, 255]), null)).toBe(1);
    expect(frameCoverage(solid(8, 8, [255, 255, 255, 0]), null)).toBe(0);
  });

  it('handles an empty buffer without dividing by zero', () => {
    expect(frameCoverage(new Uint8ClampedArray(0), bg)).toBe(0);
  });
});
