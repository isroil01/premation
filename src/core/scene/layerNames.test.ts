import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { flattenComposition } from '@core/scene/sceneDerive';
import { activeCompRootId } from '@core/scene/activeComp';
import { uniqueLayerName } from './layerNames';

/**
 * Three drawn rectangles were three rows called "Rectangle" — in the timeline,
 * the Layers panel, every parent menu and every expression that names a layer.
 */
const ROOT = activeCompRootId() as string;

const add = (id: string, name: string): void => {
  defaultSceneGraph.addChild(ROOT as never, {
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape' } }],
  } as never);
};

beforeEach(() => {
  if (!defaultSceneGraph.getNode(ROOT as never)) {
    defaultSceneGraph.addNode({
      id: ROOT, name: 'Comp', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: `${ROOT}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'group' } }],
    } as never);
  }
  for (const n of flattenComposition(defaultSceneGraph, ROOT)) if (n.id !== ROOT) defaultSceneGraph.removeNode(n.id);
});

describe('uniqueLayerName', () => {
  it('keeps the bare word for the first layer of its kind', () => {
    expect(uniqueLayerName('Rectangle')).toBe('Rectangle');
  });

  it('numbers the ones after it', () => {
    add('a', 'Rectangle');
    expect(uniqueLayerName('Rectangle')).toBe('Rectangle 2');
    add('b', 'Rectangle 2');
    expect(uniqueLayerName('Rectangle')).toBe('Rectangle 3');
  });

  it('fills a gap a deleted layer left, and ignores other names', () => {
    add('a', 'Rectangle'); add('c', 'Rectangle 3'); add('s', 'Star');
    expect(uniqueLayerName('Rectangle')).toBe('Rectangle 2');
    expect(uniqueLayerName('Circle')).toBe('Circle');
  });
});
