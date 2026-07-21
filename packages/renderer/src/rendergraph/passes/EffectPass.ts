import { Color } from '../../core/math/Color';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitTextured, writeAttachment, screenMvp, targetSampleUv } from './passUtils';

export const SCENE_COLOR_TARGET = 'scene-color';

/**
 * Post-process effect pass. Reads an offscreen scene-color target and composites
 * it back to the surface through an effect material (blur, glow, color-grade…).
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
      'normal',
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
