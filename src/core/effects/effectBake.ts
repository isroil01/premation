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
import { effectCss, effectHasOpacity, effectOpacityOf } from './effects';
import { paintMaskMatte, type LayerMask, type MaskPath } from '@core/effects/mask';
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

/**
 * Does this layer's enabled effect stack contain anything the GPU can't draw
 * natively (so the GPU path must CPU-bake the whole layer)?
 *
 * A MASK-SCOPED effect counts regardless of its type (M6). The GPU effect chain
 * has no notion of a per-effect scope, so handing it a scoped effect would apply
 * that effect to the WHOLE layer — a blur meant for one region blurring
 * everything, which looks like a plausible design choice rather than a bug.
 * Scoping is honoured only in the bake, so requesting it forces the bake.
 *
 * An effect carrying a COMPOSITING-OPTIONS OPACITY counts for the same reason
 * and one more. Blending an effect against its own input needs both images at
 * once, and the GPU chain has only the running one — but more to the point, the
 * blend is defined here in exactly one place, the way fill opacity is (see
 * `layerNeedsCpuBake`), rather than reimplemented in the composition pass and
 * kept in step forever. PRESENCE of the field is the test, not `< 100`: an
 * animated opacity is stamped on every frame including those sampling 100, so
 * a 0→100→0 ramp stays on one path for its whole length instead of flipping to
 * the GPU at the peak and popping where the two backends round differently.
 */
export function effectsNeedCpuBake(effects: ReadonlyArray<Effect> | undefined): boolean {
  return !!effects?.some(
    (e) => e.enabled !== false
      && (isGpuUnbakeableEffect(e.type) || !!e.maskId || effectHasOpacity(e)),
  );
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

/** The minimum a caller must know about a layer to answer "is it baked?". */
export interface BakeSubject {
  kind: string;
  effects?: ReadonlyArray<Effect>;
  fillOpacity?: number;
}

/**
 * THE single source of truth for "is this layer baked?" (M5b / F6).
 *
 * ── Why this exists ──────────────────────────────────────────────────
 * Bake ownership was expressed by three predicates that a caller had to CHOOSE
 * between, and the correct choice depends on the layer's KIND:
 *
 *   vector (shape/text)   layerNeedsCpuBake   — effects OR fill opacity
 *   image / video         imageNeedsCpuBake   — effects only
 *   neither               effectsNeedCpuBake  — the narrow term
 *
 * Choosing wrong is not a crash. It is two sides of the pipeline disagreeing
 * about who owns the effect chain, and the symptom is that the chain runs TWICE.
 * That shipped: `snapshotToFrameScene` gated on `effectsNeedCpuBake` while
 * `Canvas2DVectorRasterizer` gated on `layerNeedsCpuBake`, and because fill
 * opacity alone triggers a bake with no effect requiring it, the grade, LUT,
 * mask and spatial effects were applied by both sides. The render-test scene
 * `fill-opacity-zero-stroke` caught it only by luck of which commits landed
 * together — correct at HEAD, wrong mid-branch, correct again by accident.
 *
 * Three call sites kept in step by attention IS the defect. This function takes
 * the LAYER and dispatches internally, so there is no choice left to get wrong.
 * Prefer it everywhere. The narrower predicates stay exported for the places
 * that genuinely need one term (cache-signature construction) and for tests.
 *
 * Fill opacity deliberately does NOT apply to image/video — it is a shape-fill
 * concept. That asymmetry used to be implicit in which function a caller
 * happened to reach for; it is now stated once, here.
 */
export function layerIsBaked(layer: BakeSubject): boolean {
  if (layer.kind === 'image' || layer.kind === 'video') {
    return imageNeedsCpuBake(layer.kind, layer.effects);
  }
  return layerNeedsCpuBake(layer.effects, layer.fillOpacity);
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
 * Effects whose Canvas2D pass DRAWS with canvas ops (or replaces the frame
 * wholesale) instead of transforming a pixel buffer. The batched-ImageData
 * fast path below must WRITE THE BATCH BACK before dispatching one of these,
 * or they would composite over a stale canvas.
 *
 * Derived from `scripts/effectPortTriage.cjs --list` ("canvas ops" +
 * "createImageData" classes) and pinned against it by
 * `effectBakeBatch.test.ts`, so a future round cannot silently add a drawing
 * effect that corrupts the batch. Fill and Stroke draw too; they are outside
 * the triage population (they have GPU materials) and are listed by hand.
 */
const DRAWN_CANVAS_EFFECTS = new Set<string>([
  'four-color-gradient', 'beam', 'inner-shadow', 'inner-glow', 'satin',
  'directional-blur', 'linear-wipe', 'transform', 'checkerboard', 'grid',
  'lens-flare', 'numbers', 'timecode', 'audio-spectrum', 'circle', 'ellipse',
  'radio-waves', 'lightning', 'light-rays', 'light-sweep', 'audio-waveform',
  'fill', 'stroke',
]);

/** Test seam: the drawn-effect classification, for the triage-parity guard. */
export function drawnCanvasEffects(): ReadonlySet<string> {
  return DRAWN_CANVAS_EFFECTS;
}

/**
 * Apply the effect chain to `oc` (a w×h content canvas, transform reset to
 * identity by the caller). `scratch` supplies a same-size working canvas for
 * the CSS-filter flush step (the caller owns pooling). Mutates `oc` in place.
 *
 * ── The batched-ImageData fast path ──────────────────────────────────
 * Every CPU pixel pass used to do its own full-frame `getImageData` +
 * `putImageData` — a GPU↔CPU sync each way, ~6–15 ms a pair at real canvas
 * sizes. A 100-effect stack spent over a second in TRANSFERS alone (measured:
 * 1.3 s at 512², of which the kernels were a small fraction).
 *
 * For the duration of the chain, `getImageData`/`putImageData` on `oc` are
 * INTERCEPTED: the first full-frame read materialises one shared ImageData,
 * every subsequent full-frame read returns it, and full-frame writes of that
 * same object just mark it dirty. Consecutive pixel passes therefore run
 * back-to-back on one buffer with zero canvas traffic. The batch is written
 * back only when something must see the real canvas: a CSS-filter flush, a
 * scoped-mask composite, a procedural generator, or one of the
 * DRAWN_CANVAS_EFFECTS above. Partial-frame reads/writes flush first and pass
 * through untouched.
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
  /** The layer's mask stack, for effects that carry a `maskId` scope (M6). */
  masks?: LayerMask,
  /** Test seam: false forces the pre-batch per-effect transfer behaviour. */
  batchPixelPasses = true,
): void {
  const off = oc.canvas;
  let pending: string[] = [];

  // ── Batched-ImageData plumbing (see the function doc) ──
  const origGetImageData = oc.getImageData.bind(oc);
  const origPutImageData = oc.putImageData.bind(oc);
  let batchImg: ImageData | null = null;
  let batchDirty = false;
  const flushBatch = (): void => {
    if (batchImg && batchDirty) origPutImageData(batchImg, 0, 0);
    batchImg = null;
    batchDirty = false;
  };
  if (batchPixelPasses) {
    (oc as { getImageData: typeof oc.getImageData }).getImageData = ((
      sx: number, sy: number, sw: number, sh: number, settings?: ImageDataSettings,
    ): ImageData => {
      if (sx === 0 && sy === 0 && sw === w && sh === h && !settings) {
        if (!batchImg) batchImg = origGetImageData(0, 0, w, h);
        return batchImg;
      }
      flushBatch();
      return settings ? origGetImageData(sx, sy, sw, sh, settings) : origGetImageData(sx, sy, sw, sh);
    }) as typeof oc.getImageData;
    (oc as { putImageData: typeof oc.putImageData }).putImageData = ((
      data: ImageData, dx: number, dy: number, ...rest: number[]
    ): void => {
      if (data === batchImg && dx === 0 && dy === 0 && rest.length === 0) {
        batchDirty = true;
        return;
      }
      flushBatch();
      (origPutImageData as (d: ImageData, x: number, y: number, ...r: number[]) => void)(data, dx, dy, ...rest);
    }) as typeof oc.putImageData;
  }

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
    // The CSS pass reads the REAL canvas — land the batch first. Also the
    // flush point every other canvas-reading step routes through.
    flushBatch();
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

  /**
   * Composite `after` (currently in `oc`) back over `before`, weighted by the
   * effect's coverage:
   *
   *   out = before·(1−cov) + after·cov
   *
   * where cov is the mask's matte (the M6 scoped-effect blend), a flat
   * Compositing-Options opacity, or — when an effect carries both — the two
   * multiplied, so a half-strength blur through a feathered mask is half as
   * strong at the mask's core and fades from there.
   *
   * Done with canvas ops rather than a pixel loop so feather and per-mask
   * opacity come through as real partial coverage.
   *
   * At cov = 0 the output is `before` BYTE-IDENTICAL, alpha included, and at
   * cov = 1 it is `after` byte-identical. The first is the invariant that makes
   * this an effect mask and not a second layer mask — it decides where the
   * effect applies, never where the layer exists — and the second is what lets
   * an author park an opacity keyframe at 100 without the frame shifting under
   * a round-trip that should have been the identity.
   */
  const compositeBlend = (
    before: HTMLCanvasElement,
    path: MaskPath | undefined,
    alpha: number,
  ): void => {
    flushBatch(); // reads oc.canvas through other contexts

    // ── The flat case: no mask, so the coverage is a constant ──
    // Two ops on `oc` and no scratch canvas at all. `destination-in` against a
    // uniform alpha scales the premultiplied result to after·α (the same trick
    // fill opacity uses above); `lighter` is Porter-Duff PLUS, so the second
    // draw ADDS before·(1−α) rather than compositing it under, which is what a
    // linear blend needs. The two terms sum to at most 1, so nothing clamps.
    if (!path) {
      const a = Math.max(0, Math.min(1, alpha));
      oc.save();
      oc.setTransform(1, 0, 0, 1, 0, 0);
      oc.filter = 'none';
      oc.globalCompositeOperation = 'destination-in';
      oc.globalAlpha = a;
      oc.fillStyle = '#000'; // irrelevant under destination-in; only alpha applies
      oc.fillRect(0, 0, w, h);
      oc.globalCompositeOperation = 'lighter';
      oc.globalAlpha = 1 - a;
      oc.drawImage(before, 0, 0);
      oc.restore();
      return;
    }

    const cov = scratch(w, h);
    const cc = cov.getContext('2d');
    if (!cc) return;
    cc.setTransform(1, 0, 0, 1, 0, 0);
    cc.clearRect(0, 0, w, h);
    // Mask points are in layer-local CENTRED space; the bake canvas is
    // top-left origin, so shift by half. Painted as a single-path stack so the
    // path's own feather and opacity are the coverage — that is what makes a
    // soft mask give a soft effect edge rather than a hard cut of a soft one.
    cc.translate(w / 2, h / 2);
    paintMaskMatte(cc, { paths: [{ ...path, mode: 'add' }] }, w, h);
    // Fold a Compositing-Options opacity INTO the matte rather than blending
    // twice: scaling the coverage keeps the whole composite below a single
    // `cov`, so the byte-identity at both ends survives the combination.
    if (alpha < 1) {
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.globalCompositeOperation = 'destination-in';
      cc.globalAlpha = Math.max(0, alpha);
      cc.fillStyle = '#000';
      cc.fillRect(0, 0, w, h);
      cc.globalCompositeOperation = 'source-over';
      cc.globalAlpha = 1;
    }

    // after ∩ coverage
    const after = scratch(w, h);
    const ac = after.getContext('2d');
    if (!ac) return;
    ac.setTransform(1, 0, 0, 1, 0, 0);
    ac.clearRect(0, 0, w, h);
    ac.drawImage(oc.canvas, 0, 0);
    ac.globalCompositeOperation = 'destination-in';
    ac.drawImage(cov, 0, 0);

    // before minus coverage, then add the masked after
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.globalCompositeOperation = 'source-over';
    oc.filter = 'none';
    oc.clearRect(0, 0, w, h);
    oc.drawImage(before, 0, 0);
    oc.globalCompositeOperation = 'destination-out';
    oc.drawImage(cov, 0, 0);
    oc.globalCompositeOperation = 'source-over';
    oc.drawImage(after, 0, 0);
  };

  const snapshot = (): HTMLCanvasElement => {
    flushBatch(); // copies oc.canvas — the batch must be visible on it
    const c = scratch(w, h);
    const cx = c.getContext('2d');
    if (cx) {
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.clearRect(0, 0, w, h);
      cx.drawImage(oc.canvas, 0, 0);
    }
    return c;
  };

  const runChain = (): void => {
  for (const e of effects ?? []) {
    if (e.enabled === false) continue;
    // ── Effect-scoped mask (M6) and Compositing-Options opacity ──
    // Both are the same operation — blend this effect's output against its own
    // input — so they share one composite and one `before` snapshot. Taking two
    // snapshots for an effect carrying both would be a second full-frame copy
    // for a blend that is already expressible as one scaled matte.
    //
    // Everything queued before this must LAND first, or the composite would
    // capture a `before` that is missing the effects above it and then replay
    // them through the blend.
    const scope = e.maskId ? masks?.paths.find((p) => p.id === e.maskId) : undefined;
    const alpha = effectOpacityOf(e);
    if (scope || alpha < 1) {
      // Opacity 0 with no mask is the identity: skip the effect outright rather
      // than run it and then discard every pixel of it. This is the frame an
      // author sits on for most of a fade-in's length, so it is worth the
      // branch — a Gaussian Blur held at 0 costs nothing instead of costing a
      // full blur plus a composite that throws the blur away.
      if (!scope && alpha <= 0) continue;
      flushCss();
      const before = snapshot();
      applyOne(e);
      flushCss();
      compositeBlend(before, scope, alpha);
      continue;
    }
    applyOne(e);
  }
  flushCss();
  };

  function applyOne(e: Effect): void {
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
        flushBatch(); // generators draw/replace on the real canvas
        applyProceduralEffect(oc, w, h, e);
      } else if (hasCanvas2dImplementation(e.type)) {
        // NOT `isCanvas2dOnlyEffect`: Fill / Stroke / Sharpen / Noise have GPU
        // materials and so do not force a bake, but once a layer is baked for
        // any other reason its GPU effect list is dropped entirely and this is
        // the only place left that can draw them. Gating on "forces a bake"
        // instead of "can be drawn" made all four no-op on every layer that
        // also carried an interior style.
        flushCss();
        // Drawing effects composite on the real canvas; pixel passes ride the
        // intercepted getImageData/putImageData and stay in the batch.
        if (DRAWN_CANVAS_EFFECTS.has(e.type)) flushBatch();
        applyCanvas2dEffect(oc, w, h, e);
      }
      // else: a gpuOnly non-colour effect (displacement-map, motion-tile) has
      // no Canvas2D form and is skipped here.
    }
  }

  // The silhouette is installed for the whole chain, not per effect: a stack can
  // interleave generators with pixel passes, and every generator in it must shape
  // itself from the same full-alpha silhouette. Pixel passes ignore it by
  // construction — see `withStyleSilhouette`.
  try {
    if (silhouette) withStyleSilhouette(silhouette, runChain);
    else runChain();
  } finally {
    // Land whatever is still batched and give the context its real methods
    // back — the caller (and the raster cache) must see finished pixels.
    flushBatch();
    if (batchPixelPasses) {
      (oc as { getImageData: typeof oc.getImageData }).getImageData = origGetImageData;
      (oc as { putImageData: typeof oc.putImageData }).putImageData = origPutImageData;
    }
  }
}
