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
  override get writes(): readonly string[] {
    return [SURFACE];
  }
  /**
   * `composition` and `effect` are named for the same reason `SelectionPass`
   * names them: writing the same resource creates no ordering edge, and
   * `EffectPass` REPLACES the surface rather than blending onto it.
   *
   * Ordering after `selection` alone was not enough. Chained through
   * selection's own (dangling) `after: ['text']`, the grid was emitted before
   * `composition` and before `effect`, so **every composition grid line and
   * user guide was wiped the moment any layer in the scene carried an effect**
   * — the frame routes through SCENE_COLOR_TARGET, and the final blit
   * overwrote chrome that had already been drawn. Removing the effect brought
   * the grid back, which is what made it look like an effects bug rather than
   * an ordering one.
   */
  override readonly after = ['selection', 'composition', 'effect'];

  gridColor = Color.of(1, 1, 1, 0.06);
  guideColor = Color.of(0.23, 0.51, 0.96, 0.8);
  /** Cap on generated grid lines (avoid pathological counts when zoomed out). */
  maxLines = 400;
  /** Minor (subdivision) lines are drawn at this fraction of the grid colour's
   *  alpha, so the major lines still read as the structure. */
  minorAlpha = 0.45;

  execute(ctx: RenderPassContext): void {
    const { viewport, services } = ctx;
    const o = viewport.overlays;
    if (!o.grid && !o.proportionalGrid && o.guides.length === 0) return;

    const cmds = services.commands;
    const view = viewport.visibleWorldRect;
    const t = 1 / viewport.camera.zoom; // 1px lines
    const major = o.gridColor ?? this.gridColor;
    const minor = Color.of(major.r, major.g, major.b, major.a * this.minorAlpha);

    if (o.grid && o.gridSpacing > 0) {
      const subs = Math.max(1, Math.round(o.gridSubdivisions ?? 1));
      // Subdivisions FIRST so major lines paint over them at intersections.
      if (subs > 1) {
        const step = o.gridSpacing / subs;
        for (const line of gridLines(view, step, t, this.maxLines, o.gridStyle, o.gridSpacing)) {
          emitSolid(cmds, mvpFor(viewport, modelFromRect(line)), minor, 1, 'normal');
        }
      }
      for (const line of gridLines(view, o.gridSpacing, t, this.maxLines, o.gridStyle)) {
        emitSolid(cmds, mvpFor(viewport, modelFromRect(line)), major, 1, 'normal');
      }
    }

    // The proportional grid divides the COMP, not the infinite canvas, so it is
    // clipped to the comp rect and its spacing changes with the comp size.
    if (o.proportionalGrid && o.compRect) {
      for (const line of proportionalLines(o.compRect, o.proportionalColumns, o.proportionalRows, t)) {
        emitSolid(cmds, mvpFor(viewport, modelFromRect(line)), major, 1, 'normal');
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

/**
 * Grid lines across the visible world rect.
 *
 * `style` shapes what is emitted rather than how it is coloured, because the
 * quad emitter has no line-stipple: `dashed` becomes a run of short quads and
 * `dots` becomes small squares at the intersections only. `skipMultiplesOf`
 * omits lines that a later, stronger pass will draw anyway — that is how the
 * subdivision pass avoids double-painting every major gridline.
 */
export function gridLines(
  view: Rect,
  spacing: number,
  t: number,
  /** Line cap. Defaulted because every loop below is bounded by it — omitting
   *  it would compare against `undefined` and silently emit NOTHING. */
  max = 400,
  style: 'lines' | 'dashed' | 'dots' = 'lines',
  skipMultiplesOf?: number,
): Rect[] {
  const lines: Rect[] = [];
  const startX = Math.floor(view.x / spacing) * spacing;
  const startY = Math.floor(view.y / spacing) * spacing;
  // Lines land on exact multiples of `spacing`, so an epsilon this small only
  // absorbs float drift, never a genuinely distinct line.
  const onMajor = (v: number): boolean => {
    if (!skipMultiplesOf) return false;
    const m = Math.abs(v / skipMultiplesOf);
    return Math.abs(m - Math.round(m)) < 1e-6;
  };

  if (style === 'dots') {
    // Intersections only — a small square at each crossing.
    const s = t * 2;
    for (let x = startX; x <= view.x + view.width && lines.length < max; x += spacing) {
      for (let y = startY; y <= view.y + view.height && lines.length < max; y += spacing) {
        if (onMajor(x) && onMajor(y)) continue;
        lines.push({ x: x - s / 2, y: y - s / 2, width: s, height: s });
      }
    }
    return lines;
  }

  const dash = style === 'dashed' ? spacing / 8 : 0;
  for (let x = startX; x <= view.x + view.width && lines.length < max; x += spacing) {
    if (onMajor(x)) continue;
    if (dash > 0) {
      for (let y = Math.floor(view.y / (dash * 2)) * (dash * 2); y <= view.y + view.height && lines.length < max; y += dash * 2) {
        lines.push({ x, y, width: t, height: dash });
      }
    } else {
      lines.push({ x, y: view.y, width: t, height: view.height });
    }
  }
  for (let y = startY; y <= view.y + view.height && lines.length < max; y += spacing) {
    if (onMajor(y)) continue;
    if (dash > 0) {
      for (let x = Math.floor(view.x / (dash * 2)) * (dash * 2); x <= view.x + view.width && lines.length < max; x += dash * 2) {
        lines.push({ x, y, width: dash, height: t });
      }
    } else {
      lines.push({ x: view.x, y, width: view.width, height: t });
    }
  }
  return lines;
}

/**
 * The proportional grid: `columns` × `rows` cells filling the comp rect.
 *
 * Only the INTERIOR divisions are drawn — the outermost lines would sit exactly
 * on the comp edge, where the frame boundary already is. A 3 × 3 setup
 * therefore draws the familiar rule-of-thirds cross, not a box around the comp.
 */
export function proportionalLines(comp: Rect, columns: number, rows: number, t: number): Rect[] {
  const lines: Rect[] = [];
  const cols = Math.max(1, Math.round(columns));
  const rws = Math.max(1, Math.round(rows));
  for (let i = 1; i < cols; i++) {
    lines.push({ x: comp.x + (comp.width * i) / cols, y: comp.y, width: t, height: comp.height });
  }
  for (let i = 1; i < rws; i++) {
    lines.push({ x: comp.x, y: comp.y + (comp.height * i) / rws, width: comp.width, height: t });
  }
  return lines;
}
