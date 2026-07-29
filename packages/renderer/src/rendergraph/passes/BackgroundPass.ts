import { Color } from '../../core/math/Color';
import type { Mat3 } from '../../core/math/Mat3';
import type { Size } from '../../core/math/geometry';
import type { Viewport } from '../../viewport/Viewport';
import type { BackdropMode } from '../../scene/FrameScene';
import { RenderPass, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, modelFromRect, mvpFor, screenMvp, writeAttachment } from './passUtils';
import { EffectPass } from './EffectPass';

/**
 * Clip-space transform for the backdrop quad, per mode.
 *
 * `'frame'` puts the unit quad on the comp rect and runs it through the 2D
 * pan/zoom camera, so the fill tracks the artboard. `'viewport'` maps the unit
 * quad straight to clip space, so it covers the surface whatever the camera is
 * doing — the ortho and custom views, where there is no artboard to track.
 *
 * Pure and exported so `backgroundPass.test.ts` can assert the covered area
 * directly rather than diffing pixels.
 */
export function backdropMvp(mode: BackdropMode, viewport: Viewport, size: Size): Mat3 {
  return mode === 'viewport'
    ? screenMvp()
    : mvpFor(viewport, modelFromRect({ x: 0, y: 0, width: size.width, height: size.height }));
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
    const mvp = backdropMvp(scene.composition.backdrop ?? 'frame', viewport, scene.composition.size);
    emitSolid(services.commands, mvp, bg, 1, 'normal');

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, this.writes[0]!));
    services.quad.execute(enc, services.commands);
    enc.end();
  }
}
