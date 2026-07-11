import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, writeAttachment } from './passUtils';

export const SCENE_COLOR_TARGET = 'scene-color';

/**
 * Post-process effect pass. Reads an offscreen scene-color target and composites
 * it back to the surface through an effect material (blur, glow, color-grade…).
 * The structural wiring is here (declare `SCENE_COLOR_TARGET`, sample it, blit);
 * concrete effect shaders register as materials and select per-frame. Off by
 * default — the default graph renders directly to the surface.
 */
export class EffectPass extends RenderPass {
  readonly name = 'effect';
  override readonly reads = [SCENE_COLOR_TARGET];
  override readonly writes = [SURFACE];
  override readonly after = ['text'];
  override enabled = false;

  execute(ctx: RenderPassContext): void {
    const source = ctx.target(SCENE_COLOR_TARGET);
    if (!source) return;
    const tex = ctx.services.backend.renderTargetTexture(source);
    void tex; // A full-screen blit through the effect material samples `tex`.
    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, SURFACE));
    // No-op composite placeholder: real effects bind the effect pipeline + `tex`
    // and draw a full-screen triangle. Kept inert until a material is supplied.
    enc.end();
  }
}
