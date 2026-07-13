import { Color } from '../../core/math/Color';
import { Rect } from '../../core/math/geometry';
import type { RenderableSdf } from '../../scene/FrameScene';
import type { SolidShape } from '../../pipeline/uniforms';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, mvpFor, writeAttachment } from './passUtils';
import { EffectPass } from './EffectPass';

/** Map a renderable's SDF geometry to the solid shader's shape params. A radius
 *  is clamped to half the smaller side so a rounded-rect can't invert. */
function toSolidShape(sdf: RenderableSdf | undefined): SolidShape | undefined {
  if (!sdf) return undefined;
  if (sdf.shape === 'ellipse') return { kind: 2, radiusPx: 0, width: sdf.width, height: sdf.height };
  const r = Math.max(0, Math.min(sdf.radiusPx, Math.min(sdf.width, sdf.height) / 2));
  return { kind: 1, radiusPx: r, width: sdf.width, height: sdf.height };
}

/**
 * Renders solid-filled vector primitives (rects, paths, group backdrops).
 * Culls renderables whose world bounds fall outside the viewport, then emits one
 * solid quad each — consecutive solids batch into a single pipeline bind.
 */
export class ShapePass extends RenderPass {
  readonly name = 'shape';
  override get writes() {
    return [EffectPass.activeColorTarget];
  }
  override readonly after = ['background'];

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    const visible = viewport.visibleWorldRect;
    const cmds = services.commands;

    for (const r of scene.renderables) {
      if (r.kind !== 'rect' && r.kind !== 'path' && r.kind !== 'group') continue;
      if (!r.color || r.opacity <= 0) continue;
      if (!Rect.intersects(visible, r.bounds)) continue;
      emitSolid(cmds, mvpFor(viewport, r.modelMatrix), r.color ?? Color.white(), r.opacity, r.blend, toSolidShape(r.sdf));
    }
    if (cmds.length === 0) return;

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, this.writes[0]!));
    services.quad.execute(enc, cmds);
    enc.end();
  }
}
