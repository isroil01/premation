import { cssToDevicePixel } from './pixelSample';

describe('cssToDevicePixel', () => {
  test('1:1 canvas maps CSS point straight through', () => {
    expect(cssToDevicePixel({ x: 10, y: 20 }, { width: 100, height: 100 }, 100, 100)).toEqual({ px: 10, py: 20 });
  });

  test('scales CSS point up to the device backing store (HiDPI)', () => {
    // A 100×100 CSS box backed by 200×200 device px → 2× scale.
    expect(cssToDevicePixel({ x: 25, y: 10 }, { width: 100, height: 100 }, 200, 200)).toEqual({ px: 50, py: 20 });
  });

  test('non-integer scale floors to a whole pixel', () => {
    // 1063 CSS → 1159 device (≈1.09×): x=100 → floor(109.03)=109.
    const r = cssToDevicePixel({ x: 100, y: 0 }, { width: 1063, height: 809 }, 1159, 882)!;
    expect(r.px).toBe(Math.floor(100 * (1159 / 1063)));
    expect(r.py).toBe(0);
  });

  test('off-canvas points return null', () => {
    expect(cssToDevicePixel({ x: -1, y: 5 }, { width: 100, height: 100 }, 100, 100)).toBeNull();
    expect(cssToDevicePixel({ x: 100, y: 5 }, { width: 100, height: 100 }, 100, 100)).toBeNull(); // px===w is out
    expect(cssToDevicePixel({ x: 5, y: 200 }, { width: 100, height: 100 }, 100, 100)).toBeNull();
  });

  test('zero-size rect returns null (not a divide-by-zero)', () => {
    expect(cssToDevicePixel({ x: 5, y: 5 }, { width: 0, height: 100 }, 100, 100)).toBeNull();
  });
});
