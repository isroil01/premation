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
import {
  isCanvas2dOnlyEffect,
  hasCanvas2dImplementation,
  applyCanvas2dEffect,
  withStyleSilhouette,
} from './canvas2dEffects';
import { isColorEffect, effectColorMatrix, applyColorMatrixImage } from './effectColorMatrix';

/** True when an effect has NO GPU shader form and must be CPU-baked into the
 *  layer texture for the GPU backend (interior styles, warps, keylight, beam,
 *  four-color gradient, directional blur, …). Fill / Stroke / Sharpen / Noise
 *  have CompositionPass materials and are NOT baked here. CSS/LUT/colour-matrix
 *  /procedural effects also have GPU forms. */
export function isGpuUnbakeableEffect(type: string): boolean {
  return isCanvas2dOnlyEffect(type);
}

/** Does this layer's enabled effect stack contain anything the GPU can't draw
 *  natively (so the GPU path must CPU-bake the whole layer)? */
export function effectsNeedCpuBake(effects: ReadonlyArray<Effect> | undefined): boolean {
  return !!effects?.some((e) => e.enabled !== false && isGpuUnbakeableEffect(e.type));
}

/**
 * Fill opacity is implemented in the CPU bake chain (see `applyEffectChain`),
 * so a layer using it renders through that path regardless of which effects it
 * carries. One implementation, identical on both backends — the alternative
 * was duplicating the subtract in the GPU composition pass and keeping the two
 * in step forever.
 */
export function layerNeedsCpuBake(
  effects: ReadonlyArray<Effect> | undefined,
  fillOpacity: number | undefined,
): boolean {
  return effectsNeedCpuBake(effects) || (fillOpacity !== undefined && fillOpacity < 1);
}

/**
 * Should an IMAGE or VIDEO layer's texture be baked through the effect chain?
 *
 * Shapes and text rasterize themselves, so a Canvas2D-only effect just joins
 * their draw. An image/video arrives as decoded pixels and used to be uploaded
 * untouched, so those effects — Inner Shadow, Inner Glow, Satin, Bevel, and the
 * rest of the Canvas2D-only family — silently did NOTHING on footage, in 2D and
 * 3D alike. They are not GPU-expressible, so the only way to render them is to
 * take the same canvas round-trip the vector path takes.
 *
 * VIDEO used to be excluded (per-frame bake cost). That made every interior
 * style and warp a silent no-op on moving footage — the exact failure mode this
 * codebase keeps deleting. Baking is keyed by source time + effect signature so
 * paused scrubbing still hits cache; playback pays the cost only when styles
 * that need it are present.
 *
 * A MASK is baked first, exactly as the vector path bakes it — interior styles
 * shape themselves from the layer's silhouette, and for a masked layer that
 * silhouette is the MASKED one, so the order is load-bearing rather than
 * incidental. The GPU mask is dropped for a baked layer so the mask is applied
 * once, not twice.
 *
 * Both the renderer backend (which requests the bake) and the snapshot adapter
 * (which then must NOT also hand the effects to the GPU) gate on THIS, so the
 * two cannot disagree and double-apply.
 */
export function imageNeedsCpuBake(
  kind: string,
  effects: ReadonlyArray<Effect> | undefined,
): boolean {
  return (kind === 'image' || kind === 'video') && effectsNeedCpuBake(effects);
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
  // Undefined is a legitimate input, not a caller error: `layerNeedsCpuBake`
  // sends a layer down this path for fill opacity ALONE, and such a layer has no
  // effect stack at all. Callers used to assert it non-null and the chain died
  // on `for (const e of undefined)`, which surfaced as the layer's texture feed
  // failing and the layer rendering unfaded.
  effects: ReadonlyArray<Effect> | undefined,
  scratch: (w: number, h: number) => HTMLCanvasElement,
  fillOpacity = 1,
): void {
  const off = oc.canvas;
  let pending: string[] = [];

  // FILL OPACITY — "fade the fill, keep the styles" (Photoshop's model).
  //
  // Opacity fades a layer AND its styles; fill opacity fades only the layer's
  // own pixels, so fill 0 on text with a drop shadow leaves the shadow floating
  // on its own, and an inner shadow stays at full strength on nothing.
  //
  // The previous implementation ran the whole chain at full alpha and then
  // subtracted the contents back out in proportion. That is right for styles
  // that sit OUTSIDE the silhouette — drop shadow, outer glow, stroke — and
  // wrong for every interior one, because inner shadow, inner glow, satin and
  // bevel live inside the contents' alpha and so came out of the subtraction
  // faded along with them. Photoshop holds them at full strength.
  //
  // What separates the two cases is that a style generator needs the layer's
  // SILHOUETTE, which is not the same thing as the pixels it composites onto.
  // So: snapshot the silhouette, fade the contents immediately, then run the
  // chain with that snapshot installed as the generators' alpha source. Every
  // style — interior and exterior alike — is shaped by the full-alpha silhouette
  // and lands at full strength, over faded contents.
  const fading = fillOpacity < 1;
  let silhouette: HTMLCanvasElement | null = null;
  if (fading) {
    silhouette = scratch(w, h);
    const cc = silhouette.getContext('2d');
    if (cc) {
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.globalCompositeOperation = 'source-over';
      cc.globalAlpha = 1;
      cc.filter = 'none';
      cc.clearRect(0, 0, w, h);
      cc.drawImage(off, 0, 0);

      // Fade the layer's own pixels NOW, before any style is generated.
      //
      // `destination-in` against a UNIFORM alpha, not `destination-out` against
      // the silhouette. The scaling wanted is Ao = Ad × fillOpacity, and
      // destination-in with a flat source of that alpha gives exactly that.
      // Subtracting the silhouette instead gives Ao = Ad × (1 − As), which is
      // only equivalent where the layer is fully opaque: on an antialiased edge
      // with Ad = As = 0.5, fill 0 left 25% of the fill behind rather than
      // erasing it, so a "fully transparent" fill kept a visible rim.
      oc.save();
      oc.setTransform(1, 0, 0, 1, 0, 0);
      oc.globalCompositeOperation = 'destination-in';
      oc.globalAlpha = Math.max(0, Math.min(1, fillOpacity));
      oc.fillStyle = '#000'; // colour is irrelevant under destination-in; only alpha applies
      oc.fillRect(0, 0, w, h);
      oc.restore();
    } else {
      silhouette = null;
    }
  }

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

  const runChain = (): void => {
  for (const e of effects ?? []) {
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
      } else if (hasCanvas2dImplementation(e.type)) {
        // NOT `isCanvas2dOnlyEffect`: Fill / Stroke / Sharpen / Noise have GPU
        // materials and so do not force a bake, but once a layer is baked for
        // any other reason its GPU effect list is dropped entirely and this is
        // the only place left that can draw them. Gating on "forces a bake"
        // instead of "can be drawn" made all four no-op on every layer that
        // also carried an interior style.
        flushCss();
        applyCanvas2dEffect(oc, w, h, e);
      }
      // else: a gpuOnly non-colour effect (displacement-map, motion-tile) has
      // no Canvas2D form and is skipped here.
    }
  }
  flushCss();
  };

  // The silhouette is installed for the whole chain, not per effect: a stack can
  // interleave generators with pixel passes, and every generator in it must shape
  // itself from the same full-alpha silhouette. Pixel passes ignore it by
  // construction — see `withStyleSilhouette`.
  if (silhouette) withStyleSilhouette(silhouette, runChain);
  else runChain();
}
