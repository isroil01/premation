import {
  remapTime,
  isIdentityTime,
  readNodeLayerTime,
  DEFAULT_LAYER_TIME,
  type LayerTime,
} from './layerTime';
import type { SceneNode } from '@core/types';

const cfg = (over: Partial<LayerTime> = {}): LayerTime => ({ ...DEFAULT_LAYER_TIME, ...over });
const span = { start: 0, end: 10 };

describe('remapTime', () => {
  test('identity config leaves comp time unchanged', () => {
    expect(remapTime(3, cfg(), span)).toBe(3);
  });

  test('200% stretch plays at half speed (source advances half as fast)', () => {
    expect(remapTime(2, cfg({ stretch: 200 }), span)).toBeCloseTo(1);
    expect(remapTime(10, cfg({ stretch: 200 }), span)).toBeCloseTo(5);
  });

  test('50% stretch plays at double speed', () => {
    expect(remapTime(1, cfg({ stretch: 50 }), span)).toBeCloseTo(2);
  });

  test('stretch is anchored at the span start', () => {
    const s = { start: 4, end: 8 };
    // At comp t=4 (=start) the source stays at start regardless of stretch.
    expect(remapTime(4, cfg({ stretch: 200 }), s)).toBeCloseTo(4);
    expect(remapTime(8, cfg({ stretch: 200 }), s)).toBeCloseTo(6); // 4 + (8-4)/2
  });

  test('reverse mirrors the source time within the span', () => {
    expect(remapTime(2, cfg({ reverse: true }), span)).toBeCloseTo(8); // 0+10-2
    expect(remapTime(8, cfg({ reverse: true }), span)).toBeCloseTo(2);
  });

  test('freeze holds the freeze time regardless of comp time', () => {
    const c = cfg({ freeze: true, freezeTime: 1.5 });
    expect(remapTime(0, c, span)).toBe(1.5);
    expect(remapTime(9, c, span)).toBe(1.5);
  });

  // ── Composition probes (the brief: "remap composes with stretch/reverse/freeze") ──
  test('reverse composes with stretch — starts at the end, advances at the stretched rate', () => {
    const c = cfg({ reverse: true, stretch: 200 }); // half speed, backwards
    // At comp start the reversed source sits on span.end.
    expect(remapTime(0, c, span)).toBeCloseTo(10);
    // Half speed: it takes 2× the span duration (20s comp) to reach span.start.
    expect(remapTime(20, c, span)).toBeCloseTo(0);
    // Midway through that traversal it is at the span midpoint.
    expect(remapTime(10, c, span)).toBeCloseTo(5);
  });

  test('reverse+stretch stays anchored on a non-zero span start', () => {
    const s = { start: 4, end: 8 };
    const c = cfg({ reverse: true, stretch: 50 }); // double speed, backwards
    expect(remapTime(4, c, s)).toBeCloseTo(8); // begins at the end
    expect(remapTime(6, c, s)).toBeCloseTo(4); // reaches the start in half the span
  });

  test('freeze dominates reverse and stretch (holds regardless)', () => {
    const c = cfg({ freeze: true, freezeTime: 3, reverse: true, stretch: 250 });
    expect(remapTime(0, c, span)).toBe(3);
    expect(remapTime(7, c, span)).toBe(3);
  });

  test('a degenerate zero-length span stays finite under reverse and stretch', () => {
    // No traversal to reverse; the map linearly extrapolates comp time (as it
    // does for any out-of-span time) and stays finite — sampleTrack clamps the
    // out-of-range result to the lone keyframe downstream, so the value is moot;
    // what matters is that nothing divides by zero or returns NaN.
    const s = { start: 5, end: 5 };
    for (const c of [cfg({ reverse: true }), cfg({ reverse: true, stretch: 200 }), cfg({ stretch: 50 })]) {
      expect(Number.isFinite(remapTime(2, c, s))).toBe(true);
    }
    // At the span point itself the source is exactly that point.
    expect(remapTime(5, cfg({ reverse: true }), s)).toBeCloseTo(5);
  });
});

describe('isIdentityTime', () => {
  test('true only for 100% / no reverse / no freeze', () => {
    expect(isIdentityTime(cfg())).toBe(true);
    expect(isIdentityTime(cfg({ stretch: 101 }))).toBe(false);
    expect(isIdentityTime(cfg({ reverse: true }))).toBe(false);
    expect(isIdentityTime(cfg({ freeze: true }))).toBe(false);
  });
});

describe('readNodeLayerTime', () => {
  const node = (fxProps: Record<string, unknown> | null): SceneNode =>
    ({ id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
       transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
       components: fxProps ? [{ id: 'fx', type: 'fx', props: fxProps }] : [] } as unknown as SceneNode);

  test('undefined when no fx.time or when config is the identity', () => {
    expect(readNodeLayerTime(node(null))).toBeUndefined();
    expect(readNodeLayerTime(node({ time: { stretch: 100, reverse: false, freeze: false } }))).toBeUndefined();
  });

  test('returns a normalized config when non-default', () => {
    const t = readNodeLayerTime(node({ time: { stretch: 200 } }));
    expect(t?.stretch).toBe(200);
    expect(t?.reverse).toBe(false);
  });

  test('clamps an out-of-range stretch', () => {
    expect(readNodeLayerTime(node({ time: { stretch: 0 } }))?.stretch).toBe(1); // clamped to 1% (min)
    expect(readNodeLayerTime(node({ time: { stretch: 5000 } }))?.stretch).toBe(1000);
  });
});
