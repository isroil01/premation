/**
 * Fill opacity vs opacity.
 *
 * `opacity` fades a layer AND its styles. `fillOpacity` fades only the layer's
 * own pixels, so fill 0 on a shadowed layer leaves the shadow floating — the
 * canonical demonstration, and the reason the styles must be generated from the
 * layer at FULL alpha before anything is faded.
 */

import { layerNeedsCpuBake, effectsNeedCpuBake } from './effectBake';
import type { Effect } from './effects';

const blur: Effect = { id: 'e1', type: 'blur', params: { amount: 4 } };
const fill: Effect = { id: 'e2', type: 'fill', params: { color: '#f00', opacity: 100 } };

describe('routing — one implementation, both backends', () => {
  it('a layer using fill opacity takes the CPU-bake path', () => {
    // The subtract lives in applyEffectChain; the GPU composition pass must not
    // grow a second copy that has to be kept in step.
    expect(layerNeedsCpuBake([blur], 0.5)).toBe(true);
    expect(layerNeedsCpuBake(undefined, 0)).toBe(true);
  });

  it('a layer NOT using it is unaffected', () => {
    expect(layerNeedsCpuBake([blur], 1)).toBe(false);
    expect(layerNeedsCpuBake([blur], undefined)).toBe(false);
    expect(layerNeedsCpuBake(undefined, undefined)).toBe(false);
  });

  it('still bakes for CPU-only effects regardless of fill opacity', () => {
    expect(effectsNeedCpuBake([fill])).toBe(true);
    expect(layerNeedsCpuBake([fill], 1)).toBe(true);
  });
});

// Fill opacity IS a destination-out composite at a fractional globalAlpha, which
// is the exact operation Skia gets wrong (191 where the spec says 127). Asserting
// it on a backend that fails that probe measures the backend, not the feature.
// Real-Chromium coverage: packages/render-tests (scenes: fill-opacity-*).
import { canAssertLayerStylePixels } from './__testHelpers__/canvasFidelity';

(canAssertLayerStylePixels ? describe : describe.skip)('pixels', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { applyEffectChain } = require('./effectBake') as typeof import('./effectBake');
  const W = 60, H = 60;
  const scratch = (w: number, h: number): HTMLCanvasElement => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  };
  const layer = (): CanvasRenderingContext2D => {
    const c = scratch(W, H);
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(20, 20, 20, 20);
    return g;
  };
  const alphaAt = (g: CanvasRenderingContext2D, x: number, y: number) =>
    g.getImageData(x, y, 1, 1).data[3]!;

  it('fill opacity 1 changes nothing', () => {
    const a = layer(); applyEffectChain(a, W, H, [], scratch, 1);
    expect(alphaAt(a, 30, 30)).toBe(255);
  });

  it('fill opacity fades the layer’s own pixels', () => {
    const g = layer(); applyEffectChain(g, W, H, [], scratch, 0.5);
    const mid = alphaAt(g, 30, 30);
    expect(mid).toBeGreaterThan(90);
    expect(mid).toBeLessThan(160);
  });

  it('fill opacity 0 erases the contents entirely', () => {
    const g = layer(); applyEffectChain(g, W, H, [], scratch, 0);
    expect(alphaAt(g, 30, 30)).toBe(0);
  });

  it('a STROKE style survives fill opacity 0 — the floating-shadow case', () => {
    // The stroke is generated from the full-alpha silhouette and sits OUTSIDE
    // it, so subtracting the contents leaves the ring behind.
    const g = layer();
    applyEffectChain(g, W, H, [{ id: 's', type: 'stroke', params: { width: 6, color: '#ff0000', opacity: 100 } }],
      scratch, 0);
    expect(alphaAt(g, 30, 30)).toBe(0);          // contents gone
    expect(alphaAt(g, 30, 17)).toBeGreaterThan(0); // ring outside remains
  });
});
