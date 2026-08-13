import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { Repeater } from '@core/scene/repeater';
import type { RenderLayer } from './RenderBackend';
import { assertSinglePathSource } from './raster/subpaths';

const COMP = { width: 800, height: 600, background: '#101014' };

function shape(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 200, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 200, y: 300, rotation: 0 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function snapWithRepeater(rep: Repeater, node: SceneNode = shape('rect')) {
  const graph = new SceneGraph();
  graph.addNode(node);
  graph.setRepeater('rect', rep);
  return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
}

/** Centroid of one emitted run, in the layer's own coordinates. */
function runCentre(layer: RenderLayer, i: number): { x: number; y: number } {
  const pts = layer.subpaths![i]!.points;
  const sum = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / pts.length, y: sum.y / pts.length };
}

/**
 * Where a run's centre lands in COMP space, which is the only thing a user can
 * see and therefore the only fair way to compare the two models.
 *
 * The pre-fold renderer put copy k at `x: px + dx` with the layer's own
 * rotation and scale applied to the SHAPE but not to the ladder. The folded one
 * bakes the ladder into geometry and lets the layer transform carry it. On an
 * untransformed layer those are the same number; that equality is what the
 * migration claims, and this is what checks it.
 */
function runWorldCentre(layer: RenderLayer, i: number): { x: number; y: number } {
  const c = runCentre(layer, i);
  const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
  const sx = c.x * (layer.scaleX ?? 1);
  const sy = c.y * (layer.scaleY ?? 1);
  return {
    x: layer.x + sx * Math.cos(rad) - sy * Math.sin(rad),
    y: layer.y + sx * Math.sin(rad) + sy * Math.cos(rad),
  };
}

/**
 * The repeater is an ENTRY IN THE PATH-OPERATOR CHAIN since document 1.5.0, so
 * its copies are baked into the layer's geometry as subpaths instead of emitted
 * as N whole RenderLayers.
 *
 * These tests were rewritten in that fold. What they asserted before —
 * `layers` has length 4, ids `rect__rep1..3`, per-layer `x`/`rotation`/`scaleX`
 * — described the emission mechanism, and the mechanism is exactly what
 * changed. What they assert now is where the copies LAND, which is the part
 * that has to be preserved.
 */
describe('buildSnapshot — shape repeater', () => {
  it('emits one layer with no repeater', () => {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    const layers = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(layers).toHaveLength(1);
    expect(layers[0]!.id).toBe('rect');
  });

  it('bakes N copies into ONE layer, not N layers', () => {
    const layers = snapWithRepeater({
      copies: 4, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    });
    expect(layers).toHaveLength(1);
    expect(layers[0]!.id).toBe('rect');
    expect(layers[0]!.subpaths).toHaveLength(4);
    expect(layers[0]!.primitive).toBe('path');
    // One geometry field or the other, never both.
    expect(layers[0]!.pathPoints).toBeUndefined();
    expect(() => assertSinglePathSource(layers[0]!)).not.toThrow();
  });

  it('THE MIGRATION CLAIM: copies land where they always did on an untransformed layer', () => {
    const layer = snapWithRepeater({
      copies: 4, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    })[0]!;
    // The pre-fold renderer emitted four layers at comp x = 200, 300, 400, 500
    // (this file asserted exactly that until the fold). Same four numbers.
    expect(layer.subpaths!.map((_, i) => Math.round(runWorldCentre(layer, i).x)))
      .toEqual([200, 300, 400, 500]);
    expect(layer.subpaths!.map((_, i) => Math.round(runWorldCentre(layer, i).y)))
      .toEqual([300, 300, 300, 300]);
  });

  it('THE DELIBERATE CHANGE: on a ROTATED layer the ladder turns with it', () => {
    // Hand-computed. Layer rotated 90 degrees, offsetX 100.
    //   comp-space (pre-fold):   copy 1 at (200 + 100, 300)       = (300, 300)
    //   layer-local (post-fold): the offset is geometry, so the layer's 90
    //                            degrees turns it: (200, 300 + 100) = (200, 400)
    const rotated = shape('rect');
    (rotated.components[0]!.props as Record<string, unknown>).rotation = 90;
    const layer = snapWithRepeater(
      { copies: 2, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1 },
      rotated,
    )[0]!;
    const c1 = runWorldCentre(layer, 1);
    expect(Math.round(c1.x)).toBe(200);
    expect(Math.round(c1.y)).toBe(400);
    // And it is NOT where the comp-space model put it. Stated as an inequality
    // rather than left implied, because "the copies moved" is the whole
    // announced behaviour change and a silent pass here would hide a revert.
    expect(Math.round(c1.x)).not.toBe(300);
  });

  it('THE DELIBERATE CHANGE: on a SCALED layer the ladder stretches with it', () => {
    // offsetX 100 at layer scale 2 → copy 1 at 200 + 200 = 400 comp px, where
    // the comp-space model put it at 300. Not implied by the rotated case:
    // rotation changes the ladder's direction, scale changes its length.
    const scaled = shape('rect');
    (scaled.components[0]!.props as Record<string, unknown>).scaleX = 2;
    (scaled.components[0]!.props as Record<string, unknown>).scaleY = 2;
    const layer = snapWithRepeater(
      { copies: 2, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1 },
      scaled,
    )[0]!;
    expect(Math.round(runWorldCentre(layer, 1).x)).toBe(400);
  });

  it('offsetOpacity SURVIVES the fold, as per-run paint', () => {
    // The parameter the whole fold waited on: it is keyframeable, users animate
    // it, and baking copies into geometry left it nowhere to live until a
    // Subpath could carry its own paint.
    const layer = snapWithRepeater({
      copies: 3, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 0.5,
    })[0]!;
    expect(layer.subpaths!.map((s) => s.paint?.opacity)).toEqual([1, 0.5, 0.25]);
  });

  it('every copy carries paint once ANY does, so paint order is run order', () => {
    // Copy 0's multiplier is exactly 1, so it would otherwise be unpainted —
    // and `subpathBatches` draws the unpainted group FIRST. Under
    // `composite: 'below'` copy 0 must paint LAST, so an explicit {opacity: 1}
    // is what keeps the ladder's own ordering meaningful.
    const layer = snapWithRepeater({
      copies: 3, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 0.5,
      composite: 'below',
    })[0]!;
    expect(layer.subpaths!.every((s) => s.paint !== undefined)).toBe(true);
    // Reversed: the ladder still runs 0..n-1 but the original paints last.
    expect(layer.subpaths!.map((s) => s.paint!.opacity)).toEqual([0.25, 0.5, 1]);
  });

  it('leaves paint off entirely when no copy needs any', () => {
    // Without this every path-operator layer in every existing project would
    // move onto the batched draw path, where separately-filled runs can no
    // longer cut holes in each other.
    const layer = snapWithRepeater({
      copies: 3, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    })[0]!;
    expect(layer.subpaths!.every((s) => s.paint === undefined)).toBe(true);
  });

  it('scales the geometry per copy, and the STROKE with it', () => {
    // offsetScale used to be part of the copy's layer transform, which scaled
    // its stroke too. Baked into geometry it does not, so the factor rides out
    // on the run and lands on a per-run stroke override — otherwise a repeater
    // that halves its copies drew every one at the original stroke width.
    const node = shape('rect');
    const graph = new SceneGraph();
    graph.addNode(node);
    graph.setStroke('rect', { enabled: true, color: '#fff', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    graph.setRepeater('rect', {
      copies: 3, offsetX: 0, offsetY: 0, offsetRotation: 0, offsetScale: 0.5, offsetOpacity: 1,
    });
    const layer = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    // Geometry: the 220px rect's half-extent halves and halves again.
    expect(layer.subpaths!.map((_, i) => Math.round(Math.abs(runCentre(layer, i).x - layer.subpaths![i]!.points[0]!.x))))
      .toEqual([110, 55, 28]);
    // EFFECTIVE width, not the override's. Copy 0's scale is exactly 1, so it
    // carries no stroke override at all — absent means "paint with the layer's
    // own", which is the contract, and asserting the raw field would have
    // demanded a redundant copy of the layer's stroke on every unscaled run.
    expect(layer.subpaths!.map((s) => s.paint?.stroke?.width ?? layer.stroke!.width))
      .toEqual([8, 4, 2]);
  });

  it('grows the layer box so far copies are not sliced off at the texture edge', () => {
    // The raster is allocated from layer.width/height and rasterPadding is
    // capped at 512px per side. Six copies at the default 80px offset already
    // reach 400px; ten at 150px would lose their far copies silently.
    const layer = snapWithRepeater({
      copies: 6, offsetX: 300, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    })[0]!;
    const maxX = Math.max(...layer.subpaths!.flatMap((s) => s.points.map((p) => Math.abs(p.x))));
    expect(layer.width / 2).toBeGreaterThanOrEqual(maxX);
    // Symmetric about the origin, because the box is centred there — the
    // geometry's own coordinates are untouched, so nothing moves.
    expect(Math.round(runWorldCentre(layer, 0).x)).toBe(200);
  });

  it('a single copy behaves like no repeater', () => {
    const layers = snapWithRepeater({
      copies: 1, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    });
    expect(layers).toHaveLength(1);
    expect(layers[0]!.id).toBe('rect');
    // Inert, so it must not convert the primitive to a path — the same reason
    // an untouched Trim card is filtered out.
    expect(layers[0]!.subpaths).toBeUndefined();
    expect(layers[0]!.primitive).toBe('rect');
  });
});

/**
 * Trim CUTS the path — it does not annotate the stroke (F14).
 *
 * The old contract was `layer.trim = [[lo,hi]]`, an array the rasterizer read
 * inside its stroke loop and nowhere else; the fill traced the whole shape above
 * it, unconditionally. These assert the replacement: the arcs come back as
 * geometry, so fill and stroke read the same cut path.
 */
describe('buildSnapshot — trim path cuts geometry', () => {
  function trimmed(trim: { start: number; end: number; offset: number }) {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    graph.setTrimPath('rect', trim);
    return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
  }

  it('replaces the shape with the trimmed run, as an OPEN path', () => {
    const layer = trimmed({ start: 0, end: 50, offset: 0 });
    expect(layer.primitive).toBe('path');
    expect(layer.subpaths).toHaveLength(1);
    expect(layer.subpaths![0]!.open).toBe(true);
    // Half the outline of a rect: the run spans the top edge and the right edge,
    // so it ends diagonally opposite where it started.
    const run = layer.subpaths![0]!.points;
    expect(run.length).toBeGreaterThan(1);
    expect({ x: run[0]!.x, y: run[0]!.y }).toEqual({ x: -110, y: -110 });
    expect({ x: run[run.length - 1]!.x, y: run[run.length - 1]!.y }).toEqual({ x: 110, y: 110 });
  });

  it('clears pathPoints — the two geometry fields are mutually exclusive', () => {
    const layer = trimmed({ start: 0, end: 50, offset: 0 });
    expect(layer.pathPoints).toBeUndefined();
    expect(() => assertSinglePathSource(layer)).not.toThrow();
  });

  it('an OFFSET that wraps past the end yields TWO runs', () => {
    // The case the single-polyline contract could not express at all, and the
    // reason trim could never cut geometry before this.
    const layer = trimmed({ start: 0, end: 50, offset: 75 });
    expect(layer.subpaths).toHaveLength(2);
    expect(layer.subpaths!.every((s) => s.open === true)).toBe(true);
  });

  it('leaves the shape completely alone when the trim covers the full range', () => {
    const layer = trimmed({ start: 0, end: 100, offset: 0 });
    expect(layer.subpaths).toBeUndefined();
    expect(layer.primitive).toBe('rect');
    expect(layer.visible).toBe(true);
  });

  it('an EMPTY window draws nothing — not the untrimmed shape', () => {
    // The old behaviour: `trim = []` stroked no arcs and the fill drew the whole
    // rect regardless, so "trim everything away" showed a solid rectangle.
    const layer = trimmed({ start: 50, end: 50, offset: 0 });
    expect(layer.visible).toBe(false);
  });
});

describe('buildSnapshot — path operator', () => {
  it('turns a shape into a deformed path (zig-zag adds points)', () => {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    graph.setPathOps('rect', [{ id: 'o1', type: 'zigzag', amount: 10, detail: 3 }]);
    const layer = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    expect(layer.primitive).toBe('path');
    // rect outline (4 pts) zig-zagged at 3 segments/edge → 12 anchors
    expect(layer.pathPoints).toHaveLength(12);
  });

  it('leaves the shape a primitive when the op is none', () => {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    graph.setPathOps('rect', [{ id: 'o1', type: 'none', amount: 10, detail: 3 }]);
    const layer = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    expect(layer.primitive).not.toBe('path');
    expect(layer.pathPoints).toBeUndefined();
  });
});
