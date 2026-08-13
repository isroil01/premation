/**
 * The ONE reader of a layer's path geometry.
 *
 * `RenderLayer` carries path geometry in two shapes: `pathPoints` (one run, the
 * common case, what every existing writer produces) and `subpaths` (a list, what
 * a cut path produces). Two fields describing the same thing is precisely the
 * shape that goes wrong quietly — one consumer reads `pathPoints`, another reads
 * `subpaths`, nothing forces them to agree, and a shape draws its fill from one
 * and its stroke from the other.
 *
 * So nothing reads either field directly. Every consumer — the rasterizer's fill
 * and stroke, the raster-padding bbox, the content hash, the texture cache key —
 * goes through {@link layerSubpaths}, which normalizes both shapes to a list.
 * There is one place that knows the precedence rule, and it is this file.
 *
 * The mutual exclusion is an invariant, not a preference: writers set one field
 * or the other. {@link assertSinglePathSource} is the guard, and the accessor
 * still resolves deterministically (`subpaths` wins) if it is ever violated in
 * production, so a bug here degrades to "the newer field renders" rather than to
 * a shape that draws twice.
 */

import type { RenderLayer, Subpath } from '../RenderBackend';

/**
 * A layer's path geometry as a list of runs — `subpaths` if present, otherwise
 * the `pathPoints` shorthand wrapped in a single run, otherwise empty.
 *
 * Empty means "this layer has no path geometry", NOT "draw nothing": a rect or
 * an ellipse primitive has no `pathPoints` at all and is drawn from w/h. Callers
 * that handle primitives must keep doing so.
 */
export function layerSubpaths(layer: {
  pathPoints?: RenderLayer['pathPoints'];
  subpaths?: RenderLayer['subpaths'];
  pathOpen?: boolean;
}): ReadonlyArray<Subpath> {
  const subs = layer.subpaths;
  if (subs && subs.length > 0) return subs;
  const pts = layer.pathPoints;
  if (pts && pts.length > 0) return [{ points: pts, open: layer.pathOpen === true }];
  return [];
}

/** True when the layer has drawable path geometry in either shape. */
export function hasPathGeometry(layer: Parameters<typeof layerSubpaths>[0]): boolean {
  return layerSubpaths(layer).length > 0;
}

/**
 * The invariant: a layer carries its path in ONE of the two fields.
 *
 * Called from the guard tests rather than from the render loop — this is a
 * writer-side contract, and every writer is in `buildSnapshot`, so a unit test
 * over the snapshot covers it without costing a check per layer per frame.
 */
export function assertSinglePathSource(layer: Parameters<typeof layerSubpaths>[0]): void {
  if (layer.subpaths && layer.subpaths.length > 0 && layer.pathPoints && layer.pathPoints.length > 0) {
    throw new Error(
      'RenderLayer carries both `pathPoints` and `subpaths`. They are mutually exclusive — '
      + 'a writer that produces subpaths must clear pathPoints.',
    );
  }
}
