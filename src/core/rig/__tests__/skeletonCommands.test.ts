import { addBone, updateBone, deleteBone, setIKTarget, readNodeSkeleton } from '../skeletonCommands';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode, ID } from '@core/types';
import { performUndo, performRedo } from '@stores/historyStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';

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

    const node = defaultSceneGraph.getNode(nodeId);
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

  it('deletes a full descendant subtree, references and tracks in one undo step', () => {
    defaultSceneGraph.setSkeleton(nodeId, {
      bones: [
        { id: 'root', parentId: null, length: 40, x: 0, y: 0, rotation: 0 },
        { id: 'arm', parentId: 'root', length: 30, x: 40, y: 0, rotation: 0 },
        { id: 'hand', parentId: 'arm', length: 20, x: 30, y: 0, rotation: 0 },
        { id: 'leg', parentId: 'root', length: 35, x: 40, y: 0, rotation: 1 },
      ],
      ikTargets: [{ boneId: 'hand', x: 90, y: 10, pole: { x: 30, y: -40 } }],
      controllers: [{
        id: 'hand_ctrl',
        shape: 'circle',
        side: 'left',
        size: 14,
        link: { kind: 'ikTarget', boneId: 'hand' },
      }],
      weightPaint: {
        vertexCount: 1,
        bones: { hand: { 0: 1 }, leg: { 0: 1 } },
      },
    });
    defaultAnimation.setKeyframe(nodeId, 'bone.hand.rotation', 0, 0.5);
    defaultAnimation.setKeyframe(nodeId, 'ikTarget.hand.x', 0, 90);
    defaultAnimation.setKeyframe(nodeId, 'ikMode.hand', 0, 1);

    deleteBone(nodeId, 'arm');
    let skel = readNodeSkeleton(defaultSceneGraph.getNode(nodeId)!);
    expect(skel?.bones.map((bone) => bone.id)).toEqual(['root', 'leg']);
    expect(skel?.ikTargets).toEqual([]);
    expect(skel?.controllers).toEqual([]);
    expect(skel?.weightPaint?.bones).toEqual({ leg: { 0: 1 } });
    expect(defaultAnimation.isAnimated(nodeId, 'bone.hand.rotation')).toBe(false);
    expect(defaultAnimation.isAnimated(nodeId, 'ikTarget.hand.x')).toBe(false);
    expect(defaultAnimation.isAnimated(nodeId, 'ikMode.hand')).toBe(false);

    performUndo();
    skel = readNodeSkeleton(defaultSceneGraph.getNode(nodeId)!);
    expect(skel?.bones.map((bone) => bone.id)).toEqual(['root', 'arm', 'hand', 'leg']);
    expect(skel?.ikTargets).toHaveLength(1);
    expect(skel?.controllers).toHaveLength(1);
    expect(defaultAnimation.isAnimated(nodeId, 'bone.hand.rotation')).toBe(true);
    expect(defaultAnimation.isAnimated(nodeId, 'ikTarget.hand.x')).toBe(true);
    expect(defaultAnimation.isAnimated(nodeId, 'ikMode.hand')).toBe(true);
  });
});
