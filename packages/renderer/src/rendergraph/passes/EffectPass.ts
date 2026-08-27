import { Color } from '../../core/math/Color';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSceneBlit, writeAttachment, screenMvp, targetSampleUv } from './passUtils';
import { getActiveViewerLut } from '../../shaders/colorPipeline';

export const SCENE_COLOR_TARGET = 'scene-color';
export const VIEWER_LUT_TEXTURE_KEY = 'viewer-lut';

/**
 * Post-process effect pass. Reads an offscreen scene-color target and composites
 * it back to the surface through an effect material (blur, glow, color-grade…).
 *
 * ── Why this blit REPLACES rather than blends (F10 / F12) ──
 *
 * `ClearPass.writes` is `[EffectPass.activeColorTarget]`, so when this pass is
 * enabled the per-frame clear goes to SCENE_COLOR_TARGET and **nothing clears
 * the SURFACE**. This blit is the only thing that writes it. With source-over
 * that made the surface a feedback buffer: wherever the finished frame had
 * partial alpha, `dst = src + (1-a)·dst` mixed in the PREVIOUS frame, and each
 * render converged a little further toward opacity without ever returning to
 * the first result.
 *
 * That is the whole of F10, and of F12 which widened it. It looked like a
 * transparent-comp problem because a transparent comp is the common way to get
 * partial alpha into the final composite — but Stencil and Silhouette reach the
 * same state on a fully OPAQUE comp, since scaling the backdrop's coverage is
 * what they do. The trigger was never the comp's alpha; it was any partial
 * alpha surviving to the surface, on a path where the surface is never cleared.
 *
 * Replacing is also simply what this pass means. It blits the entire scene over
 * the whole viewport, the background clear already lives inside scene-color,
 * and nothing else writes SURFACE before it — Clear and Composition both write
 * `activeColorTarget`; Overlay and Selection run after and still blend, as they
 * should. There is nothing underneath for this blit to blend WITH.
 *
 * ── THAT LAST CLAUSE WAS AN ASSUMPTION, AND IT WAS FALSE ──
 *
 * "Overlay and Selection run after" was asserted here and enforced nowhere. The
 * graph derives order from `reads` and `after` only — two passes that both
 * WRITE SURFACE get no edge between them — and both of those passes declared
 * `after: ['text']`, naming a pass no graph builds, which `compile()` silently
 * drops. Measured production order was `clear → selection → background →
 * overlay → composition → effect`: this blit ran LAST and erased every
 * composition grid line and user guide for any scene containing an effect.
 * Removing the effect brought them back, which is what made it read as an
 * effects bug rather than an ordering one.
 *
 * They now declare `composition` and `effect` in their own `after`, so the
 * sentence above is a constraint rather than a hope. Guarded by
 * `passOrder.test.ts`.
 *
 * Verified by measurement, not reasoning: with the four Matte scenes and the
 * Alpha Add seam scene registered, four consecutive renders were byte-identical
 * on both backends, and no committed golden changed.
 */
export class EffectPass extends RenderPass {
  static activeColorTarget = SURFACE;

  readonly name = 'effect';
  override readonly reads = [SCENE_COLOR_TARGET];
  override get writes(): readonly string[] {
    return [SURFACE];
  }
  /**
   * Was `['text']` — a pass no graph builds, so it was never a constraint. The
   * real ordering already comes from `reads`: `CompositionPass` writes
   * `activeColorTarget`, which is SCENE_COLOR_TARGET on this path, so the read
   * edge puts this blit after it. Naming `composition` makes that explicit
   * rather than emergent, and keeps the graph free of dangling names.
   */
  override readonly after = ['composition'];
  override enabled = false;

  execute(ctx: RenderPassContext): void {
    const source = ctx.target(SCENE_COLOR_TARGET);
    if (!source) return;
    const tex = ctx.services.backend.renderTargetTexture(source);
    if (!tex) return;

    const { services } = ctx;

    services.commands.clear();
    // Dedicated scene blit: encodes linear→sRGB when LINEAR_INTERMEDIATE_STORAGE
    // is on. Uploads tagged `rgba8unorm-srgb` decode at sample; RT copies use
    // the `*-linear` shader variant (see linearWorkingSpace.ts).
    // Viewer LUT (monitor look) is applied AFTER ODT when the app set meta +
    // uploaded the strip — auxiliary/export frames leave both unset.
    const viewerMeta = getActiveViewerLut();
    const viewerStrip = viewerMeta
      ? services.textures.get(VIEWER_LUT_TEXTURE_KEY)
      : null;
    emitSceneBlit(
      services.commands,
      screenMvp(),
      Color.white(),
      1,
      // REPLACE, not source-over. See the F10/F12 note above — the surface is
      // never cleared on this path, so blending here reads back the last frame.
      'none',
      tex,
      ctx.services.resources.sampler('linear-clamp', {
        min: 'linear',
        mag: 'linear',
        addressU: 'clamp',
        addressV: 'clamp',
      }),
      targetSampleUv(ctx),
      viewerStrip?.ready ? viewerStrip.texture : undefined,
    );

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, SURFACE));
    services.quad.execute(enc, services.commands);
    enc.end();
  }
}
