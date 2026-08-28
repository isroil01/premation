/**
 * A corner radius means COMPOSITION PIXELS, whatever the layer's scale.
 *
 * ## The bug
 *
 * The viewport's resize handles write Scale, not Size (AE's model), and the
 * corner was traced in the layer's own space and then stretched with the
 * raster. So the one control labelled "Corners … 50 px" drew a 100px corner on
 * a 2x layer, and on a non-uniform scale drew something that was not a corner
 * radius at all — an ellipse. Reported as "radius not dynamic … change the size
 * of the rectangle from the viewport and the corner looks weird".
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * Two crossings, so two mediums:
 *
 *   • `buildSnapshot` has to TELL the shape path what to undo — sampled off the
 *     snapshot (`cornerRadiusScale`).
 *   • the shape path has to undo it — sampled off a RECORDING context, i.e. the
 *     arc the trace actually emits, whose half-axes are the corner's real
 *     radii in the layer's own space. Multiplying those back by the scale gives
 *     what lands on screen, which is the number the panel promises.
 */

import { buildSnapshot } from './buildSnapshot';
import { shapePath, roundRect } from './raster/vectorDraw';
import { needsShapeRaster } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import type { RenderLayer } from './RenderBackend';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const COMP = { width: 800, height: 600, background: '#101014' };
const R = 50;

function rect(scaleX: number, scaleY: number): SceneNode {
  return {
    id: 'r', name: 'r', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: scaleX, y: scaleY } },
    components: [
      {
        id: 'r_t', type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 300, height: 200, scaleX, scaleY, shapeType: 'rect' },
      },
      { id: 'r_s', type: 'Style', props: { opacity: 100, fill: '#2b7eff', cornerRadius: R } },
    ],
  } as unknown as SceneNode;
}

function layerFor(scaleX: number, scaleY: number): RenderLayer {
  const graph = new SceneGraph();
  graph.addNode(rect(scaleX, scaleY));
  return buildSnapshot(
    graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP,
  ).layers.find((l) => l.id === 'r')!;
}

/** Records the arcs a trace emits; `arcTo` is a circle, `ellipse` may not be. */
function recordingCtx(): CanvasRenderingContext2D & { arcs: Array<{ rx: number; ry: number }> } {
  const arcs: Array<{ rx: number; ry: number }> = [];
  const api = {
    arcs,
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, rect() {},
    arcTo(_x1: number, _y1: number, _x2: number, _y2: number, r: number) { arcs.push({ rx: r, ry: r }); },
    ellipse(_cx: number, _cy: number, rx: number, ry: number) { arcs.push({ rx, ry }); },
  };
  return api as unknown as CanvasRenderingContext2D & { arcs: Array<{ rx: number; ry: number }> };
}

/** The corner's half-axes AS DRAWN in comp px: local radius x the layer scale. */
function drawnRadii(layer: RenderLayer): Array<{ rx: number; ry: number }> {
  const ctx = recordingCtx();
  shapePath(ctx, layer);
  const [sx, sy] = layer.cornerRadiusScale ?? [1, 1];
  return ctx.arcs.map((a) => ({ rx: a.rx * sx, ry: a.ry * sy }));
}

describe('cornerRadiusScale rides the snapshot', () => {
  it('POSITIVE CONTROL: an unscaled layer carries the radius and no correction', () => {
    const layer = layerFor(1, 1);
    expect(layer.cornerRadius).toBe(R);
    // Omitted at identity, so an unscaled layer's snapshot is untouched.
    expect(layer.cornerRadiusScale).toBeUndefined();
  });

  it('reports the effective scale so the shape path can undo it', () => {
    expect(layerFor(2, 3).cornerRadiusScale).toEqual([2, 3]);
  });

  it('reports the MAGNITUDE — a mirrored layer still has round corners', () => {
    expect(layerFor(-2, 1).cornerRadiusScale).toEqual([2, 1]);
  });

  it('stays off a square-cornered layer, which has nothing to correct', () => {
    const graph = new SceneGraph();
    const node = rect(2, 3);
    (node.components[1] as { props: Record<string, unknown> }).props.cornerRadius = 0;
    graph.addNode(node);
    const layer = buildSnapshot(
      graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP,
    ).layers.find((l) => l.id === 'r')!;
    expect(layer.cornerRadiusScale).toBeUndefined();
  });
});

describe('the corner lands at the authored radius, in comp pixels', () => {
  it('POSITIVE CONTROL: unscaled, it is simply the radius', () => {
    for (const a of drawnRadii(layerFor(1, 1))) {
      expect(a.rx).toBeCloseTo(R, 6);
      expect(a.ry).toBeCloseTo(R, 6);
    }
  });

  it('a uniformly scaled layer draws the SAME comp-space radius', () => {
    // Before: 2x scale drew a 100px corner while the panel still said 50.
    const arcs = drawnRadii(layerFor(2, 2));
    expect(arcs.length).toBe(4);
    for (const a of arcs) expect(a.rx).toBeCloseTo(R, 6);
  });

  it('a NON-uniformly scaled layer draws a CIRCLE, not an ellipse', () => {
    // Before: rx 50 x 3 = 150 against ry 50 — the reported "weird" corner.
    const arcs = drawnRadii(layerFor(3, 1));
    expect(arcs.length).toBe(4);
    for (const a of arcs) {
      expect(a.rx).toBeCloseTo(R, 6);
      expect(a.ry).toBeCloseTo(R, 6);
    }
  });

  it('keeps emitting circular arcTo when the two axes agree', () => {
    // Not cosmetic: `arcTo` is the path every unscaled layer has always taken,
    // and a corner that is a circle should not start describing itself as an
    // ellipse just because the layer is bigger.
    const ctx = recordingCtx();
    shapePath(ctx, layerFor(2, 2));
    for (const a of ctx.arcs) expect(a.rx).toBeCloseTo(a.ry, 9);
  });
});

describe('the radius still cannot overflow the box it rounds', () => {
  it('clamps per axis, in the layer’s own units', () => {
    // A 100x40 local box asked for a 50px comp radius at scale [1, 4]: the
    // vertical half-axis wants 12.5 local, the horizontal 50 — and 50+50 does
    // not fit 100 with anything left over, so both shrink together.
    const ctx = recordingCtx();
    roundRect(ctx, -50, -20, 100, 40, 50, [1, 4]);
    for (const a of ctx.arcs) {
      expect(a.rx).toBeLessThanOrEqual(50.0001);
      expect(a.ry).toBeLessThanOrEqual(20.0001);
      // ...and the two stay in the ratio the compensation asked for.
      expect(a.rx / a.ry).toBeCloseTo(4, 6);
    }
  });
});

describe('the GPU path agrees with the Canvas2D one', () => {
  it('rasterizes an anisotropically scaled rounded rect — the SDF cannot say it', () => {
    // One isotropic radius cannot describe an elliptical corner, so the layer
    // has to take the Canvas2D route or the two backends would disagree.
    expect(needsShapeRaster(layerFor(3, 1))).toBe(true);
  });

  it('keeps the fast SDF path for a uniformly scaled one', () => {
    expect(needsShapeRaster(layerFor(2, 2))).toBe(false);
  });
});
