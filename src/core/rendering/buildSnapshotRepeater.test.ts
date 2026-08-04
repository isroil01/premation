import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { Repeater } from '@core/scene/repeater';
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

function snapWithRepeater(rep: Repeater) {
  const graph = new SceneGraph();
  graph.addNode(shape('rect'));
  graph.setRepeater('rect', rep);
  return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
}

describe('buildSnapshot — shape repeater', () => {
  it('emits one layer with no repeater', () => {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    const layers = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(layers).toHaveLength(1);
    expect(layers[0]!.id).toBe('rect');
  });

  it('emits N copies with cumulative position offsets', () => {
    const layers = snapWithRepeater({
      copies: 4, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    });
    expect(layers).toHaveLength(4);
    // Copy 0 is the original (id preserved), copies 1..3 are clones.
    expect(layers[0]!.id).toBe('rect');
    expect(layers.map((l) => Math.round(l.x))).toEqual([200, 300, 400, 500]);
    expect(layers.slice(1).map((l) => l.id)).toEqual(['rect__rep1', 'rect__rep2', 'rect__rep3']);
  });

  it('applies rotation / scale / opacity per copy', () => {
    const layers = snapWithRepeater({
      copies: 3, offsetX: 0, offsetY: 0, offsetRotation: 30, offsetScale: 0.5, offsetOpacity: 0.5,
    });
    expect(layers.map((l) => Math.round(l.rotation))).toEqual([0, 30, 60]);
    expect(layers.map((l) => Math.round(l.scaleX * 100) / 100)).toEqual([1, 0.5, 0.25]);
    // base opacity is 1 (100%); copies fade 1 → 0.5 → 0.25
    expect(layers.map((l) => Math.round(l.opacity * 100) / 100)).toEqual([1, 0.5, 0.25]);
  });

  it('a single copy behaves like no repeater', () => {
    const layers = snapWithRepeater({
      copies: 1, offsetX: 100, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 1,
    });
    expect(layers).toHaveLength(1);
    expect(layers[0]!.id).toBe('rect');
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
