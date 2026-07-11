import { Color } from '../../core/math/Color';
import type { Rect } from '../../core/math/geometry';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, modelFromRect, mvpFor, writeAttachment } from './passUtils';

/**
 * Infinite-canvas overlays: grid lines and user guides. Lines are thin quads
 * spanning the visible world rect, generated at the viewport's grid spacing.
 * Rulers/safe-area are typically DOM/2D chrome; this pass covers the in-GPU
 * grid + guides. Editor chrome only.
 */
export class OverlayPass extends RenderPass {
  readonly name = 'overlay';
  override readonly writes = [SURFACE];
  override readonly after = ['selection'];

  gridColor = Color.of(1, 1, 1, 0.06);
  guideColor = Color.of(0.23, 0.51, 0.96, 0.8);
  /** Cap on generated grid lines (avoid pathological counts when zoomed out). */
  maxLines = 400;

  execute(ctx: RenderPassContext): void {
    const { viewport, services } = ctx;
    const o = viewport.overlays;
    if (!o.grid && o.guides.length === 0) return;

    const cmds = services.commands;
    const view = viewport.visibleWorldRect;
    const t = 1 / viewport.camera.zoom; // 1px lines

    if (o.grid && o.gridSpacing > 0) {
      for (const line of gridLines(view, o.gridSpacing, t, this.maxLines)) {
        emitSolid(cmds, mvpFor(viewport, modelFromRect(line)), this.gridColor, 1, 'normal');
      }
    }
    for (const g of o.guides) {
      const line =
        g.axis === 'x'
          ? { x: g.position, y: view.y, width: t, height: view.height }
          : { x: view.x, y: g.position, width: view.width, height: t };
      emitSolid(cmds, mvpFor(viewport, modelFromRect(line)), this.guideColor, 1, 'normal');
    }
    if (cmds.length === 0) return;

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, SURFACE));
    services.quad.execute(enc, cmds);
    enc.end();
  }
}

function gridLines(view: Rect, spacing: number, t: number, max: number): Rect[] {
  const lines: Rect[] = [];
  const startX = Math.floor(view.x / spacing) * spacing;
  const startY = Math.floor(view.y / spacing) * spacing;
  for (let x = startX; x <= view.x + view.width && lines.length < max; x += spacing) {
    lines.push({ x, y: view.y, width: t, height: view.height });
  }
  for (let y = startY; y <= view.y + view.height && lines.length < max; y += spacing) {
    lines.push({ x: view.x, y, width: view.width, height: t });
  }
  return lines;
}
