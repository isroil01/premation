/**
 * A path keeps its CURVATURE through the operator chain.
 *
 * The chain's currency is a polyline and what it emits is corner points, so
 * whatever is fed in is the whole of what comes out. Seeding it with the
 * anchors alone therefore did not approximate a drawn curve, it replaced the
 * curve with the polygon through its anchors — and every operator inherited
 * that, trim most visibly: the moment a Trim Paths was added to a pen path the
 * smooth outline turned into straight chords, which is exactly what the shape
 * looked like before the fix.
 *
 * Both halves matter and both are checked: the geometry that ENTERS the chain
 * has to be the curve (deviation from the chord), and the geometry that LEAVES
 * it has to still be on the curve (deviation from the true cubic).
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { defaultTrimOp, type PathOp } from '@core/scene/pathOps';
import type { BezierPoint } from '../../../packages/workspace/src/math/BezierPoint';

const COMP = { width: 800, height: 600, background: '#101014' };

/**
 * One cubic bowing 100px below the chord: anchors on y = 0, both handles pulled
 * to y = −133⅓, which puts the curve's midpoint at exactly y = −100.
 */
const ARC: BezierPoint[] = [
  { x: -100, y: 0, inX: -100, inY: 0, outX: -100, outY: -400 / 3 },
  { x: 100, y: 0, inX: 100, inY: -400 / 3, outX: 100, outY: 0 },
];

function cubicAt(t: number): { x: number; y: number } {
  const [a, b] = [ARC[0]!, ARC[1]!];
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return {
    x: w[0]! * a.x + w[1]! * a.outX + w[2]! * b.inX + w[3]! * b.x,
    y: w[0]! * a.y + w[1]! * a.outY + w[2]! * b.inY + w[3]! * b.y,
  };
}

/** Shortest distance from `p` to the cubic, by dense sampling. */
function distanceToArc(p: { x: number; y: number }): number {
  let best = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const c = cubicAt(i / 2000);
    best = Math.min(best, Math.hypot(c.x - p.x, c.y - p.y));
  }
  return best;
}

function curvedPathNode(): SceneNode {
  return {
    id: 'pen', name: 'pen', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'pen_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 200, height: 200 } },
      { id: 'pen_g', type: 'Geometry', props: { points: ARC, open: true } },
      { id: 'pen_s', type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function pointsWithOps(ops: readonly PathOp[]): Array<{ x: number; y: number }> {
  const graph = new SceneGraph();
  graph.addNode(curvedPathNode());
  if (ops.length > 0) graph.setPathOps('pen', [...ops]);
  const layer = buildSnapshot(
    graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP,
  ).layers.find((l) => l.id === 'pen')!;
  return [...(layer.subpaths?.[0]?.points ?? layer.pathPoints ?? [])];
}

const trim = (over: Partial<PathOp> = {}): PathOp => ({ ...defaultTrimOp(), ...over, type: 'trim' });

describe('the path-op chain preserves a drawn curve', () => {
  it('POSITIVE CONTROL: with no operator the layer keeps its real bezier', () => {
    // Without an operator nothing flattens at all — the handles reach the
    // rasterizer intact. If this ever stops holding, the deviation numbers
    // below stop being about the chain.
    const pts = pointsWithOps([]) as BezierPoint[];
    expect(pts.length).toBe(2);
    expect(pts[0]!.outY).toBeCloseTo(-400 / 3, 6);
  });

  // A trim spanning the whole path is INERT and is dropped from the chain
  // (`resolvePathOps`), which would take the flattening with it — so every live
  // case here trims something, exactly as the reported one did.
  it('a live trim emits the ARC, not the chord through its anchors', () => {
    const pts = pointsWithOps([trim({ start: 5, end: 95, offset: 0 })]);
    // The chord is y = 0 everywhere; the arc reaches y = −100 at its midpoint.
    const deepest = Math.min(...pts.map((p) => p.y));
    expect(deepest).toBeLessThan(-95);
  });

  it('every emitted vertex sits ON the curve, not merely off the chord', () => {
    // "Not the chord" alone would also pass for a wrong-but-bulging polyline.
    const pts = pointsWithOps([trim({ start: 5, end: 95, offset: 0 })]);
    const worst = Math.max(...pts.map(distanceToArc));
    expect(worst).toBeLessThan(0.5);
  });

  it('a PARTIAL trim cuts the curve and keeps the surviving part curved', () => {
    // The reported case: dragging Start/End made the path "look terrible".
    const pts = pointsWithOps([trim({ start: 25, end: 75, offset: 0 })]);
    expect(pts.length).toBeGreaterThan(8);
    expect(Math.max(...pts.map(distanceToArc))).toBeLessThan(0.5);
    // ...and it really is a cut: the far anchors are gone.
    expect(Math.min(...pts.map((p) => p.x))).toBeGreaterThan(-95);
    expect(Math.max(...pts.map((p) => p.x))).toBeLessThan(95);
  });

  it('samples the curve densely enough that its facets are sub-pixel', () => {
    // The old fixed budget put 8 samples across a segment of any length. The
    // check is on the CHORDS, because a chord is exactly what a facet is.
    const pts = pointsWithOps([trim({ start: 5, end: 95, offset: 0 })]);
    const longest = Math.max(
      ...pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y)),
    );
    expect(longest).toBeLessThan(6);
  });
});
