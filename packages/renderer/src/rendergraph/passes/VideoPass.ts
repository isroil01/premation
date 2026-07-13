import { Color } from '../../core/math/Color';
import { Rect } from '../../core/math/geometry';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitTextured, mvpFor, writeAttachment } from './passUtils';
import { EffectPass } from './EffectPass';

/**
 * Renders video renderables. The texture provider is expected to supply a
 * per-frame video texture (uploaded from the current playback frame); if it
 * isn't ready yet the renderable is skipped this frame rather than flashing.
 */
export class VideoPass extends RenderPass {
  readonly name = 'video';
  override get writes() {
    return [EffectPass.activeColorTarget];
  }
  override readonly after = ['image'];

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    const visible = viewport.visibleWorldRect;
    const cmds = services.commands;

    for (const r of scene.renderables) {
      if (r.kind !== 'video') continue;
      if (r.opacity <= 0 || !Rect.intersects(visible, r.bounds)) continue;
      const tex = services.textures.get(r.textureKey ?? r.id);
      if (!tex || !tex.ready) continue;
      emitTextured(cmds, mvpFor(viewport, r.modelMatrix), r.color ?? Color.white(), r.opacity, r.blend, tex.texture, tex.sampler, r.uvRect ?? tex.uv, r.colorMatrix);
    }
    if (cmds.length === 0) return;

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, this.writes[0]!));
    services.quad.execute(enc, cmds);
    enc.end();
  }
}
