/**
 * Emit helpers every template uses.
 *
 * Two of these are load-bearing rather than convenience:
 *
 *  • `emitBackdrop` — the ONLY way a template creates a background, and it never
 *    creates a flat one. A gradient with an OKLCH-computed midpoint plus a
 *    surface pass (grain + vignette) is the baseline, because a flat fill is the
 *    design linter's `FLAT_FILL` error and a texture-free frame is
 *    `NO_TEXTURE_LAYER`.
 *  • `emitPanel` — the only way a template creates a card, and it never gives it
 *    a single shadow. Elevation comes from `depth.elevation()`, which is always a
 *    stack.
 *
 * Going through these is what makes "the design linter passes on 100% of output"
 * achievable by construction rather than by iteration.
 */

import { gradientStops } from '../color';
import { elevation, glass, type Elevation } from '../depth';
import { backgroundLight } from '../surface';
import { radius, type RadiusStep } from '../shape';
import { snapBaseline } from '../grid';
import { COMPOSITION_BACKDROP_ID, COMPOSITION_SURFACE_ID, type ComposeContext } from '../compose';
import type { ToolCall } from '../toolcall';

/**
 * Full-frame backdrop: gradient + surface treatment.
 *
 * Returns the ids so a technique can animate the backdrop (a slow drift, a hue
 * shift) and so the caller can keep the treatment layer on top.
 *
 * When the composition already owns a backdrop this emits NOTHING and returns
 * the composition's ids. See `ComposeContext.hasCompositionBackdrop` — a
 * template that emits its own full-frame gradient inside a multi-beat piece
 * paints over every beat composed before it.
 */
export function emitBackdrop(
  ctx: ComposeContext,
  o: { angle?: number; kind?: 'linear' | 'radial' | 'corners'; lift?: number } = {},
): { calls: ToolCall[]; backdropId: string; treatmentId: string } {
  if (ctx.hasCompositionBackdrop) {
    return { calls: [], backdropId: COMPOSITION_BACKDROP_ID, treatmentId: COMPOSITION_SURFACE_ID };
  }
  return buildBackdrop(ctx, `${ctx.idPrefix}_bg`, `${ctx.idPrefix}_surface`, o);
}

/**
 * The composition's single backdrop, emitted once before any beat composes.
 *
 * Same treatment as a template's own backdrop — the difference is only that it
 * is created FIRST, so it sits behind every beat, and that its ids are fixed so
 * a technique can name it.
 */
export function emitCompositionBackdrop(
  ctx: ComposeContext,
  o: { angle?: number; kind?: 'linear' | 'radial' | 'corners'; lift?: number } = {},
): { calls: ToolCall[]; backdropId: string; treatmentId: string } {
  return buildBackdrop(ctx, COMPOSITION_BACKDROP_ID, COMPOSITION_SURFACE_ID, o);
}

function buildBackdrop(
  ctx: ComposeContext,
  backdropId: string,
  treatmentId: string,
  o: { angle?: number; kind?: 'linear' | 'radial' | 'corners'; lift?: number },
): { calls: ToolCall[]; backdropId: string; treatmentId: string } {
  const { palette } = ctx.pack;
  const light = backgroundLight(palette.bg, palette.accent, {
    lift: o.lift,
    angle: o.angle,
    kind: o.kind,
  });
  // Three stops, not two: the middle one is computed in OKLCH so the renderer's
  // sRGB blend only has to cover a short span where its error is invisible.
  const stops = gradientStops(light.stops[0]!, light.stops[1]!, 3);

  const calls: ToolCall[] = [
    { name: 'create_gradient', args: { id: backdropId, name: 'Backdrop', stops, kind: light.kind, angle: light.angle } },
    {
      name: 'add_surface_treatment',
      args: {
        id: treatmentId,
        name: 'Surface',
        grain: ctx.pack.surface.grain,
        grainAnimated: ctx.pack.surface.grainAnimated,
        vignette: ctx.pack.surface.vignette,
        ...(ctx.pack.surface.chromaticAberration > 0
          ? { chromaticAberration: ctx.pack.surface.chromaticAberration }
          : {}),
      },
    },
  ];
  return { calls, backdropId, treatmentId };
}

/**
 * A card / panel with a real elevation stack.
 *
 * `glassy` swaps the opaque fill for a frosted surface — a backdrop blur, a faint
 * forward-scatter fill, and a hairline edge. Glass without the edge reads as a
 * blurry hole rather than a pane, so the border is not optional.
 */
export function emitPanel(
  ctx: ComposeContext,
  id: string,
  box: { x: number; y: number; width: number; height: number },
  o: { level?: Elevation; radiusStep?: RadiusStep; fill?: string; glassy?: boolean } = {},
): ToolCall[] {
  const { palette, shape } = ctx.pack;
  const level = o.level ?? 2;
  const r = radius(o.radiusStep ?? shape.cardRadius, box);
  // Snap the panel's centre to a baseline. A panel whose height is an odd number
  // of pixels puts its own centre — and therefore everything laid out relative to
  // it — half a unit off the grid, which the OFF_GRID rule reports for the panel
  // AND for every child. Snapping here fixes the whole subtree at one stroke.
  const y = snapBaseline(ctx.grid, box.y);
  const calls: ToolCall[] = [
    {
      name: 'create_layer',
      args: { id, kind: 'shape', shape: 'rect', name: id, x: box.x, y, width: box.width, height: box.height },
    },
  ];

  if (o.glassy) {
    const g = glass(palette.bg);
    calls.push({
      name: 'update_layer',
      args: { nodeId: id, fill: g.fill, opacity: g.opacity, backdropBlur: g.backdropBlur, cornerRadius: r },
    });
  } else {
    calls.push({
      name: 'update_layer',
      args: { nodeId: id, fill: o.fill ?? palette.surface, cornerRadius: r },
    });
  }

  const stack = elevation(level, {
    background: palette.bg,
    // One light direction per composition. Varying it per element is the
    // "shadows point four ways" failure that reads as collage.
    angle: 90,
    scale: ctx.height / 1080,
  });
  if (stack.length) {
    calls.push({ name: 'set_shadow_stack', args: { nodeId: id, shadows: stack } });
  }
  return calls;
}

/**
 * A heavy horizontal rule — the Swiss structural device.
 *
 * Deliberately thick. A 1px line is a divider; a rule is a graphic element that
 * carries as much weight as the type it sits under.
 */
export function emitRule(
  ctx: ComposeContext,
  id: string,
  o: { x: number; y: number; width: number; thickness: number; fill?: string },
): ToolCall[] {
  return [
    {
      name: 'create_layer',
      args: { id, kind: 'shape', shape: 'rect', name: 'Rule', x: o.x, y: o.y, width: o.width, height: o.thickness },
    },
    { name: 'update_layer', args: { nodeId: id, fill: o.fill ?? ctx.pack.palette.accent, cornerRadius: 0 } },
  ];
}

/**
 * A media slot.
 *
 * When the caster supplied a real asset id this places it; otherwise it emits a
 * *deliberate* placeholder — a low-contrast panel with the accent at low opacity,
 * which still composes as a design rather than leaving a hole. A hole is worse
 * than a placeholder, because the layout's balance depends on something being
 * there.
 */
export function emitMedia(
  ctx: ComposeContext,
  id: string,
  box: { x: number; y: number; width: number; height: number },
  assetId: string | undefined,
  o: { radiusStep?: RadiusStep } = {},
): ToolCall[] {
  if (assetId) {
    // The `id` handle is what lets the very next call size the layer. Without it
    // `create_media` returns an engine-assigned id nobody in this batch knows.
    return [
      { name: 'create_media', args: { id, assetId, x: box.x, y: box.y } },
      { name: 'update_layer', args: { nodeId: id, width: box.width, height: box.height } },
    ];
  }
  return [
    ...emitPanel(ctx, id, box, { level: 1, radiusStep: o.radiusStep, fill: ctx.pack.palette.surface }),
    { name: 'update_layer', args: { nodeId: id, opacity: 82 } },
  ];
}
