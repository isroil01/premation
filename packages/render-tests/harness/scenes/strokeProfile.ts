/**
 * Stroke Taper and Wave — the pixel gate for AE's Stroke profile group.
 *
 * ## Why these are their own family and not rows in `strokes.ts`
 *
 * Every scene in `strokes.ts` renders through `ctx.stroke()`. These do not:
 * Canvas2D cannot vary `lineWidth`, so a profiled stroke FILLS a variable-width
 * ribbon instead. Different drawing operation, different failure modes, and
 * `strokes.ts` is flagged known-divergent for stroke geometry which would have
 * quietly excused these too.
 *
 * ## expect-pass, deliberately, and it is a claim worth making
 *
 * Sibling stroke scenes are `known-divergent`. These are not, because the
 * ribbon is computed on the CPU and rasterized into a TEXTURE — both GPU
 * backends then composite the same pixels. If that reasoning is wrong the gate
 * says so, which is more useful than pre-excusing a divergence nobody has seen.
 *
 * ## The fixture rules these scenes exist under
 *
 *   • an OPEN CURVE, never a straight line — a straight path has one normal
 *     everywhere, so a ribbon built with a constant normal looks correct on it;
 *   • ASYMMETRIC start and end — different widths AND different ramp lengths, so
 *     a taper applied to the wrong end is visible rather than a mirror image;
 *   • a wavelength that fits more than one period on the path, so a phase error
 *     moves something rather than shifting a single hump off-canvas;
 *   • a wave INSIDE THE OFFSET LIMIT. Offsetting a curve along its normals
 *     self-intersects wherever the local radius of curvature is smaller than the
 *     offset distance — here, half the stroke width. The first draft used
 *     amplitude 14 over a 70px wavelength against an 18px stroke, whose crests
 *     curve tighter than the 9px half-width, and the golden came out a folded
 *     polygon. That is a real property of naive offsetting, not a bug in the
 *     sampling: it was chased through two sampling fixes before the geometry was
 *     measured. Trimming self-intersections is the proper cure and is not built.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 360, height: 260, background: '#101014' };
const SIZE = { w: 360, h: 260 };
const CENTER = { x: 180, y: 130 };

/**
 * An open S-curve. Curvature reverses across it, so a normal computed from the
 * wrong neighbours produces a visibly wrong ribbon on one half.
 */
const CURVE = [
  { x: -130, y: 50, inX: -130, inY: 50, outX: -80, outY: -70 },
  { x: 0, y: 0, inX: -60, inY: -60, outX: 60, outY: 60 },
  { x: 130, y: -50, inX: 80, inY: 70, outX: 130, outY: -50 },
];

function profileScene(
  id: string,
  description: string,
  stroke: Record<string, unknown>,
): Scene {
  return defineScene({
    id,
    description,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: 'expect-pass',
    build(graph) {
      graph.addNode(
        node('s', {
          kind: 'shape',
          position: CENTER,
          // No fill: the ribbon IS the subject, and a fill behind it would hide
          // a taper that collapsed to zero width.
          style: { fill: 'transparent' },
          components: [
            { id: 'p_g', type: 'Geometry', props: { points: CURVE, open: true } },
          ],
        }),
      );
      graph.setStroke('s', {
        enabled: true, color: '#66e0ff', width: 18, opacity: 1,
        align: 'center', dash: [], cap: 'butt', join: 'miter',
        ...stroke,
      });
    },
  });
}

export const strokeProfileScenes: Scene[] = [
  profileScene(
    'stroke-taper-start',
    'Open S-curve, tapered at the START only: 15% width over the first 60%.',
    { taper: { startWidth: 0.15, endWidth: 1, startLength: 0.6, endLength: 0, startEase: 0, endEase: 0 } },
  ),
  profileScene(
    'stroke-taper-end',
    'The same curve tapered at the END only — the mirror of the scene above, so a swapped end differs from BOTH.',
    { taper: { startWidth: 1, endWidth: 0.15, startLength: 0, endLength: 0.6, startEase: 0, endEase: 0 } },
  ),
  profileScene(
    'stroke-taper-asymmetric',
    'Both ends tapered to DIFFERENT widths over DIFFERENT lengths, with different eases.',
    { taper: { startWidth: 0.1, endWidth: 0.55, startLength: 0.45, endLength: 0.3, startEase: 1, endEase: 0 } },
  ),
  profileScene(
    'stroke-wave',
    'Wave only: amplitude 8 over a 190px wavelength — inside the offset limit (see below).',
    { wave: { amount: 8, wavelength: 190, phase: 0 } },
  ),
  profileScene(
    'stroke-wave-phase',
    'The same wave advanced 90 degrees — differs from stroke-wave iff phase reaches the renderer.',
    { wave: { amount: 8, wavelength: 190, phase: 90 } },
  ),
  profileScene(
    'stroke-taper-dashed',
    'Taper AND dash together: each dash reads its width from where it sits on the whole path.',
    {
      dash: [26, 14],
      taper: { startWidth: 0.1, endWidth: 1, startLength: 0.7, endLength: 0, startEase: 0, endEase: 0 },
    },
  ),
  profileScene(
    'stroke-taper-wave',
    'Taper and Wave composed: the ribbon narrows toward the start while its centreline waves.',
    {
      taper: { startWidth: 0.15, endWidth: 1, startLength: 0.6, endLength: 0, startEase: 0, endEase: 0 },
      wave: { amount: 8, wavelength: 190, phase: 0 },
    },
  ),
];
