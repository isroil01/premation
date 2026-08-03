/**
 * The keying kernels, asserted numerically.
 *
 * Set Matte is not here: it is a GPU shader pass, because it reads another
 * layer's pixels and the bake chain is handed only its own. Its registration and
 * classification are covered by `effects.test.ts` and `newEffects.test.ts`.
 */

import {
  simpleChokerData,
  linearColorKeyData,
  shiftChannelsData,
  colorMatchMode,
  channelSource,
} from './keyingEffects';

function make(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const o = (y * w + x) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
    }
  }
  return d;
}

const alphaAt = (d: Uint8ClampedArray, w: number, x: number, y: number) => d[(y * w + x) * 4 + 3]!;
const countOpaque = (d: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]! > 127) n++;
  return n;
};

describe('simpleChokerData', () => {
  /** A 6×6 opaque square centred in a 12×12 transparent field. */
  const square = () => make(12, 12, (x, y) =>
    x >= 3 && x < 9 && y >= 3 && y < 9 ? [255, 0, 0, 255] : [0, 0, 0, 0],
  );

  it('is a no-op at zero', () => {
    const src = square();
    expect(Array.from(simpleChokerData(square(), 12, 12, 0))).toEqual(Array.from(src));
  });

  it('shrinks the matte on a positive choke', () => {
    const before = countOpaque(square());
    const after = countOpaque(simpleChokerData(square(), 12, 12, 1));
    expect(after).toBeLessThan(before);
  });

  it('grows the matte on a negative choke', () => {
    const before = countOpaque(square());
    const after = countOpaque(simpleChokerData(square(), 12, 12, -1));
    expect(after).toBeGreaterThan(before);
  });

  it('moves the EDGE and leaves colour alone', () => {
    // The definition of a choke, and what separates it from a blur: the
    // coverage boundary moves, the colour does not.
    const out = simpleChokerData(square(), 12, 12, 1);
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3]! > 0) expect(out[i]).toBe(255);
    }
  });

  it('chokes a FULL-FRAME matte at its border', () => {
    // Outside the layer must read as transparent when eroding, or a full-frame
    // matte is untouched at its edge — the same divisor mistake as blur's
    // repeat-edge. A choke that cannot bite the frame edge is half broken.
    const full = make(8, 8, () => [255, 255, 255, 255]);
    const out = simpleChokerData(full, 8, 8, 1);
    expect(alphaAt(out, 8, 0, 0)).toBe(0);
    expect(alphaAt(out, 8, 4, 4)).toBe(255);
  });
});

describe('colorMatchMode', () => {
  it('maps the stored number onto the menu, defaulting to rgb', () => {
    expect(colorMatchMode(0)).toBe('rgb');
    expect(colorMatchMode(1)).toBe('hue');
    expect(colorMatchMode(2)).toBe('chroma');
    expect(colorMatchMode(99)).toBe('rgb');
  });
});

describe('linearColorKeyData', () => {
  const green = [0, 255, 0] as const;
  const px = (rgb: [number, number, number]) => new Uint8ClampedArray([...rgb, 255]);

  it('keys out an exact match', () => {
    const d = linearColorKeyData(px([0, 255, 0]), green, 'rgb', 20, 10, false);
    expect(d[3]).toBe(0);
  });

  it('leaves a distant colour fully opaque', () => {
    const d = linearColorKeyData(px([255, 0, 0]), green, 'rgb', 20, 10, false);
    expect(d[3]).toBe(255);
  });

  it('ramps LINEARLY through the softness band rather than cutting', () => {
    // The entire point of "Linear". A hard threshold gives the jagged aliased
    // matte that makes people abandon keying; the ramp is the difference.
    const near = linearColorKeyData(px([60, 235, 60]), green, 'rgb', 5, 40, false)[3]!;
    const mid = linearColorKeyData(px([110, 215, 110]), green, 'rgb', 5, 40, false)[3]!;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(255);
    expect(mid).toBeGreaterThan(near);
  });

  it('cuts hard when softness is zero', () => {
    const inside = linearColorKeyData(px([20, 245, 20]), green, 'rgb', 20, 0, false)[3]!;
    const outside = linearColorKeyData(px([160, 200, 160]), green, 'rgb', 20, 0, false)[3]!;
    expect(inside).toBe(0);
    expect(outside).toBe(255);
  });

  it('keepMatched inverts the sense, making it a colour isolator', () => {
    const keyed = linearColorKeyData(px([0, 255, 0]), green, 'rgb', 20, 10, false)[3]!;
    const kept = linearColorKeyData(px([0, 255, 0]), green, 'rgb', 20, 10, true)[3]!;
    expect(keyed).toBe(0);
    expect(kept).toBe(255);
  });

  it('treats hue as circular', () => {
    // Red sits at hue 0. A pixel just below 1.0 is adjacent to it, not maximally
    // far — getting this wrong keys the wrong half of the wheel.
    const red = [255, 0, 0] as const;
    const magentaish = px([255, 0, 40]);
    const d = linearColorKeyData(magentaish, red, 'hue', 10, 10, false);
    expect(d[3]).toBeLessThan(255);
  });

  it('chroma matching ignores a luminance shift', () => {
    // Why the mode exists: a shadow falling across the key colour must still
    // key. The darker green keys under chroma but survives a plain RGB match.
    const darkGreen = px([0, 120, 0]);
    const byChroma = linearColorKeyData(px([0, 120, 0]), green, 'chroma', 15, 10, false)[3]!;
    const byRgb = linearColorKeyData(darkGreen, green, 'rgb', 15, 10, false)[3]!;
    expect(byChroma).toBeLessThan(byRgb);
  });

  it('leaves already-transparent pixels alone', () => {
    const d = new Uint8ClampedArray([0, 255, 0, 0]);
    expect(Array.from(linearColorKeyData(d, green, 'rgb', 50, 10, false))).toEqual([0, 255, 0, 0]);
  });
});

describe('channelSource', () => {
  it('maps stored indices to sources', () => {
    expect(channelSource(0)).toBe('alpha');
    expect(channelSource(1)).toBe('red');
    expect(channelSource(4)).toBe('luminance');
    expect(channelSource(6)).toBe('full-off');
  });

  it('falls back to alpha for an out-of-range index', () => {
    expect(channelSource(99)).toBe('alpha');
    expect(channelSource(-1)).toBe('alpha');
  });
});

describe('shiftChannelsData', () => {
  it('is the identity at its defaults', () => {
    const d = new Uint8ClampedArray([10, 20, 30, 40]);
    expect(Array.from(shiftChannelsData(d, 'alpha', 'red', 'green', 'blue')))
      .toEqual([10, 20, 30, 40]);
  });

  it('SWAPS two channels without collapsing them', () => {
    // The in-place-permutation bug: without snapshotting the source pixel first,
    // red←green then green←red leaves BOTH holding green. This is the assertion
    // that catches it.
    const d = new Uint8ClampedArray([10, 200, 30, 255]);
    const out = shiftChannelsData(d, 'alpha', 'green', 'red', 'blue');
    expect(out[0]).toBe(200);
    expect(out[1]).toBe(10);
  });

  it('takes alpha from luminance — the reason this effect exists', () => {
    // Turns a greyscale render into a matte in one step.
    const d = new Uint8ClampedArray([255, 255, 255, 255]);
    expect(shiftChannelsData(d, 'luminance', 'red', 'green', 'blue')[3]).toBe(255);
    const black = new Uint8ClampedArray([0, 0, 0, 255]);
    expect(shiftChannelsData(black, 'luminance', 'red', 'green', 'blue')[3]).toBe(0);
  });

  it('honours full-on and full-off', () => {
    const d = new Uint8ClampedArray([10, 20, 30, 40]);
    const out = shiftChannelsData(d, 'full-on', 'full-off', 'full-on', 'full-off');
    expect(Array.from(out)).toEqual([0, 255, 0, 255]);
  });
});
