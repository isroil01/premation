import { Color } from '../../core/math/Color';
import { Rect } from '../../core/math/geometry';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitLayerTexture, writeAttachment } from './passUtils';
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
      emitLayerTexture(ctx, r, tex, r.opacity);
    }
    if (cmds.length === 0) return;

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, this.writes[0]!));
    services.quad.execute(enc, cmds);
    enc.end();
  }
}
