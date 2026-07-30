import { Color } from '../../core/math/Color';
import type { Mat3 } from '../../core/math/Mat3';
import type { Size } from '../../core/math/geometry';
import type { Viewport } from '../../viewport/Viewport';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, modelFromRect, mvpFor, writeAttachment } from './passUtils';
import { EffectPass } from './EffectPass';

/**
 * Clip-space transform for the composition backdrop: the unit quad placed on the
 * comp rect, through the 2D pan/zoom camera.
 *
 * The SAME transform in every view, including the six ortho views and the custom
 * views. That is the fix for a real defect — those views used to paint no
 * backdrop at all, so switching a comp to Left threw away its background and the
 * artboard vanished, leaving only the projected dashed outline over bare
 * pasteboard while the layers kept drawing.
 *
 * Matches After Effects, which renders EVERY view into the same comp-sized frame
 * and only changes the camera that projects layers into it. The comp rect is the
 * frame you are rendering; it does not move because you looked from the side.
 *
 * A Left view therefore shows two things at once, deliberately: this filled rect
 * (the frame that will be exported) and `SceneGeometryOverlay`'s projected dashed
 * quad (where the comp's z=0 PLANE sits in space, edge-on). Two different, both
 * true facts. An earlier attempt suppressed the fill to avoid showing "two comp
 * frames"; that traded a mild ambiguity for a blank view, which was worse.
 *
 * Pure and exported so `backgroundPass.test.ts` can assert the covered area
 * directly rather than diffing pixels.
 */
export function backdropMvp(viewport: Viewport, size: Size): Mat3 {
  return mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: size.width, height: size.height }));
}

/**
 * Draws the composition's own backdrop over the cleared surface, so the
 * artboard is visible against the infinite canvas.
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
    const bg = scene.composition.background ?? Color.of(1, 1, 1, 1);
    emitSolid(services.commands, backdropMvp(viewport, scene.composition.size), bg, 1, 'normal');

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, this.writes[0]!));
    services.quad.execute(enc, services.commands);
    enc.end();
  }
}
