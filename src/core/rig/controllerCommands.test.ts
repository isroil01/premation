/**
 * Controller commands, undo granularity, and export invisibility.
 *
 * The export guard is the interesting one. Controllers are rig DATA, so they
 * never become render layers — which means "controllers do not render" cannot be
 * checked by looking for a layer and failing to find it. That assertion would
 * pass on a build that had no controllers at all, and on one that drew them into
 * every frame.
 *
 * Rule 5·0: name the observable. It is that **an exported frame is byte-identical
 * with and without controllers on the rig** — so the fixture builds the same
 * scene twice, differing only in the controller list, and compares the snapshots
 * the exporter consumes. A positive control sits beside it, because a comparison
 * that can only ever say "identical" is not a measurement: the same harness must
 * be shown to DETECT a difference it is supposed to detect.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import {
  addController, deleteController, updateController, readNodeSkeleton, deleteBone,
  previewSkeleton, recordSkeletonPose, type SkeletonRig,
} from './skeletonCommands';
import { defaultControllerFor, type RigController } from './controllers';
import type { Bone } from './skeleton';

const ID = 'ctrl_probe';
const comp = { width: 320, height: 240, background: '#101014' };

const BONES: Bone[] = [
  { id: 'root', parentId: null, length: 40, x: 20, y: 5, rotation: 0.3 },
  { id: 'child', parentId: 'root', length: 30, x: 40, y: 0, rotation: -0.4 },
];

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 160, y: 120 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 160, y: 120, rotation: 0, width: 180, height: 120 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

const rigOf = (): SkeletonRig | undefined => readNodeSkeleton(defaultSceneGraph.getNode(ID)!);
const controllersOf = (): RigController[] => rigOf()?.controllers ?? [];
const historyDepth = (): number => {
  const h = getCommandSystem().getHistory() as unknown as { undoStack?: unknown[] };
  return h.undoStack?.length ?? 0;
};

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode(shapeNode(ID));
  defaultSceneGraph.setSkeleton(ID, { bones: BONES, ikTargets: [{ boneId: 'child', x: 10, y: 20 }] });
});

describe('controller commands', () => {
  it('adds, and the rig carries it', () => {
    addController(ID, defaultControllerFor({ kind: 'ikTarget', boneId: 'child' }, [], BONES));
    expect(controllersOf()).toHaveLength(1);
    expect(controllersOf()[0]!.link).toEqual({ kind: 'ikTarget', boneId: 'child' });
  });

  it('one add is ONE undo entry, and undo removes it', () => {
    const before = historyDepth();
    addController(ID, defaultControllerFor({ kind: 'bone', boneId: 'root' }, [], BONES));
    expect(historyDepth()).toBe(before + 1);
    getCommandSystem().getHistory().undo();
    expect(controllersOf()).toHaveLength(0);
  });

  it('updates shape/side/size without touching the link', () => {
    addController(ID, defaultControllerFor({ kind: 'bone', boneId: 'root' }, [], BONES));
    const id = controllersOf()[0]!.id;
    updateController(ID, id, { shape: 'square', side: 'left', size: 22 });
    const c = controllersOf()[0]!;
    expect([c.shape, c.side, c.size]).toEqual(['square', 'left', 22]);
    expect(c.link).toEqual({ kind: 'bone', boneId: 'root' });
  });

  it('deletes only the named controller', () => {
    addController(ID, defaultControllerFor({ kind: 'bone', boneId: 'root' }, controllersOf(), BONES));
    addController(ID, defaultControllerFor({ kind: 'bone', boneId: 'child' }, controllersOf(), BONES));
    const [first, second] = controllersOf();
    deleteController(ID, first!.id);
    expect(controllersOf().map((c) => c.id)).toEqual([second!.id]);
  });

  it('deleting a BONE takes its controllers with it', () => {
    addController(ID, defaultControllerFor({ kind: 'bone', boneId: 'child' }, controllersOf(), BONES));
    addController(ID, defaultControllerFor({ kind: 'bone', boneId: 'root' }, controllersOf(), BONES));
    // Derived from the rig, not hard-coded: whatever links to `child` must go.
    const survivors = controllersOf().filter((c) => c.link.boneId !== 'child').map((c) => c.id);
    deleteBone(ID, 'child');
    expect(controllersOf().map((c) => c.id)).toEqual(survivors);
  });
});

describe('a previewed pose is ONE undo entry', () => {
  it('many preview writes then one record — the whole gesture undoes together', () => {
    // The drag path: `previewSkeleton` per pointermove (no history), then a
    // single `recordSkeletonPose` on release. Ten writes, one entry.
    const before = rigOf();
    const depth0 = historyDepth();
    for (let i = 1; i <= 10; i++) {
      previewSkeleton(ID, {
        ...rigOf()!,
        ikTargets: [{ boneId: 'child', x: 10 + i, y: 20 + i }],
      });
    }
    expect(historyDepth()).toBe(depth0);            // nothing recorded mid-gesture
    expect(rigOf()!.ikTargets![0]!.x).toBe(20);

    recordSkeletonPose(ID, before, 'Pose child');
    expect(historyDepth()).toBe(depth0 + 1);

    getCommandSystem().getHistory().undo();
    expect(rigOf()!.ikTargets![0]!.x).toBe(10);     // back to the pre-gesture value
  });
});

describe('export invisibility — the observable is the FRAME, not a layer lookup', () => {
  /** Same scene twice; `controllers` is the only difference. */
  function sceneWith(controllers: RigController[] | undefined) {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('s'));
    graph.setSkeleton('s', {
      bones: BONES,
      ikTargets: [{ boneId: 'child', x: 10, y: 20 }],
      ...(controllers ? { controllers } : {}),
    });
    return { graph, anim: new AnimationEngine() };
  }

  const snap = (g: SceneGraph, a: AnimationEngine, forExport: boolean) =>
    JSON.stringify(
      buildSnapshot(g, a, 0, undefined, undefined, undefined, undefined, { ...comp, forExport }).layers,
    );

  const withCtrl: RigController[] = [
    { id: 'c1', shape: 'circle', side: 'left', size: 14, link: { kind: 'ikTarget', boneId: 'child' } },
    { id: 'c2', shape: 'arc', side: 'right', size: 20, offsetX: 30, link: { kind: 'bone', boneId: 'root' } },
  ];

  it('the fixture renders something — an empty snapshot would pass everything below', () => {
    const a = sceneWith(undefined);
    const layers = buildSnapshot(a.graph, a.anim, 0, undefined, undefined, undefined, undefined, { ...comp, forExport: true }).layers;
    expect(layers.length).toBeGreaterThan(0);
    expect(layers.some((l) => l.id === 's')).toBe(true);
  });

  it('POSITIVE CONTROL: this comparison can detect a difference', () => {
    // Without this, "identical" proves nothing — a harness that always returns
    // the same string would report success forever. Change something that MUST
    // alter the frame (the layer's fill) and require the comparison to notice.
    const a = sceneWith(undefined);
    const b = sceneWith(undefined);
    b.graph.setFill('s', { type: 'solid', color: '#ff0000' });
    expect(snap(a.graph, a.anim, true)).not.toBe(snap(b.graph, b.anim, true));
  });

  it('an EXPORTED frame is byte-identical with and without controllers', () => {
    const a = sceneWith(undefined);
    const b = sceneWith(withCtrl);
    expect(snap(b.graph, b.anim, true)).toBe(snap(a.graph, a.anim, true));
  });

  it('and so is the VIEWPORT frame — controllers are overlay-only, not scene content', () => {
    // The other half of the claim: they are not secretly drawn into the comp
    // either. What makes them visible is `BoneOverlay`, an SVG layer above the
    // canvas, which no snapshot contains.
    const a = sceneWith(undefined);
    const b = sceneWith(withCtrl);
    expect(snap(b.graph, b.anim, false)).toBe(snap(a.graph, a.anim, false));
  });
});
