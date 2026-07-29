import { Color } from '../../core/math/Color';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, modelFromRect, mvpFor, writeAttachment } from './passUtils';
import { EffectPass } from './EffectPass';

/**
 * Draws the composition's own backdrop (a solid fill of its frame) over the
 * cleared surface, so the artboard is visible against the infinite canvas.
 * (Checkerboard/transparency-grid can be layered here via a procedural shader.)
 */
export class BackgroundPass extends RenderPass {
  readonly name = 'background';
  override get writes() {
    return [EffectPass.activeColorTarget];
  }
  override readonly after = ['clear'];

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    // Non-camera views draw no backdrop — see CompositionInfo.backdrop. The
    // fill goes through `mvpFor`, the 2D viewport transform, so it is always a
    // screen-axis-aligned rectangle; in a Left view that contradicts the comp
    // plane, which the overlay correctly draws edge-on as a line.
    if (scene.composition.backdrop === false) return;
    const bg = scene.composition.background ?? Color.of(1, 1, 1, 1);
    const rect = { x: 0, y: 0, width: scene.composition.size.width, height: scene.composition.size.height };
    emitSolid(services.commands, mvpFor(viewport, modelFromRect(rect)), bg, 1, 'normal');

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, this.writes[0]!));
    services.quad.execute(enc, services.commands);
    enc.end();
  }
}
