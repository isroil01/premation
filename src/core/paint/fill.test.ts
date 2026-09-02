import {
  sampleGradientColor,
  sampleGradientHex,
  sortedStops,
  parseHex,
  convertFill,
  readNodeFill,
  makeStop,
  solidFill,
  linearFill,
  radialFill,
  type ColorStop,
} from './fill';
import type { SceneNode } from '@core/types';

const stops = (pairs: Array<[number, string]>): ColorStop[] =>
  pairs.map(([offset, color], i) => ({ id: `s${i}`, offset, color }));

describe('parseHex', () => {
  test('parses #rgb, #rrggbb, #rrggbbaa', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(parseHex('#ff8800')).toEqual({ r: 255, g: 136, b: 0, a: 255 });
    expect(parseHex('#00000080')).toEqual({ r: 0, g: 0, b: 0, a: 128 });
  });
  test('invalid → opaque black', () => {
    expect(parseHex('nope')).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });
});

describe('sampleGradientColor', () => {
  test('midpoint interpolates rgb linearly', () => {
    expect(sampleGradientColor(stops([[0, '#000000'], [1, '#ffffff']]), 0.5)).toBe('rgba(128, 128, 128, 1.000)');
  });

  test('quarter point', () => {
    // 0 → 200 across; at t=0.25 → 50
    expect(sampleGradientColor(stops([[0, '#000000'], [1, '#c80000']]), 0.25)).toBe('rgba(50, 0, 0, 1.000)');
  });

  test('interpolates alpha', () => {
    expect(sampleGradientColor(stops([[0, '#ffffff00'], [1, '#ffffffff']]), 0.5)).toBe('rgba(255, 255, 255, 0.500)');
  });

  test('clamps below the first and above the last stop', () => {
    const g = stops([[0.25, '#111111'], [0.75, '#eeeeee']]);
    expect(sampleGradientColor(g, 0)).toBe('rgba(17, 17, 17, 1.000)');
    expect(sampleGradientColor(g, 1)).toBe('rgba(238, 238, 238, 1.000)');
  });

  test('respects unsorted stops via sortedStops', () => {
    const g = stops([[1, '#ffffff'], [0, '#000000']]);
    expect(sampleGradientColor(g, 0.5)).toBe('rgba(128, 128, 128, 1.000)');
  });

  test('single stop → that colour everywhere', () => {
    expect(sampleGradientColor(stops([[0.3, '#abcdef']]), 0.9)).toBe(sampleGradientColor(stops([[0.3, '#abcdef']]), 0.1));
  });

  test('three stops pick the right segment', () => {
    const g = stops([[0, '#000000'], [0.5, '#ff0000'], [1, '#000000']]);
    expect(sampleGradientColor(g, 0.25)).toBe('rgba(128, 0, 0, 1.000)');
    expect(sampleGradientColor(g, 0.75)).toBe('rgba(128, 0, 0, 1.000)');
  });
});

describe('sortedStops', () => {
  test('orders by offset without mutating input', () => {
    const input = stops([[0.9, '#fff'], [0.1, '#000']]);
    const out = sortedStops(input);
    expect(out.map((s) => s.offset)).toEqual([0.1, 0.9]);
    expect(input[0]!.offset).toBe(0.9); // original untouched
  });
});

describe('convertFill', () => {
  test('solid → linear keeps first colour, adds a ramp', () => {
    const lin = convertFill(solidFill('#123456'), 'linear');
    expect(lin.type).toBe('linear');
    if (lin.type === 'linear') {
      expect(lin.stops[0]!.color).toBe('#123456');
      expect(lin.stops.length).toBe(2);
    }
  });

  test('linear → radial preserves stops', () => {
    const lin = linearFill('#abcdef');
    const rad = convertFill(lin, 'radial');
    expect(rad.type).toBe('radial');
    if (rad.type === 'radial') expect(rad.stops).toEqual(lin.stops);
  });

  test('gradient → solid collapses to the first stop colour', () => {
    const solid = convertFill(radialFill('#ff0000'), 'solid');
    expect(solid).toEqual({ type: 'solid', color: '#ff0000' });
  });

  test('makeStop clamps offset', () => {
    expect(makeStop(1.5, '#fff').offset).toBe(1);
    expect(makeStop(-1, '#fff').offset).toBe(0);
  });
});

describe('readNodeFill', () => {
  const node = (components: Array<{ type: string; props: Record<string, unknown> }>): SceneNode =>
    ({ id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
       transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
       components: components.map((c, i) => ({ id: `c${i}`, ...c })) } as unknown as SceneNode);

  test('reads a fill paint off the fx component', () => {
    const paint = linearFill('#ff0000');
    const f = readNodeFill(node([{ type: 'fx', props: { fill: paint } }]));
    expect(f).toEqual(paint);
  });

  test('falls back to a legacy solid fill string on a style component', () => {
    const f = readNodeFill(node([{ type: 'Style', props: { fill: '#00ff00' } }]));
    expect(f).toEqual({ type: 'solid', color: '#00ff00' });
  });

  test('undefined when no fill anywhere', () => {
    expect(readNodeFill(node([{ type: 'Transform', props: { x: 1 } }]))).toBeUndefined();
  });
});

describe('sampleGradientHex', () => {
  const ramp: ColorStop[] = [
    { id: 'a', offset: 0, color: '#000000' },
    { id: 'b', offset: 1, color: '#ffffff' },
  ];

  test('answers in hex, not the sampler`s rgba(...)', () => {
    // The distinction that matters: a ColorStop stores hex, and a stop created
    // from an `rgba(...)` string comes back out of the ColorPicker as its
    // fallback blue. This is the form the on-canvas gradient editor writes when
    // clicking the axis adds a stop at the colour already there.
    expect(sampleGradientColor(ramp, 0.5)).toMatch(/^rgba\(/);
    expect(sampleGradientHex(ramp, 0.5)).toBe('#808080ff');
  });

  test('preserves a stop`s own alpha', () => {
    expect(sampleGradientHex([{ id: 'a', offset: 0, color: '#11223380' }], 0.5)).toBe('#11223380');
  });

  test('clamps outside the stop range', () => {
    expect(sampleGradientHex(ramp, -1)).toBe('#000000ff');
    expect(sampleGradientHex(ramp, 2)).toBe('#ffffffff');
  });
});
