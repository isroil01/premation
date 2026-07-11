import type { Color } from '../../core/math/Color';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, writeAttachment } from './passUtils';

/** Clears the surface to the viewport background color. Runs first. */
export class ClearPass extends RenderPass {
  readonly name = 'clear';
  override readonly writes = [SURFACE];

  execute(ctx: RenderPassContext): void {
    const clear: Color = ctx.viewport.overlays.background;
    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, SURFACE, clear));
    enc.end();
  }
}
