/**
 * Component library — save a selection as a reusable component, then insert
 * independent copies. Verifies the round-trip: serialize a live subtree →
 * store → instantiate fresh nodes.
 */

import { useComponentStore } from './componentStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from './selectionStore';
import type { SceneNode } from '@core/types';

function n(id: string, parent: string | null, kind: string, extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: kind, x: 0, y: 0, rotation: 0 } }],
    ...extra,
  } as unknown as SceneNode;
}

function seedCard(): void {
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode(n('comp_root', null, 'group'));
  defaultSceneGraph.addChild('comp_root', n('card', 'comp_root', 'group'));
  defaultSceneGraph.addChild('card', n('panel', 'card', 'shape'));
  defaultSceneGraph.addChild('card', n('title', 'card', 'text'));
  useComponentStore.setState({ components: [] });
}

describe('component library', () => {
  beforeEach(seedCard);

  it('saves a selected subtree as a component definition', () => {
    useSelectionStore.getState().set(['card']);
    const id = useComponentStore.getState().saveFromSelection('Card');
    expect(id).toBeTruthy();
    const defs = useComponentStore.getState().components;
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('Card');
    // the two children (panel + title) were captured
    expect(defs[0]!.root.children).toHaveLength(2);
  });

  it('inserts an independent copy with fresh ids', () => {
    useSelectionStore.getState().set(['card']);
    const defId = useComponentStore.getState().saveFromSelection('Card')!;
    const before = defaultSceneGraph.size;
    const newId = useComponentStore.getState().insert(defId)!;

    // group + 2 children added
    expect(defaultSceneGraph.size).toBe(before + 3);
    // the new root is NOT the original, and has 2 children
    expect(newId).not.toBe('card');
    expect(defaultSceneGraph.getNode(newId)!.parent).toBe('comp_root');
    expect(defaultSceneGraph.getChildren(newId)).toHaveLength(2);
    // it's selected
    expect(useSelectionStore.getState().ids).toContain(newId);
  });

  it('saves a multi-selection wrapped in one group', () => {
    useSelectionStore.getState().set(['panel', 'title']);
    const id = useComponentStore.getState().saveFromSelection('Pair')!;
    const def = useComponentStore.getState().components.find((c) => c.id === id)!;
    expect(def.root.children).toHaveLength(2); // both wrapped under a synthetic group
  });

  it('removes a component', () => {
    useSelectionStore.getState().set(['card']);
    const id = useComponentStore.getState().saveFromSelection('Card')!;
    useComponentStore.getState().remove(id);
    expect(useComponentStore.getState().components).toHaveLength(0);
  });
});
