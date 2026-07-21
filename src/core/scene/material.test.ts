import { readNodeMaterial, getNodeCastsShadows, setNodeCastsShadows } from './material';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';

function addNode(id: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true, locked: false,
    components: [{ id: `${id}_t`, type: 'Transform', props: {} }],
  } as unknown as SceneNode);
}

describe('material options — casts shadows', () => {
  beforeEach(() => {
    const ids: string[] = [];
    defaultSceneGraph.traverse((n) => ids.push(n.id));
    for (const id of ids) defaultSceneGraph.removeNode(id);
  });

  it('defaults to casting shadows', () => {
    addNode('a');
    expect(readNodeMaterial(defaultSceneGraph.getNode('a')!).castsShadows).toBe(true);
    expect(getNodeCastsShadows('a')).toBe(true);
  });

  it('round-trips off and back on', () => {
    addNode('a');
    setNodeCastsShadows('a', false);
    expect(getNodeCastsShadows('a')).toBe(false);
    setNodeCastsShadows('a', true);
    expect(getNodeCastsShadows('a')).toBe(true);
  });
});
