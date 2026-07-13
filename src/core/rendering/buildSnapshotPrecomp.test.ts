import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const COMP = { width: 800, height: 600, background: '#101014' };

function group(id: string, opacity = 100): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group', opacity } }],
  } as unknown as SceneNode;
}
function shape(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, rotation: 0 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

function topLayers(build: (g: SceneGraph) => void) {
  const g = new SceneGraph();
  build(g);
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
}

describe('buildSnapshot — precomp', () => {
  it('routes a precomp group’s children into ONE precomp layer', () => {
    const layers = topLayers((g) => {
      g.addNode(group('G'));
      g.addChild('G', shape('C1'));
      g.addChild('G', shape('C2'));
      g.setPrecomp('G', true);
    });
    expect(layers).toHaveLength(1);
    expect(layers[0]!.id).toBe('G');
    expect(layers[0]!.precompLayers?.map((l) => l.id)).toEqual(['C1', 'C2']);
  });

  it('a non-precomp group renders its children individually (unchanged)', () => {
    const layers = topLayers((g) => {
      g.addNode(group('G'));
      g.addChild('G', shape('C1'));
      g.addChild('G', shape('C2'));
    });
    expect(layers.map((l) => l.id)).toEqual(['C1', 'C2']);
    expect(layers.every((l) => l.precompLayers === undefined)).toBe(true);
  });

  it('carries the group opacity onto the precomp container', () => {
    const layers = topLayers((g) => {
      g.addNode(group('G', 50));
      g.addChild('G', shape('C1'));
      g.setPrecomp('G', true);
    });
    expect(layers[0]!.opacity).toBeCloseTo(0.5);
    expect(layers[0]!.precompLayers).toHaveLength(1);
  });

  it('time-remaps the nested content via the group precompTime (reverse)', () => {
    const g = new SceneGraph();
    g.addNode(group('G'));
    g.addChild('G', shape('C1'));
    g.setPrecomp('G', true);
    const engine = new AnimationEngine();
    engine.setKeyframe('C1', 'x', 0, 0);
    engine.setKeyframe('C1', 'x', 1, 100);
    // Reverse inner time: comp 0 → inner 1, comp 1 → inner 0.
    engine.setKeyframe('G', 'precompTime', 0, 1);
    engine.setKeyframe('G', 'precompTime', 1, 0);
    const innerX = (t: number): number =>
      buildSnapshot(g, engine, t, undefined, undefined, undefined, undefined, COMP).layers[0]!.precompLayers![0]!.x;
    expect(innerX(0)).toBeCloseTo(100); // reversed
    expect(innerX(1)).toBeCloseTo(0);
  });
});
