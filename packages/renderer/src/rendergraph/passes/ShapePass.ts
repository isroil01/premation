import { Color } from '../../core/math/Color';
import { Rect } from '../../core/math/geometry';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, mvpFor, writeAttachment } from './passUtils';

/**
 * Renders solid-filled vector primitives (rects, paths, group backdrops).
 * Culls renderables whose world bounds fall outside the viewport, then emits one
 * solid quad each — consecutive solids batch into a single pipeline bind.
 */
export class ShapePass extends RenderPass {
  readonly name = 'shape';
  override readonly writes = [SURFACE];
  override readonly after = ['background'];

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    const visible = viewport.visibleWorldRect;
    const cmds = services.commands;

    for (const r of scene.renderables) {
      if (r.kind !== 'rect' && r.kind !== 'path' && r.kind !== 'group') continue;
      if (!r.color || r.opacity <= 0) continue;
      if (!Rect.intersects(visible, r.bounds)) continue;
      emitSolid(cmds, mvpFor(viewport, r.modelMatrix), r.color ?? Color.white(), r.opacity, r.blend);
    }
    if (cmds.length === 0) return;

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, SURFACE));
    services.quad.execute(enc, cmds);
    enc.end();
  }
}
