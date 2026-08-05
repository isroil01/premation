/**
 * Stroke family: join styles, dashed + caps, and multi-stroke stacking.
 *
 * All use the fixed 220px shape centred in a 360×280 comp so corners (joins)
 * and dash gaps (caps) are fully on-canvas. Flagged known-divergent — stroke
 * geometry is one of the areas the two engines are expected to differ on until
 * unification; the suite tracks the gap.
 */

import { defineScene, shapeNode, node, type Scene } from '../sceneKit';

const COMP = { width: 360, height: 280, background: '#101014' };
const SIZE = { w: 360, h: 280 };

interface StrokeOpts {
  color: string;
  width: number;
  opacity?: number;
  align?: 'center' | 'inside' | 'outside';
  dash?: number[];
  dashOffset?: number;
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

function strokeScene(
  id: string,
  description: string,
  strokes: StrokeOpts[],
  /** Extra Transform props — e.g. `{ shapeType: 'ellipse' }` for a curved path. */
  transform?: Record<string, unknown>,
): Scene {
  return defineScene({
    id,
    description,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    build(graph) {
      graph.addNode(
        transform
          ? node('s', {
              kind: 'shape',
              position: { x: 180, y: 140 },
              transform,
              style: { fill: '#1f4f8f' },
            })
          : shapeNode('s', { x: 180, y: 140, rotation: 0, fill: '#1f4f8f' }),
      );
      const payload = strokes.map((s) => ({
        enabled: true,
        opacity: 1,
        align: 'center',
        dash: [],
        cap: 'butt',
        join: 'miter',
        ...s,
      }));
      if (payload.length === 1) graph.setStroke('s', payload[0]);
      else graph.setStrokes('s', payload);
    },
  });
}

export const strokeScenes: Scene[] = [
  strokeScene('stroke-join-miter', 'Thick miter-join stroke on a rect.', [
    { color: '#ffcf33', width: 20, join: 'miter' },
  ]),
  strokeScene('stroke-join-round', 'Thick round-join stroke on a rect.', [
    { color: '#ffcf33', width: 20, join: 'round' },
  ]),
  strokeScene('stroke-join-bevel', 'Thick bevel-join stroke on a rect.', [
    { color: '#ffcf33', width: 20, join: 'bevel' },
  ]),
  strokeScene('stroke-dashed-round-cap', 'Dashed stroke with round caps.', [
    { color: '#33e0a0', width: 14, dash: [30, 22], cap: 'round' },
  ]),
  strokeScene('stroke-dashed-square-cap', 'Dashed stroke with square caps.', [
    { color: '#33e0a0', width: 14, dash: [30, 22], cap: 'square' },
  ]),
  strokeScene('stroke-multi', 'Two stacked strokes (wide dark under thin bright).', [
    { color: '#20304a', width: 28, join: 'round' },
    { color: '#ff6b9d', width: 8, join: 'round' },
  ]),

  /**
   * Dash OFFSET on a curve — the pixels behind the drawing-on / marching-border
   * feature.
   *
   * Two deliberate choices, both about what a lazier fixture could not see:
   *
   *  • **An ellipse, not the rect the rest of this family uses.** Offset is an
   *    ARC-LENGTH parameter. On straight edges any monotonic parameterisation
   *    looks plausible, so a rect would still pass if the offset were applied in
   *    the wrong units or per-segment rather than along the path. Curvature is
   *    what separates arc length from everything that resembles it.
   *
   *  • **Offset 9 against a [24, 12] pattern — a QUARTER of the 36px period, not
   *    zero and not a whole period.** Dashes are periodic: offset 0 and offset
   *    36 draw the same picture, pixel for pixel. A golden blessed at either
   *    would be satisfied by a build that ignored the offset entirely, and by
   *    one that applied it modulo the wrong period. A quarter period is the
   *    furthest a phase can be from agreeing with itself (rule 3a).
   */
  strokeScene(
    'stroke-dash-offset-curve',
    'Dashed ellipse phase-shifted a quarter period — dash offset along a curve.',
    [{ color: '#33e0a0', width: 14, dash: [24, 12], dashOffset: 9, cap: 'butt' }],
    { shapeType: 'ellipse' },
  ),
];
