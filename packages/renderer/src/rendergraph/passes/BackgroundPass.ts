import { Color } from '../../core/math/Color';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, modelFromRect, mvpFor, writeAttachment } from './passUtils';

/**
 * Draws the composition's own backdrop (a solid fill of its frame) over the
 * cleared surface, so the artboard is visible against the infinite canvas.
 * (Checkerboard/transparency-grid can be layered here via a procedural shader.)
 */
export class BackgroundPass extends RenderPass {
  readonly name = 'background';
  override readonly writes = [SURFACE];
  override readonly after = ['clear'];

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    const bg = scene.composition.background ?? Color.of(1, 1, 1, 1);
    const rect = { x: 0, y: 0, width: scene.composition.size.width, height: scene.composition.size.height };
    emitSolid(services.commands, mvpFor(viewport, modelFromRect(rect)), bg, 1, 'normal');

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, SURFACE));
    services.quad.execute(enc, services.commands);
    enc.end();
  }
}
