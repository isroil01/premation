/**
 * The z-order of a shape's paint operations — AE's Composite, resolved.
 *
 * Pure over the paint model (a fill stack and a stroke stack), so it lives with
 * it: the Lottie export writes a group's paints in this order, and the engine's
 * shape raster resolves the same rule (`paint_render_order`,
 * native/engine/src/raster/vector_paint.cpp).
 */

import type { FillPaint } from './fill';
import type { PaintOpOptions } from './paintBlend';
import type { Stroke } from './stroke';

/** One paint operation of a shape. */
export type PaintOp =
  | { kind: 'fill'; fill: FillPaint | undefined }
  | { kind: 'stroke'; stroke: Stroke };

/** The composite/blend fields of a paint, which a fill carries structurally. */
export function paintOpOptions(op: PaintOp): PaintOpOptions {
  return (op.kind === 'fill' ? op.fill : op.stroke) as PaintOpOptions | undefined ?? {};
}

/**
 * The paints BACK → FRONT, resolving AE's Composite.
 *
 * AE's Contents list, top to bottom, is our stacks read front-first: the top
 * stroke, …, the first stroke, the top fill, …, the first fill. Walking that
 * list, each paint is inserted directly BEHIND the previous one ('below', the
 * default) or directly IN FRONT of it ('above'). With every paint 'below' the
 * result is fills[0…n], strokes[0…n] — the order a shape has always drawn in,
 * which is why the default needs no migration.
 *
 * "Directly" is relative to where the previous paint ENDED UP, not to the list:
 * a fill set Above over a stroke that was itself set Above lands in front of
 * both, which is how AE resolves a chain.
 */
export function paintRenderOrder(
  fills: ReadonlyArray<FillPaint | undefined>,
  strokes: ReadonlyArray<Stroke>,
): PaintOp[] {
  const list: PaintOp[] = [
    ...[...strokes].reverse().map((stroke): PaintOp => ({ kind: 'stroke', stroke })),
    ...[...fills].reverse().map((fill): PaintOp => ({ kind: 'fill', fill })),
  ];
  const z: PaintOp[] = [];
  list.forEach((op, j) => {
    if (j === 0) { z.push(op); return; }
    const at = z.indexOf(list[j - 1]!);
    z.splice(paintOpOptions(op).composite === 'above' ? at + 1 : at, 0, op);
  });
  return z;
}
