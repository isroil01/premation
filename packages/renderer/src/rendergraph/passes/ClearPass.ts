import type { Color } from '../../core/math/Color';
import { toWorkingColor } from '../../shaders/linearWorkingSpace';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, writeAttachment } from './passUtils';
import { EffectPass } from './EffectPass';

/** Clears the surface to the viewport background color. Runs first. */
export class ClearPass extends RenderPass {
  readonly name = 'clear';
  override get writes() {
    return [EffectPass.activeColorTarget];
  }

  execute(ctx: RenderPassContext): void {
    const clear: Color = toWorkingColor(ctx.viewport.overlays.background);
    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, this.writes[0]!, clear));
    enc.end();
  }
}
