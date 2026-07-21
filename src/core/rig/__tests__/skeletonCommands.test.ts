import { addBone, updateBone, deleteBone, setIKTarget, readNodeSkeleton } from '../skeletonCommands';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode, ID } from '@core/types';
import { performUndo, performRedo } from '@stores/historyStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

describe('skeletonCommands', () => {
  const nodeId = 'test_node_skel_1' as ID;

  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    const dummyNode: SceneNode = {
      id: nodeId,
      name: 'Test Node',
      parent: null,
      children: [],
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      visible: true,
      locked: false,
      components: [
        { id: 't1', type: 'Transform', props: { x: 0, y: 0 } },
        { id: 'fx1', type: 'fx', props: {} },
      ],
    };
    defaultSceneGraph.addChild('comp_root' as ID, dummyNode);
  });

  afterEach(() => {
    defaultSceneGraph.removeNode(nodeId);
  });

  it('adds bones to a layer with undo/redo support', () => {
    addBone(nodeId, { id: 'root_bone', parentId: null, length: 100, x: 0, y: 0, rotation: 0 });
    let node = defaultSceneGraph.getNode(nodeId);
    let skel = node ? readNodeSkeleton(node) : undefined;
    expect(skel?.bones).toHaveLength(1);
    expect(skel?.bones[0]?.id).toBe('root_bone');

    addBone(nodeId, { id: 'child_bone', parentId: 'root_bone', length: 80, x: 100, y: 0, rotation: 45 });
    node = defaultSceneGraph.getNode(nodeId);
    skel = node ? readNodeSkeleton(node) : undefined;
    expect(skel?.bones).toHaveLength(2);
    expect(skel?.bones[1]?.id).toBe('child_bone');

    performUndo();
    node = defaultSceneGraph.getNode(nodeId);
    skel = node ? readNodeSkeleton(node) : undefined;
    expect(skel?.bones).toHaveLength(1);

    performRedo();
    node = defaultSceneGraph.getNode(nodeId);
    skel = node ? readNodeSkeleton(node) : undefined;
    expect(skel?.bones).toHaveLength(2);
  });

  it('updates bone parameters and deletes bones cleanly', () => {
    addBone(nodeId, { id: 'b1', parentId: null, length: 50, x: 0, y: 0, rotation: 0 });
    updateBone(nodeId, 'b1', { length: 120, rotation: 30 });

    let node = defaultSceneGraph.getNode(nodeId);
    let skel = node ? readNodeSkeleton(node) : undefined;
    expect(skel?.bones[0]?.length).toBe(120);
    expect(skel?.bones[0]?.rotation).toBe(30);

    setIKTarget(nodeId, { boneId: 'b1', x: 120, y: 0, enabled: true });
    skel = readNodeSkeleton(defaultSceneGraph.getNode(nodeId)!);
    expect(skel?.ikTargets).toHaveLength(1);

    deleteBone(nodeId, 'b1');
    skel = readNodeSkeleton(defaultSceneGraph.getNode(nodeId)!);
    expect(skel?.bones).toHaveLength(0);
    expect(skel?.ikTargets).toHaveLength(0);
  });
});
