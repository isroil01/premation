/**
 * Continuous Rasterization — re-render vector content at the scale it is
 * actually being drawn at, instead of magnifying a texture baked at a lower one.
 *
 * ## What was already there, and what was not
 *
 * The effective on-screen scale ALREADY reaches the rasterizer. Measured in
 * `rasterScale.probe.test.ts`: a layer scaled 800% arrives as 8, a layer
 * parented to an 800% null arrives as 8, and a 3D layer pushed toward the camera
 * arrives magnified by the perspective divide (1 → 1.43 at z −800), because
 * `buildSnapshot` decomposes the PROJECTED matrix for 3D layers. None of that
 * needed building.
 *
 * Nor is the raster CAPPED, which is what I assumed next and what the brief
 * describes. Measured in `rasterResolution.probe.test.ts`: the rasterizer draws
 * at the RAW requested scale, uncapped — scale 16 on a 100px box produces a
 * 3200px texture. `RESOLUTION_TIERS` stopping at 4 does not clamp the pixels.
 *
 * ## The two defects that are actually there
 *
 * `Canvas2DVectorRasterizer` draws at the raw scale but keys its cache on
 * `resolutionTier(scale)`, and those disagree above 4×:
 *
 *  1. **The cache key collides.** Same probe: scale 6 produced a 1200px texture,
 *     then scale 12 came back a CACHE HIT and reused it. Above 4× every scale
 *     shares one key, so whichever rasterized first wins and zooming further in
 *     never re-rasterizes. This is the user-visible bug — a logo goes soft as a
 *     camera dollies in, and stays soft.
 *  2. **Nothing is bounded.** A 2048px box at 32× asks for a 65536px texture.
 *     That is past every GPU limit, so it fails to allocate rather than
 *     degrading.
 *
 * CR ON fixes both: the drawn size and the cache key are both quantized to the
 * extended power-of-two ladder (so they agree, and a zoom re-rasters when it
 * crosses a tier), and the tier is bounded by the GPU's real max dimension and a
 * pixel budget.
 *
 * ## The switch is no longer what rescues a scaled-up layer
 *
 * Leaving that fix behind an off-by-default switch meant the DEFAULT experience
 * was the broken one: a title scaled past 400% went soft, in the export as much
 * as in the preview, and only a user who knew this switch existed ever got a
 * sharp one. `AppTextureProvider.tierFor` now escalates onto the extended
 * ladder past the 4x ceiling whether or not the layer opted in — safe to do
 * unconditionally precisely because that ladder is bounded by the GPU's real
 * max dimension and the pixel budget, so it cannot request an allocation that
 * fails or quietly exhaust VRAM.
 *
 * What the switch still means is therefore narrower than it was: it opts a
 * layer into the extended, box-bounded ladder from the SMALLEST scale up,
 * rather than only past the ceiling. Below 4x that is rarely a visible
 * difference, and for a box over ~2048px the bounds can round it DOWN. It is
 * kept for AE parity and explicit control, not because a scaled-up layer needs
 * it any more.
 *
 * ## Why it is a switch, and why there is no draft cap
 *
 * OFF keeps the existing expressions verbatim — raw draw, clamped key — so every
 * existing project is byte-identical, defects included. Those defects are filed
 * rather than fixed globally because every consistent fix changes rendered
 * output (quantizing up makes rasters bigger, down makes them softer) and
 * today's above-4× behaviour is ORDER-DEPENDENT, so there is no byte-identical
 * target to preserve.
 *
 * A draft/preview-resolution cap was built and then removed. Because OFF already
 * draws at the raw scale, capping CR's tier BELOW the requested scale made CR ON
 * softer than CR OFF — measured, not reasoned: at scale 16 a capped CR produced
 * 800px against OFF's 3200px. CR is a correctness and cacheability feature, not
 * a "spend more pixels" feature, so it has no quality lever of its own.
 *
 * ## Divergence from AE, stated
 *
 * AE puts CR and Collapse Transformations in the SAME sunburst column: on a
 * precomp the switch means Collapse, on a vector layer it means CR. We keep that
 * pairing semantically — one concept per layer type, same control position — but
 * the two are separate props (`collapseTransforms`, `continuousRasterize`)
 * because a placed composition can meaningfully want Collapse while the vector
 * layers inside it individually want CR. A single shared prop would make those
 * two statements impossible to express at once.
 *
 * A collapsed precomp needs no special handling here: collapsing clones the
 * source comp's layers into the host, and each clone carries the original
 * layer's own `continuousRasterize` prop, so vector content inside a collapsed
 * precomp is continuously rasterized exactly when that layer says so. Pinned by
 * test rather than assumed.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';

/** Per-layer switch. Absent = off, which is every existing project. */
export const CONTINUOUS_RASTER_PROP = 'continuousRasterize';

/**
 * Layer kinds whose content is VECTOR and therefore re-rasterizable.
 *
 * Deliberately excludes image and video: re-rendering a bitmap at a higher
 * scale cannot invent detail it never had, so a CR switch there would be a
 * control that costs memory and changes nothing — the pattern this codebase has
 * deleted five times. Excludes solids too: a flat fill has no edge to sharpen.
 */
export function supportsContinuousRaster(node: SceneNode | undefined): boolean {
  if (!node) return false;
  const kind = readNodeKind(node);
  if (kind === 'text' || kind === 'svg') return true;
  // A shape only benefits when it actually has vector geometry. A plain solid
  // rect is a fill; there is nothing to re-rasterize sharper.
  if (kind === 'shape') return !isFlatSolid(node);
  return false;
}

/** A shape with no path, no stroke and no corner radius — a flat rectangle of
 *  colour, whose edges are the quad's own and already crisp at any scale. */
function isFlatSolid(node: SceneNode): boolean {
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (Array.isArray(p.pathPoints) && p.pathPoints.length > 0) return false;
    if (p.stroke || p.strokeWidth) return false;
    if (typeof p.cornerRadius === 'number' && p.cornerRadius > 0) return false;
    if (p.shapeType && p.shapeType !== 'rect') return false;
  }
  return true;
}

/** Is Continuous Rasterization on for this layer? */
export function readContinuousRaster(node: SceneNode): boolean {
  for (const c of node.components) {
    if ((c.props as Record<string, unknown>)[CONTINUOUS_RASTER_PROP] === true) return true;
  }
  return false;
}

/**
 * Turn Continuous Rasterization on or off.
 *
 * Written through `setFxKey` with `undefined` for off, exactly like
 * `setCompCollapse`, so an off layer carries NO prop and a document saved before
 * this feature existed is indistinguishable from one that deliberately turned it
 * off. That is what makes the byte-identical guarantee hold across save/load.
 */
export function setContinuousRaster(nodeId: string, on: boolean): void {
  defaultSceneGraph.setFxKey(nodeId, CONTINUOUS_RASTER_PROP, on || undefined);
}

/**
 * Turn Continuous Rasterization on for a NEW vector layer.
 *
 * Soft zoom under camera moves is the #1 tell of "not AE-finished" logo/type
 * work; requiring users to find the switch meant most comps stayed soft.
 *
 * This lives here, next to `supportsContinuousRaster`, rather than privately in
 * `sceneInsert` — where it was, and where the four call sites that used it are
 * every MENU and LIBRARY insert and nothing else. Layers the user DRAWS are
 * built by `makeNodeAt` in `core/workspace/ports`, which never had access to
 * it, so a pen path, a pencil scribble or a drawn ellipse silently opted out of
 * a default the codebase describes as on. Two layers with identical geometry
 * rasterized differently depending on which menu made them, and the drawn one
 * was the soft one — `AppTextureProvider.tierFor` calls exactly that softness
 * "the single most-reported quality complaint".
 *
 * Idempotent, and a no-op for kinds that cannot benefit (see
 * `supportsContinuousRaster`) — so it is safe on every creation path.
 */
export function enableContinuousRasterByDefault(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (node && supportsContinuousRaster(node)) setContinuousRaster(nodeId, true);
}

/** Read the switch for a node id, false when the node is gone. */
export function nodeHasContinuousRaster(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readContinuousRaster(node) : false;
}

