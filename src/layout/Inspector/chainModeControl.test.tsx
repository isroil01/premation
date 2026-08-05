/**
 * The per-chain IK/FK control must be reachable and must drive `setChainMode`.
 *
 * ## UNVERIFIED AT RUNTIME — read before trusting the green
 *
 * Same gap as `controllerControls.test.tsx`, and this run tried to close it and
 * did not. The Rigging section is gated in `DemoPanels.tsx` on
 * `hasSkeleton || activeTool === 'bone' || !hasPuppet`, which a probe layer with
 * a skeleton and the bone tool active satisfies — yet the section never appeared
 * in the running app's inspector, whose other sections (Transform, Fill &
 * Stroke, Geometry & Path Effects, …) all rendered from that same file. Why it
 * did not mount is unresolved and is logged rather than guessed at.
 *
 * So: these tests prove the control BEHAVES correctly when rendered. They do not
 * prove a user can reach it. The SOLVER half of IK/FK switching was verified in
 * the running app — pose preservation measured at 0.000000 movement — but this
 * half was not.
 *
 * F29's shape again: the medium could not reach the layer where the bug would
 * live. Worth a proper fix, because this is now the second inspector section
 * blocked on it.
 */

import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { BoneControls } from './BoneControls';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNodeSkeleton, type SkeletonRig } from '@core/rig/skeletonCommands';
import { defaultAnimation } from '@motion/animation';
import { chainModePropPath } from '@core/rig/ikfk';
import { computeWorldTransforms, boneTip } from '@core/rig/skeleton';
import { applyIk } from '@core/rig/rigDeform';
import { resolveActiveIkTargets } from '@core/rig/liveIkTargets';
import type { SceneNode } from '@core/types';

const DEG = Math.PI / 180;
const ID = 'chain_ui';

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 200, height: 160, opacity: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

const rigOf = () => readNodeSkeleton(defaultSceneGraph.getNode(ID)!)!;

/** The hand position as the renderer computes it — the thing that must not move. */
function handNow(): { x: number; y: number } {
  const rig = rigOf();
  const live = rig.bones.map((b) => {
    const r = defaultAnimation.sample(ID, `bone.${b.id}.rotation`, 0);
    return typeof r === 'number' ? { ...b, rotation: r } : { ...b };
  });
  const w = computeWorldTransforms({ bones: applyIk(live, resolveActiveIkTargets(rig, ID, 0)) });
  return boneTip(w.get('fore')!, live.find((b) => b.id === 'fore')!.length);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode(shapeNode(ID));
  defaultAnimation.removeTrack(ID, chainModePropPath('fore'));
  defaultSceneGraph.setSkeleton(ID, {
    bones: [
      { id: 'upper', name: 'Upper', parentId: null, length: 70, x: -55, y: 18, rotation: -22 * DEG },
      { id: 'fore', name: 'Fore', parentId: 'upper', length: 45, x: 70, y: 0, rotation: 48 * DEG },
    ],
    ikTargets: [{ boneId: 'fore', x: 15, y: 62, chainLength: 2 }],
  } as SkeletonRig);
});

afterEach(() => {
  cleanup();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
});

describe('the Chain Mode control', () => {
  it('appears on a bone that has an IK target, defaulting to IK', () => {
    render(<BoneControls nodeId={ID} />);
    expect((screen.getByLabelText('Fore chain mode') as HTMLSelectElement).value).toBe('ik');
  });

  it('is ABSENT on a bone with no chain — there is no mode to choose', () => {
    render(<BoneControls nodeId={ID} />);
    expect(screen.queryByLabelText('Upper chain mode')).toBeNull();
  });

  it('switching to FK writes the mode', () => {
    render(<BoneControls nodeId={ID} />);
    fireEvent.change(screen.getByLabelText('Fore chain mode'), { target: { value: 'fk' } });
    expect(rigOf().ikTargets![0]!.ikMode).toBe('fk');
  });

  it('switching through the CONTROL preserves the pose — not just through the command', () => {
    // The reason this control exists. Measured the same way the runtime check
    // measures it: the hand must not move.
    render(<BoneControls nodeId={ID} />);
    const before = handNow();
    fireEvent.change(screen.getByLabelText('Fore chain mode'), { target: { value: 'fk' } });
    const after = handNow();
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeCloseTo(0, 6);
  });

  it('and the fixture could have shown a move — the chain is not at rest', () => {
    // Positive control: if the FK pose already reached the goal, "did not move"
    // would be free.
    const rig = rigOf();
    const w = computeWorldTransforms({ bones: [...rig.bones] });
    const rawHand = boneTip(w.get('fore')!, 45);
    const goal = rig.ikTargets![0]!;
    expect(Math.hypot(rawHand.x - goal.x, rawHand.y - goal.y)).toBeGreaterThan(10);
  });

  it('switching back to IK also preserves it', () => {
    render(<BoneControls nodeId={ID} />);
    fireEvent.change(screen.getByLabelText('Fore chain mode'), { target: { value: 'fk' } });
    cleanup();
    render(<BoneControls nodeId={ID} />);
    const before = handNow();
    fireEvent.change(screen.getByLabelText('Fore chain mode'), { target: { value: 'ik' } });
    expect(Math.hypot(handNow().x - before.x, handNow().y - before.y)).toBeCloseTo(0, 4);
  });
});
