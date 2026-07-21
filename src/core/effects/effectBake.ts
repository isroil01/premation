/**
 * Effect-chain baking — apply a layer's full effect stack, in order, to an
 * already-rasterized content canvas.
 *
 * Extracted from Canvas2DBackend so BOTH render paths share one implementation:
 *   • Canvas2D backend — bakes a layer's offscreen before compositing.
 *   • GPU texture provider — CPU-rasterizes a layer that carries a Canvas2D-only
 *     effect (Fill/Stroke/Sharpen/Noise/Keylight/warp/…) into its texture, so
 *     the GPU can draw the exact Canvas2D result. Those effects have no shader
 *     form; without this they silently no-op on the GPU backend.
 *
 * The chain interleaves CSS-filter effects (batched into one `filter` string),
 * per-pixel LUT effects (Levels/Curves/Posterize), colour-matrix effects
 * (Tint/Channel Mixer), procedural generators (Gradient Ramp/Fractal Noise) and
 * the Canvas2D-only generator/pixel passes — each applied at its position in the
 * stack, exactly as After Effects evaluates an effect list top-to-bottom.
 */

import type { Effect } from './effects';
import { effectCss } from './effects';
import { isLutEffect, buildChannelLut, applyChannelLut } from './colorLut';
import { isCanvas2dProcedural, applyProceduralEffect } from './proceduralCanvas2d';
import { isCanvas2dOnlyEffect, applyCanvas2dEffect } from './canvas2dEffects';
import { isColorEffect, effectColorMatrix, applyColorMatrixImage } from './effectColorMatrix';

/** True when an effect has NO GPU shader form and must be CPU-baked into the
 *  layer texture for the GPU backend (the Canvas2D-only generator/pixel-pass
 *  family: Fill, Stroke, 4-Colour Gradient, Beam, Sharpen, Noise, Keylight,
 *  Wave Warp, Turbulent Displace). CSS/LUT/colour-matrix/procedural effects
 *  all have GPU forms and are handled by shaders, so they are NOT baked here. */
export function isGpuUnbakeableEffect(type: string): boolean {
  return isCanvas2dOnlyEffect(type);
}

/** Does this layer's enabled effect stack contain anything the GPU can't draw
 *  natively (so the GPU path must CPU-bake the whole layer)? */
export function effectsNeedCpuBake(effects: ReadonlyArray<Effect> | undefined): boolean {
  return !!effects?.some((e) => e.enabled !== false && isGpuUnbakeableEffect(e.type));
}

/**
 * Apply the effect chain to `oc` (a w×h content canvas, transform reset to
 * identity by the caller). `scratch` supplies a same-size working canvas for
 * the CSS-filter flush step (the caller owns pooling). Mutates `oc` in place.
 */
export function applyEffectChain(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  effects: ReadonlyArray<Effect>,
  scratch: (w: number, h: number) => HTMLCanvasElement,
): void {
  const off = oc.canvas;
  let pending: string[] = [];

  const flushCss = (): void => {
    if (pending.length === 0) return;
    const tmp = scratch(w, h);
    const tc = tmp.getContext('2d');
    if (tc) {
      tc.setTransform(1, 0, 0, 1, 0, 0);
      tc.globalCompositeOperation = 'source-over';
      tc.filter = 'none';
      tc.clearRect(0, 0, w, h);
      tc.drawImage(off, 0, 0);
      oc.setTransform(1, 0, 0, 1, 0, 0);
      oc.globalCompositeOperation = 'source-over';
      oc.clearRect(0, 0, w, h);
      oc.filter = pending.join(' ');
      oc.drawImage(tmp, 0, 0);
      oc.filter = 'none';
    }
    pending = [];
  };

  for (const e of effects) {
    if (e.enabled === false) continue;
    if (isLutEffect(e.type)) {
      flushCss();
      const lut = buildChannelLut([e]);
      if (lut) {
        oc.setTransform(1, 0, 0, 1, 0, 0);
        const img = oc.getImageData(0, 0, w, h);
        applyChannelLut(img.data, lut);
        oc.putImageData(img, 0, 0);
      }
    } else {
      const f = effectCss(e);
      if (f) {
        pending.push(f);
      } else if (isColorEffect(e.type)) {
        flushCss();
        oc.setTransform(1, 0, 0, 1, 0, 0);
        const img = oc.getImageData(0, 0, w, h);
        applyColorMatrixImage(img.data, effectColorMatrix([e]));
        oc.putImageData(img, 0, 0);
      } else if (isCanvas2dProcedural(e.type)) {
        flushCss();
        applyProceduralEffect(oc, w, h, e);
      } else if (isCanvas2dOnlyEffect(e.type)) {
        flushCss();
        applyCanvas2dEffect(oc, w, h, e);
      }
      // else: a gpuOnly non-colour effect (displacement-map, motion-tile) has
      // no Canvas2D form and is skipped here.
    }
  }
  flushCss();
}
