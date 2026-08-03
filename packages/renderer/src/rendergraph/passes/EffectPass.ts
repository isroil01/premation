import { Color } from '../../core/math/Color';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitTextured, writeAttachment, screenMvp, targetSampleUv } from './passUtils';

export const SCENE_COLOR_TARGET = 'scene-color';

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
  override readonly after = ['text'];
  override enabled = false;

  execute(ctx: RenderPassContext): void {
    const source = ctx.target(SCENE_COLOR_TARGET);
    if (!source) return;
    const tex = ctx.services.backend.renderTargetTexture(source);
    if (!tex) return;

    const { services } = ctx;

    services.commands.clear();
    emitTextured(
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
      targetSampleUv(ctx)
    );

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, SURFACE));
    services.quad.execute(enc, services.commands);
    enc.end();
  }
}
