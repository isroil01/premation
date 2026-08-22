/**
 * The batched-ImageData fast path's drawn-effect classification.
 *
 * `applyEffectChain` batches consecutive pixel passes on one shared ImageData
 * and must write it back before any effect that DRAWS with canvas ops.
 * A drawing effect missing from `DRAWN_CANVAS_EFFECTS` corrupts the frame
 * (it composites over a stale canvas, then the batch overwrites it) — and the
 * corruption is content-dependent, so no single golden frame reliably shows it.
 *
 * jsdom cannot rasterize, so the pixel-level proof lives in a browser A/B
 * (batched vs `batchPixelPasses=false` came back byte-identical on a chain
 * interleaving kernels, LUTs, CSS, drawn and procedural effects — 2026-08-14).
 * What CAN be pinned here: the classification stays inside the real registry,
 * and every member still has a Canvas2D implementation to flush for.
 */

import { drawnCanvasEffects } from './effectBake';
import { hasCanvas2dImplementation } from './canvas2dEffects';
import { effectDefFor } from './effects';

describe('DRAWN_CANVAS_EFFECTS', () => {
  it('names only real, Canvas2D-implemented effect types', () => {
    for (const type of drawnCanvasEffects()) {
      expect(effectDefFor(type as never)).toBeDefined();
      expect(hasCanvas2dImplementation(type)).toBe(true);
    }
  });

  it('covers the canvas-ops generators a stale batch would corrupt', () => {
    // Spot-pin the families: interior styles, wipes, and the draw generators.
    for (const must of [
      'inner-shadow', 'inner-glow', 'satin', 'linear-wipe', 'beam',
      'lens-flare', 'checkerboard', 'numbers', 'lightning', 'fill', 'stroke',
    ]) {
      expect(drawnCanvasEffects().has(must)).toBe(true);
    }
  });
});
