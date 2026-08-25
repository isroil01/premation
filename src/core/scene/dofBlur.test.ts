import { dofBlurPx, dofIrisParams, type DofConfig } from './camera3d';

const cfg = (over: Partial<DofConfig> = {}): DofConfig => ({
  strength: 20, focus: 500, aperture: 20, ...over,
});

describe('dofBlurPx (aperture-driven circle of confusion)', () => {
  test('a layer at the focus distance is sharp (0 blur)', () => {
    expect(dofBlurPx(500, cfg())).toBe(0);
  });

  test('blur grows with defocus distance', () => {
    const near = dofBlurPx(600, cfg({ strength: 100 }));
    const far = dofBlurPx(900, cfg({ strength: 100 }));
    expect(far).toBeGreaterThan(near);
  });

  test('a wider aperture blurs more at the same defocus', () => {
    const narrow = dofBlurPx(700, cfg({ aperture: 10, strength: 100 }));
    const wide = dofBlurPx(700, cfg({ aperture: 40, strength: 100 }));
    expect(wide).toBeGreaterThan(narrow);
    // defocus = |700-500|/500 = 0.4 → narrow 0.4·10=4, wide 0.4·40=16
    expect(narrow).toBeCloseTo(4, 5);
    expect(wide).toBeCloseTo(16, 5);
  });

  test('blur is capped at strength (Blur Level)', () => {
    expect(dofBlurPx(5000, cfg({ aperture: 1000, strength: 20 }))).toBe(20);
  });

  test('aperture === strength reproduces the old single-scalar ramp', () => {
    const depth = 800;
    const s = 30;
    const old = Math.min(s, (Math.abs(depth - 500) / 500) * s);
    expect(dofBlurPx(depth, cfg({ aperture: s, strength: s }))).toBeCloseTo(old, 6);
  });
});

describe('dofIrisParams', () => {
  test('absent or low blade count keeps Gaussian (empty extras)', () => {
    expect(dofIrisParams(cfg())).toEqual({});
    expect(dofIrisParams(cfg({ irisBlades: 2 }))).toEqual({});
  });

  test('6 blades expose roundness default and optional highlight gain', () => {
    expect(dofIrisParams(cfg({ irisBlades: 6 }))).toEqual({
      blades: 6, roundness: 0.65, highlightGain: 0,
    });
    expect(dofIrisParams(cfg({ irisBlades: 8, irisRoundness: 0.2, highlightGain: 2 }))).toEqual({
      blades: 8, roundness: 0.2, highlightGain: 2,
    });
  });
});
