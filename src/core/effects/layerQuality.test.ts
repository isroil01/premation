import { readNodeQuality, setNodeQuality, getNodeQuality, toggleNodeQuality } from './layerQuality';
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

describe('layer quality', () => {
  beforeEach(() => {
    const ids: string[] = [];
    defaultSceneGraph.traverse((n) => ids.push(n.id));
    for (const id of ids) defaultSceneGraph.removeNode(id);
  });

  it('defaults to best when unset', () => {
    addNode('a');
    expect(getNodeQuality('a')).toBe('best');
    expect(readNodeQuality(defaultSceneGraph.getNode('a')!)).toBe('best');
  });

  it('round-trips draft and clears back to best', () => {
    addNode('a');
    setNodeQuality('a', 'draft');
    expect(getNodeQuality('a')).toBe('draft');
    setNodeQuality('a', 'best');
    expect(getNodeQuality('a')).toBe('best');
  });

  it('toggles', () => {
    addNode('a');
    toggleNodeQuality('a');
    expect(getNodeQuality('a')).toBe('draft');
    toggleNodeQuality('a');
    expect(getNodeQuality('a')).toBe('best');
  });
});
