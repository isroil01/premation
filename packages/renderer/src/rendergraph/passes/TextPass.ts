import { Color } from '../../core/math/Color';
import { Rect } from '../../core/math/geometry';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitTextured, mvpFor, writeAttachment } from './passUtils';
import { EffectPass } from './EffectPass';

/**
 * Renders text. Text is rasterized upstream into a glyph atlas / text texture
 * exposed by the texture provider (keyed by `text:<id>` or the renderable's
 * textureKey); this pass composites it tinted by the renderable color. Actual
 * glyph shaping/rasterization lives outside the GPU renderer (a text subsystem).
 */
export class TextPass extends RenderPass {
  readonly name = 'text';
  override get writes() {
    return [EffectPass.activeColorTarget];
  }
  override readonly after = ['video'];

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    const visible = viewport.visibleWorldRect;
    const cmds = services.commands;

    for (const r of scene.renderables) {
      if (r.kind !== 'text') continue;
      if (r.opacity <= 0 || !Rect.intersects(visible, r.bounds)) continue;
      const tex = services.textures.get(r.textureKey ?? `text:${r.id}`);
      if (!tex || !tex.ready) continue;
      emitTextured(cmds, mvpFor(viewport, r.modelMatrix), r.color ?? Color.white(), r.opacity, r.blend, tex.texture, tex.sampler, r.uvRect ?? tex.uv, r.colorMatrix);
    }
    if (cmds.length === 0) return;

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, this.writes[0]!));
    services.quad.execute(enc, cmds);
    enc.end();
  }
}
