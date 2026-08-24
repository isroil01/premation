import {
  unmultData,
  ccCompositeData,
  ccRepeTileData,
  ccScatterizeData,
  radialFastBlurData,
  crossBlurData,
  scaleWipeData,
  plasticData,
} from './aeRoundSix';
import { applyCanvas2dEffect, isCanvas2dOnlyEffect } from './canvas2dEffects';
import type { Effect } from './effects';

function makeGradBuffer(w = 16, h = 16): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      data[idx] = Math.round((x / (w - 1)) * 255);
      data[idx + 1] = Math.round((y / (h - 1)) * 255);
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }
  return data;
}

describe('Visual effects, round six', () => {
  describe('unmult', () => {
    it('knocks out black pixels to transparent alpha', () => {
      const buf = new Uint8ClampedArray(4 * 4);
      // Pure black pixel
      buf[0] = 0; buf[1] = 0; buf[2] = 0; buf[3] = 255;
      // White pixel
      buf[4] = 255; buf[5] = 255; buf[6] = 255; buf[7] = 255;
      // Red pixel
      buf[8] = 200; buf[9] = 0; buf[10] = 0; buf[11] = 255;

      const out = unmultData(buf, 2, 2, 0, 100);
      expect(out[3]).toBe(0); // black pixel becomes transparent
      expect(out[7]).toBe(255); // white pixel stays fully opaque
      expect(out[11]).toBeGreaterThan(0); // red pixel keeps alpha
      expect(out[8]).toBe(255); // unmultiplied red scales to full intensity
    });
  });

  describe('cc-composite', () => {
    it('blends original source over current buffer with add blend mode', () => {
      const current = new Uint8ClampedArray([50, 50, 50, 255]);
      const original = new Uint8ClampedArray([100, 100, 100, 255]);
      const out = ccCompositeData(current, original, 1, 1, 100, 'add');
      expect(out[0]).toBe(150);
      expect(out[1]).toBe(150);
      expect(out[2]).toBe(150);
    });

    it('honors opacity slider', () => {
      const current = new Uint8ClampedArray([100, 100, 100, 255]);
      const original = new Uint8ClampedArray([200, 200, 200, 255]);
      const out = ccCompositeData(current, original, 1, 1, 50, 'in-front');
      expect(out[0]).toBeCloseTo(150, -1);
    });
  });

  describe('cc-repetile', () => {
    it('unfolds and expands borders', () => {
      const src = new Uint8ClampedArray([
        10, 20, 30, 255,   40, 50, 60, 255,
        70, 80, 90, 255,   100, 110, 120, 255,
      ]);
      const res = ccRepeTileData(src, 2, 2, 1, 1, 1, 1, 'unfold');
      expect(res.width).toBe(4);
      expect(res.height).toBe(4);
      expect(res.data.length).toBe(4 * 4 * 4);
    });

    it('leaves buffer untouched if expand is 0', () => {
      const src = makeGradBuffer(4, 4);
      const res = ccRepeTileData(src, 4, 4, 0, 0, 0, 0, 'repeat');
      expect(res.width).toBe(4);
      expect(res.height).toBe(4);
      expect(Array.from(res.data)).toEqual(Array.from(src));
    });
  });

  describe('cc-scatterize', () => {
    it('does nothing at amount 0', () => {
      const src = makeGradBuffer(8, 8);
      const out = ccScatterizeData(src, 8, 8, 0);
      expect(Array.from(out)).toEqual(Array.from(src));
    });

    it('scatters non-transparent pixels when amount > 0', () => {
      const src = makeGradBuffer(16, 16);
      const out = ccScatterizeData(src, 16, 16, 50, 10, 0, 45, 42);
      expect(Array.from(out)).not.toEqual(Array.from(src));
    });
  });

  describe('radial-fast-blur', () => {
    it('blurs outward from center point', () => {
      const src = makeGradBuffer(16, 16);
      const out = radialFastBlurData(src, 16, 16, 40, 0, 0, 'standard');
      expect(out.length).toBe(src.length);
      expect(Array.from(out)).not.toEqual(Array.from(src));
    });
  });

  describe('cross-blur', () => {
    it('applies separable horizontal and vertical blur', () => {
      const src = makeGradBuffer(16, 16);
      const out = crossBlurData(src, 16, 16, 5, 10, true);
      expect(out.length).toBe(src.length);
      expect(Array.from(out)).not.toEqual(Array.from(src));
    });
  });

  describe('scale-wipe', () => {
    it('at completion 0 returns unchanged buffer', () => {
      const src = makeGradBuffer(8, 8);
      const out = scaleWipeData(src, 8, 8, 0, 10, 45);
      expect(Array.from(out)).toEqual(Array.from(src));
    });

    it('at completion > 0 stretches pixels', () => {
      const src = makeGradBuffer(16, 16);
      const out = scaleWipeData(src, 16, 16, 50, 10, 45);
      expect(Array.from(out)).not.toEqual(Array.from(src));
    });
  });

  describe('plastic', () => {
    it('applies 3D specular plastic relief', () => {
      const src = makeGradBuffer(16, 16);
      const out = plasticData(src, 16, 16, 30, 4, 45, 100, 50);
      expect(out.length).toBe(src.length);
      expect(Array.from(out)).not.toEqual(Array.from(src));
    });
  });

  describe('integration with canvas2dEffects', () => {
    const ALL_ROUND_SIX = [
      'unmult',
      'cc-composite',
      'cc-repetile',
      'cc-scatterize',
      'radial-fast-blur',
      'cross-blur',
      'scale-wipe',
      'plastic',
    ] as const;

    it.each(ALL_ROUND_SIX)('registers %s as Canvas2D only', (type) => {
      expect(isCanvas2dOnlyEffect(type)).toBe(true);
    });

    it.each(ALL_ROUND_SIX)('runs %s cleanly through applyCanvas2dEffect', (type) => {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(16, 16);
      img.data.set(makeGradBuffer(16, 16));
      ctx.putImageData(img, 0, 0);

      const effect: Effect = {
        id: 'fx_test',
        type,
        params: {
          amount: 25,
          threshold: 10,
          boost: 100,
          opacity: 100,
          expandLeft: 4,
          radiusX: 4,
          radiusY: 4,
          completion: 30,
          surfaceBump: 25,
        },
      };

      expect(() => applyCanvas2dEffect(ctx, 16, 16, effect)).not.toThrow();
    });
  });
});
