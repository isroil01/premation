import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, mvpFor, writeAttachment } from './passUtils';
import { Color } from '../../core/math/Color';

export const MASK_TARGET = 'mask';

/**
 * Renders mask shapes into an offscreen alpha target (`MASK_TARGET`) that later
 * passes sample to clip content. This is the structural half of masking; the
 * consuming side is a masked-content material that multiplies by the mask
 * texture. Declared off by default (the default graph renders straight to the
 * surface); enable + wire a masked material to activate.
 */
export class MaskPass extends RenderPass {
  readonly name = 'mask';
  override get writes(): readonly string[] {
    return [MASK_TARGET];
  }
  override readonly after = ['background'];
  override enabled = false;

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    const cmds = services.commands;
    const masks = scene.renderables.filter((r) => r.maskId || r.clip);
    if (masks.length === 0) return;

    for (const r of masks) {
      // White = fully opaque mask coverage; sampled as alpha downstream.
      emitSolid(cmds, mvpFor(viewport, r.modelMatrix), Color.white(), r.opacity, 'normal');
    }
    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, MASK_TARGET, Color.transparent()));
    services.quad.execute(enc, cmds);
    enc.end();
  }
}
