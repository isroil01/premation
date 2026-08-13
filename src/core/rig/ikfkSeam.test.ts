/**
 * IK/FK mode across the seam: the stored mode → `resolveActiveIkTargets` →
 * `applyIk` → the rendered mesh, and the switch command's undo shape.
 *
 * `ikfk.test.ts` proves the conversion arithmetic and every unit of it is green
 * whether or not the mode reaches the solver at all — the mode is read in ONE
 * place and consumed in another, and no unit test spans that (F30). A chain
 * could be FK in the inspector, IK in the render, and every existing test would
 * still pass.
 *
 * So this asserts the crossing, at the only place both halves meet: a snapshot
 * built from a scene whose chain is in FK must not show the IK solve.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine, defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { readNodeSkeleton, setChainMode, type SkeletonRig } from './skeletonCommands';
import { resolveActiveIkTargets, resolveIkTargets } from './liveIkTargets';
import { chainModePropPath } from './ikfk';
import { computeWorldTransforms, type Bone } from './skeleton';
import { applyIk } from './rigDeform';
import type { Bone as B } from './skeleton';

const DEG = Math.PI / 180;
const ID = 'seam_probe';
const comp = { width: 320, height: 240, background: '#101014' };

/** Bent, unequal, off-origin — the same uncleanliness `ikfk.test.ts` uses. */
const BONES: Bone[] = [
  { id: 'upper', parentId: null, length: 70, x: -55, y: 18, rotation: -22 * DEG },
  { id: 'fore', parentId: 'upper', length: 45, x: 70, y: 0, rotation: 48 * DEG },
];
/** A goal the chain is NOT already at, so IK and FK differ visibly. */
const GOAL = { boneId: 'fore', x: 15, y: 62, chainLength: 2 };

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

function sceneWith(ikMode: 'ik' | 'fk' | undefined) {
  const graph = new SceneGraph();
  graph.addNode(shapeNode('s'));
  graph.setSkeleton('s', {
    bones: BONES,
    ikTargets: [{ ...GOAL, ...(ikMode ? { ikMode } : {}) }],
    meshDensity: 8,
  } as SkeletonRig);
  return { graph, anim: new AnimationEngine() };
}

const meshOf = (g: SceneGraph, a: AnimationEngine) => {
  const snap = buildSnapshot(g, a, 0, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 's');
  expect(layer).toBeDefined();
  return layer!.deformedMesh?.vertices ?? null;
};

const differs = (a: Float32Array | null, b: Float32Array | null) => {
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 1e-6) return true;
  return false;
};

describe('the mode reaches the solver', () => {
  it('POSITIVE CONTROL: IK and FK are genuinely different pictures here', () => {
    // Without this, "FK differs from IK" could hold because the mesh is empty or
    // the chain happens to be at its goal — and every assertion below would be
    // satisfied by a renderer that ignored the skeleton entirely.
    const ik = sceneWith('ik');
    const fk = sceneWith('fk');
    const ikMesh = meshOf(ik.graph, ik.anim);
    expect(ikMesh).not.toBeNull();
    expect(ikMesh!.length).toBeGreaterThan(0);
    expect(differs(ikMesh, meshOf(fk.graph, fk.anim))).toBe(true);
  });

  it('a chain in FK mode is NOT solved — its mesh is the unsolved FK pose', () => {
    // The crossing. Derived independently: pose the bones with no targets at all
    // and require the FK-mode render to match that, rather than comparing the
    // renderer against itself.
    const fk = sceneWith('fk');
    const rendered = meshOf(fk.graph, fk.anim);

    const none = sceneWith(undefined);
    // Same scene with the target removed entirely — the definition of "not solved".
    none.graph.setSkeleton('s', { bones: BONES, ikTargets: [], meshDensity: 8 } as SkeletonRig);
    expect(differs(rendered, meshOf(none.graph, none.anim))).toBe(false);
  });

  it('an absent mode still solves — every rig authored before this is unchanged', () => {
    const legacy = sceneWith(undefined);
    const explicit = sceneWith('ik');
    expect(differs(meshOf(legacy.graph, legacy.anim), meshOf(explicit.graph, explicit.anim))).toBe(false);
  });

  it('the keyframed mode wins over the stored one, per frame', () => {
    // The switch is animation data: IK at t=0, FK at t=2 on a rig STORED as ik.
    const { graph, anim } = sceneWith('ik');
    anim.setKeyframe('s', chainModePropPath('fore'), 0, 1);
    anim.setKeyframe('s', chainModePropPath('fore'), 2, 0);
    const at = (t: number) => {
      const snap = buildSnapshot(graph, anim, t, undefined, undefined, undefined, undefined, comp);
      return snap.layers.find((l) => l.id === 's')!.deformedMesh?.vertices ?? null;
    };
    expect(differs(at(0), at(2))).toBe(true);
  });

  it('the resolver is the one place it is decided — FK omits the target entirely', () => {
    // `applyIk` overrides the rotations of any chain it is handed, so a target
    // that reached it in FK mode would drive the chain regardless of any later
    // check. FK has to mean "not in the list".
    const anim = new AnimationEngine();
    const rig = { bones: BONES, ikTargets: [{ ...GOAL, ikMode: 'fk' as const }] } as SkeletonRig;
    expect(resolveActiveIkTargets(rig, 's', 0, anim)).toEqual([]);
    const ikRig = { bones: BONES, ikTargets: [{ ...GOAL, ikMode: 'ik' as const }] } as SkeletonRig;
    expect(resolveActiveIkTargets(ikRig, 's', 0, anim)).toHaveLength(1);
  });
});

describe('the switch command', () => {
  const rigOf = () => readNodeSkeleton(defaultSceneGraph.getNode(ID)!)!;
  const historyDepth = () => {
    const h = getCommandSystem().getHistory() as unknown as { undoStack?: unknown[] };
    return h.undoStack?.length ?? 0;
  };
  const poseNow = (): Record<string, readonly number[]> => {
    const rig = rigOf();
    const live = (rig.bones ?? []).map((b: B) => {
      const r = defaultAnimation.sample(ID, `bone.${b.id}.rotation`, 0);
      return typeof r === 'number' ? { ...b, rotation: r } : { ...b };
    });
    const targets = resolveActiveIkTargets(rig, ID, 0);
    const w = computeWorldTransforms({ bones: applyIk(live, targets) });
    const out: Record<string, readonly number[]> = {};
    for (const b of live) out[b.id] = w.get(b.id)!;
    return out;
  };

  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
    defaultSceneGraph.addNode(shapeNode(ID));
    defaultSceneGraph.setSkeleton(ID, { bones: BONES, ikTargets: [GOAL] } as SkeletonRig);
  });

  it('IK → FK preserves the pose through the COMMAND, not just the planner', () => {
    const before = poseNow();
    setChainMode(ID, 'fore', 'fk', { layerT: 0, keyframe: false });
    expect(rigOf().ikTargets![0]!.ikMode).toBe('fk');
    const after = poseNow();
    for (const id of Object.keys(before)) {
      for (let i = 0; i < 6; i++) {
        expect({ id, i, v: after[id]![i]! }).toEqual({ id, i, v: expect.closeTo(before[id]![i]!, 6) });
      }
    }
  });

  it('FK → IK preserves it too', () => {
    setChainMode(ID, 'fore', 'fk', { layerT: 0, keyframe: false });
    const before = poseNow();
    setChainMode(ID, 'fore', 'ik', { layerT: 0, keyframe: false });
    expect(rigOf().ikTargets![0]!.ikMode).toBe('ik');
    const after = poseNow();
    for (const id of Object.keys(before)) {
      for (let i = 0; i < 6; i++) {
        expect({ id, i, v: after[id]![i]! }).toEqual({ id, i, v: expect.closeTo(before[id]![i]!, 4) });
      }
    }
  });

  it('is ONE undo entry, and undo restores the mode', () => {
    const d0 = historyDepth();
    setChainMode(ID, 'fore', 'fk', { layerT: 0, keyframe: false });
    expect(historyDepth()).toBe(d0 + 1);
    getCommandSystem().getHistory().undo();
    expect(rigOf().ikTargets![0]!.ikMode).toBeUndefined();
  });

  it('writes a mode keyframe when the gesture keyframes, and none when it does not', () => {
    // The half that silently regresses: static must write NO track.
    setChainMode(ID, 'fore', 'fk', { layerT: 0, keyframe: false });
    expect(defaultAnimation.isAnimated(ID, chainModePropPath('fore'))).toBe(false);
    setChainMode(ID, 'fore', 'ik', { layerT: 0, keyframe: true });
    expect(defaultAnimation.isAnimated(ID, chainModePropPath('fore'))).toBe(true);
  });

  it('does nothing for a bone with no chain', () => {
    setChainMode(ID, 'upper', 'fk', { layerT: 0, keyframe: false });
    expect(rigOf().ikTargets![0]!.ikMode).toBeUndefined();
  });
});

describe('placement survives FK — the bug runtime verification found', () => {
  /**
   * An IK controller must still be PLACED while its chain is in FK, so it can be
   * drawn greyed. Placing it from the mode-filtered list made it vanish instead:
   * FK empties that list, `controllerPosition` found no goal, and the overlay
   * skipped it. jsdom never saw this — the overlay is only exercised in the app,
   * so the observable is "the controller has a position", not "a component
   * rendered".
   */
  it('resolveIkTargets keeps an FK chain, resolveActiveIkTargets drops it', () => {
    const anim = new AnimationEngine();
    const rig = { bones: BONES, ikTargets: [{ ...GOAL, ikMode: 'fk' as const }] } as SkeletonRig;
    // Placement: still there, with its live position.
    const placed = resolveIkTargets(rig, 's', 0, anim);
    expect(placed).toHaveLength(1);
    expect({ x: placed[0]!.x, y: placed[0]!.y }).toEqual({ x: GOAL.x, y: GOAL.y });
    // Solving: gone.
    expect(resolveActiveIkTargets(rig, 's', 0, anim)).toEqual([]);
  });

  it('and the two agree while the chain is in IK — the split is only about mode', () => {
    const anim = new AnimationEngine();
    const rig = { bones: BONES, ikTargets: [{ ...GOAL, ikMode: 'ik' as const }] } as SkeletonRig;
    expect(resolveActiveIkTargets(rig, 's', 0, anim)).toEqual(resolveIkTargets(rig, 's', 0, anim));
  });

  it('placement still honours live keyframes, so a greyed handle is not stale', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe('s', 'ikTarget.fore.x', 0, -33);
    const rig = { bones: BONES, ikTargets: [{ ...GOAL, ikMode: 'fk' as const }] } as SkeletonRig;
    expect(resolveIkTargets(rig, 's', 0, anim)[0]!.x).toBe(-33);
  });
});
