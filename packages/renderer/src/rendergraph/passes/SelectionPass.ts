import { Color } from '../../core/math/Color';
import type { Rect } from '../../core/math/geometry';
import { RenderPass, SURFACE, type RenderPassContext } from '../RenderPass';
import { beginViewportPass, emitSolid, modelFromRect, mvpFor, writeAttachment } from './passUtils';

/**
 * Draws selection outlines for `scene.selection`. Each selected renderable gets
 * four thin edge quads (a hollow rectangle) in the selection color. Editor
 * chrome only — never part of an exported frame.
 */
export class SelectionPass extends RenderPass {
  readonly name = 'selection';
  override get writes(): readonly string[] {
    return [SURFACE];
  }
  /**
   * Chrome paints LAST, over the finished picture.
   *
   * This used to be `['text']` — a pass no graph in this codebase builds.
   * `compile()` links an `after` entry only when that pass is active
   * (`if (byName.has(a))`), so a dangling name is silently NO constraint, and
   * selection floated to the front of the order: it ran before `composition`,
   * which then painted the scene straight over the outlines.
   *
   * `effect` is named explicitly because two passes that both WRITE the same
   * resource get no edge from it — order is derived from `reads` and `after`
   * only. `EffectPass` blits the whole viewport onto SURFACE with REPLACE (see
   * its F10/F12 note), so anything drawn to SURFACE before it is erased rather
   * than blended. A disabled `effect` is absent from `byName`, so naming it
   * costs nothing on the no-effect path.
   */
  override readonly after = ['composition', 'effect'];

  /** Selection accent (blue). */
  color = Color.of(0.23, 0.51, 0.96, 1);
  /** Outline thickness in screen pixels. */
  thickness = 2;

  execute(ctx: RenderPassContext): void {
    const { scene, viewport, services } = ctx;
    if (!scene.selection?.length) return;
    const selected = new Set(scene.selection);
    const cmds = services.commands;
    const tWorld = this.thickness / viewport.camera.zoom; // constant screen thickness

    for (const r of scene.renderables) {
      if (!selected.has(r.id)) continue;
      for (const edge of outlineEdges(r.bounds, tWorld)) {
        emitSolid(cmds, mvpFor(viewport, modelFromRect(edge)), this.color, 1, 'normal');
      }
    }
    if (cmds.length === 0) return;

    const enc = beginViewportPass(ctx, this.name, writeAttachment(ctx, SURFACE));
    services.quad.execute(enc, cmds);
    enc.end();
  }
}

/** Four rects forming a hollow outline of `b` with world-space thickness `t`. */
function outlineEdges(b: Rect, t: number): Rect[] {
  return [
    { x: b.x, y: b.y, width: b.width, height: t }, // top
    { x: b.x, y: b.y + b.height - t, width: b.width, height: t }, // bottom
    { x: b.x, y: b.y, width: t, height: b.height }, // left
    { x: b.x + b.width - t, y: b.y, width: t, height: b.height }, // right
  ];
}
