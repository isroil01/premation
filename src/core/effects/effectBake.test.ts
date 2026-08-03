/**
 * Effect-chain baking — the shared implementation both render paths use. The
 * pure predicates run everywhere; the chain needs a real 2D canvas, which jsdom
 * does NOT provide, so those are skipped here and carried by the golden-frame
 * suite in packages/render-tests.
 */

import { isGpuUnbakeableEffect, effectsNeedCpuBake, applyEffectChain, layerNeedsCpuBake } from './effectBake';
import { hasCanvas2dImplementation } from './canvas2dEffects';
import type { Effect } from './effects';

describe('bake predicates', () => {
  it('flags only the effects the GPU cannot draw at all', () => {
    for (const t of ['four-color-gradient', 'beam', 'keylight', 'wave-warp', 'turbulent-displace',
      'inner-shadow', 'inner-glow', 'satin', 'bevel', 'directional-blur', 'linear-wipe', 'transform']) {
      expect(isGpuUnbakeableEffect(t)).toBe(true);
    }
    // These have GPU forms → they never FORCE a bake.
    for (const t of ['blur', 'glow', 'brightness', 'levels', 'curves', 'tint', 'gradient-ramp',
      'fractal-noise', 'displacement-map', 'fill', 'stroke', 'sharpen', 'noise']) {
      expect(isGpuUnbakeableEffect(t)).toBe(false);
    }
  });

  /**
   * "Forces a bake" and "can be drawn by the bake" are different questions.
   *
   * Fill / Stroke / Sharpen / Noise answer NO to the first (they have GPU
   * materials) and YES to the second. Collapsing the two made them fall through
   * BOTH routes on any layer baked for another reason — the layer's GPU effect
   * list is dropped wholesale when baked, so the bake was their last chance and
   * it skipped them. Symptom: a Color Overlay or Stroke layer style vanished the
   * moment an Inner Shadow was enabled on the same layer.
   */
  it('separates "forces a bake" from "the bake can draw it"', () => {
    for (const t of ['fill', 'stroke', 'sharpen', 'noise']) {
      expect(isGpuUnbakeableEffect(t)).toBe(false);
      expect(hasCanvas2dImplementation(t)).toBe(true);
    }
    // Anything that forces a bake must also be drawable by it.
    for (const t of ['inner-shadow', 'inner-glow', 'satin', 'bevel', 'beam', 'keylight',
      'wave-warp', 'turbulent-displace', 'four-color-gradient', 'directional-blur',
      'linear-wipe', 'transform']) {
      expect(hasCanvas2dImplementation(t)).toBe(true);
    }
    // GPU-only and CSS/LUT effects are drawn by other branches of the chain.
    for (const t of ['displacement-map', 'motion-tile', 'blur', 'levels']) {
      expect(hasCanvas2dImplementation(t)).toBe(false);
    }
  });

  // Regression: layerNeedsCpuBake sends a layer down the bake path for fill
  // opacity alone, and such a layer has no effect stack. Both rasterizer call
  // sites asserted `effects!` non-null, so the chain hit
  // `for (const e of undefined)`; the texture feed caught the TypeError and the
  // layer silently rendered UNFADED. Caught by the golden-frame scenes
  // (fill-opacity-half / -zero), which rendered the subject at full strength.
  it('applyEffectChain tolerates an absent effect stack — the fill-opacity-only layer', () => {
    const mk = (w: number, h: number): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    };
    const ctx = mk(8, 8).getContext('2d');
    if (!ctx) return; // no rasterizer at all — nothing to assert against
    expect(() => applyEffectChain(ctx, 8, 8, undefined, mk, 0.5)).not.toThrow();
    expect(layerNeedsCpuBake(undefined, 0.5)).toBe(true);
  });

  it('effectsNeedCpuBake ignores disabled effects and empty stacks', () => {
    expect(effectsNeedCpuBake(undefined)).toBe(false);
    expect(effectsNeedCpuBake([])).toBe(false);
    expect(effectsNeedCpuBake([{ id: 'a', type: 'blur', params: { amount: 5 } } as Effect])).toBe(false);
    expect(effectsNeedCpuBake([{ id: 'a', type: 'satin', enabled: false, params: {} } as Effect])).toBe(false);
    expect(effectsNeedCpuBake([{ id: 'a', type: 'satin', params: { size: 8 } } as Effect])).toBe(true);
    // Fill has a GPU material, so on its own it must NOT drag the layer onto
    // the CPU — that was the whole point of giving it one.
    expect(effectsNeedCpuBake([{ id: 'a', type: 'fill', params: { color: '#ff0000', opacity: 100 } } as Effect])).toBe(false);
  });

  /**
   * The combined stack: an interior style forces the bake, and Fill must still
   * land. Verified on pixels because the predicates alone cannot show that the
   * chain actually dispatched to the Fill case.
   */
  it('applies Fill inside a bake forced by an interior style', () => {
    const mk = (w: number, h: number): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    };
    const ctx = mk(16, 16).getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 16, 16);
    const stack = [
      { id: 'f', type: 'fill', params: { color: '#ff0000', opacity: 100 } },
      { id: 's', type: 'inner-shadow', params: { distance: 6, angle: 135, softness: 8, color: '#000000', opacity: 55 } },
    ] as Effect[];
    expect(effectsNeedCpuBake(stack)).toBe(true);
    applyEffectChain(ctx, 16, 16, stack, mk);
    const px = ctx.getImageData(8, 8, 1, 1).data;
    expect(px[0]).toBeGreaterThan(128); // recoloured red…
    expect(px[1]).toBeLessThan(128);    // …and the original green is gone
  });
});

// Guarded as a SKIP, not an early return — an early return reports a green test
// that asserted nothing, which is indistinguishable from coverage in the run
// summary. The chain composites through source-atop over a blurred silhouette,
// so it needs a backend faithful on both; see canvasFidelity for the
// measurements. Real-Chromium coverage: packages/render-tests.
import { canAssertLayerStylePixels } from './__testHelpers__/canvasFidelity';

(canAssertLayerStylePixels ? describe : describe.skip)('applyEffectChain', () => {
  const mkCanvas = (w: number, h: number): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };
  const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D => {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('expected a 2d context — the hasCanvas guard should have skipped this');
    return ctx;
  };

  it('Fill recolors opaque content to the fill colour (source-atop)', () => {
    const ctx = ctx2d(mkCanvas(10, 10));
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
    const ctx = ctx2d(mkCanvas(10, 10));
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
