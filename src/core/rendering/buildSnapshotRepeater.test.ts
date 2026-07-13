import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { Repeater } from '@core/scene/repeater';

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

describe('buildSnapshot — trim path', () => {
  it('threads a partial trim onto the layer as visible arcs', () => {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    graph.setTrimPath('rect', { start: 0, end: 50, offset: 0 });
    const layers = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(layers[0]!.trim).toEqual([[0, 0.5]]);
  });

  it('omits trim when it covers the full range (no-op)', () => {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    graph.setTrimPath('rect', { start: 0, end: 100, offset: 0 });
    const layers = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(layers[0]!.trim).toBeUndefined();
  });
});

describe('buildSnapshot — path operator', () => {
  it('turns a shape into a deformed path (zig-zag adds points)', () => {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    graph.setPathOp('rect', { type: 'zigzag', amount: 10, detail: 3 });
    const layer = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    expect(layer.primitive).toBe('path');
    // rect outline (4 pts) zig-zagged at 3 segments/edge → 12 anchors
    expect(layer.pathPoints).toHaveLength(12);
  });

  it('leaves the shape a primitive when the op is none', () => {
    const graph = new SceneGraph();
    graph.addNode(shape('rect'));
    graph.setPathOp('rect', { type: 'none', amount: 10, detail: 3 });
    const layer = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    expect(layer.primitive).not.toBe('path');
    expect(layer.pathPoints).toBeUndefined();
  });
});
