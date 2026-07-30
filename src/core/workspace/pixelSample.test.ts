import { cssToDevicePixel, samplePixelRgba } from './pixelSample';
import { markGpuOwned } from '../rendering/canvasOwnership';

/**
 * The packaged-build "GPU unavailable" regression: `samplePixelRgba` runs from
 * the viewport's mousemove handler, and `getContext('2d')` on a canvas a GPU
 * backend has claimed but NOT yet initialized would bind the element to 2d —
 * after which every WebGPU/WebGL2 getContext returns null forever. The sampler
 * must therefore never call getContext at all on a GPU-owned canvas.
 */
describe('samplePixelRgba vs GPU-owned canvases', () => {
  function makeCanvas(w = 100, h = 100): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      value: () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 }),
    });
    return canvas;
  }

  test('never calls getContext on a canvas a GPU backend has claimed', () => {
    const canvas = makeCanvas();
    const spy = jest.fn();
    canvas.getContext = spy as unknown as typeof canvas.getContext;
    markGpuOwned(canvas);

    expect(samplePixelRgba(canvas, { x: 10, y: 10 })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('still reads pixels from an unowned 2d canvas', () => {
    const canvas = makeCanvas();
    const fakeCtx = {
      getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 4]) }),
    };
    canvas.getContext = jest.fn(() => fakeCtx) as unknown as typeof canvas.getContext;

    expect(samplePixelRgba(canvas, { x: 10, y: 10 })).toEqual({ r: 1, g: 2, b: 3, a: 4 });
  });
});

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
