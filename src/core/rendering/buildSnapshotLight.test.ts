import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNodeLight } from '@core/scene/light';

const COMP = { width: 800, height: 600, background: '#101014' };

function light(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', x: 400, y: 300, rotation: 0, intensity: 80, radius: 250 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffcc00' } },
    ],
  } as unknown as SceneNode;
}

describe('lights', () => {
  it('readNodeLight reads colour / intensity / radius (with defaults)', () => {
    expect(readNodeLight(light('L'))).toEqual({ color: '#ffcc00', intensity: 80, radius: 250 });
  });

  it('buildSnapshot emits a light layer at the light position', () => {
    const g = new SceneGraph();
    g.addNode(light('L'));
    const layers = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
    expect(layers).toHaveLength(1);
    expect(layers[0]!.light).toEqual({ color: '#ffcc00', intensity: 80, radius: 250 });
    expect(layers[0]!.x).toBeCloseTo(400);
    expect(layers[0]!.y).toBeCloseTo(300);
  });
});
