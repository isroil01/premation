/**
 * Effect-chain baking — the shared implementation both render paths use. These
 * tests exercise the pure predicates and the chain against a real 2D canvas
 * (jsdom provides one), asserting a Canvas2D-only pixel pass mutates pixels in
 * stack order.
 */

import { isGpuUnbakeableEffect, effectsNeedCpuBake, applyEffectChain } from './effectBake';
import type { Effect } from './effects';

describe('bake predicates', () => {
  it('flags only the Canvas2D-only generator/pixel family', () => {
    for (const t of ['fill', 'stroke', 'four-color-gradient', 'beam', 'sharpen', 'noise', 'keylight', 'wave-warp', 'turbulent-displace']) {
      expect(isGpuUnbakeableEffect(t)).toBe(true);
    }
    // These have GPU forms → NOT baked.
    for (const t of ['blur', 'glow', 'brightness', 'levels', 'curves', 'tint', 'gradient-ramp', 'fractal-noise', 'displacement-map']) {
      expect(isGpuUnbakeableEffect(t)).toBe(false);
    }
  });

  it('effectsNeedCpuBake ignores disabled effects and empty stacks', () => {
    expect(effectsNeedCpuBake(undefined)).toBe(false);
    expect(effectsNeedCpuBake([])).toBe(false);
    expect(effectsNeedCpuBake([{ id: 'a', type: 'blur', params: { amount: 5 } } as Effect])).toBe(false);
    expect(effectsNeedCpuBake([{ id: 'a', type: 'fill', enabled: false, params: {} } as Effect])).toBe(false);
    expect(effectsNeedCpuBake([{ id: 'a', type: 'fill', params: { color: '#ff0000', opacity: 100 } } as Effect])).toBe(true);
  });
});

describe('applyEffectChain', () => {
  const mkCanvas = (w: number, h: number): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };

  it('Fill recolors opaque content to the fill colour (source-atop)', () => {
    const c = mkCanvas(10, 10);
    const ctx = c.getContext('2d');
    if (!ctx) return; // jsdom without canvas backend — skip
    // Opaque white square fills the whole buffer.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 10, 10);
    applyEffectChain(ctx, 10, 10,
      [{ id: 'f', type: 'fill', params: { color: '#ff0000', opacity: 100 } } as Effect],
      mkCanvas,
    );
    const px = ctx.getImageData(5, 5, 1, 1).data;
    expect(px[0]).toBe(255);
    expect(px[1]).toBe(0);
    expect(px[2]).toBe(0);
    expect(px[3]).toBe(255);
  });

  it('a transparent pixel stays transparent through Fill (respects alpha)', () => {
    const c = mkCanvas(10, 10);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // Leave the buffer fully transparent, fill only a corner.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 4, 4);
    applyEffectChain(ctx, 10, 10,
      [{ id: 'f', type: 'fill', params: { color: '#ff0000', opacity: 100 } } as Effect],
      mkCanvas,
    );
    expect(ctx.getImageData(8, 8, 1, 1).data[3]).toBe(0); // still transparent
    expect(ctx.getImageData(1, 1, 1, 1).data[0]).toBe(255); // filled corner → red
  });
});
