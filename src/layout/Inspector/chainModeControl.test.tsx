/**
 * The per-chain IK/FK control must be reachable and must drive the chain
 * switch (a client macro over `planChainSwitch`, rigEdits `chainSwitchCommands`:
 * mode + the pose that keeps the limb still, sent as ONE engine edit).
 *
 * ## Verified at runtime — and the earlier diagnosis here was wrong
 *
 * This file used to say the Rigging section "never mounted" in the app despite
 * its gate being satisfied. That was a misreading. Rigging is not a section of
 * the Properties inspector at all — it is a SEPARATE REGISTERED PANEL (`rig`),
 * by design: `DemoPanels.tsx` says "Rigging, Graph, Effects, Presets, Render
 * and Plugins stay separate tabs on purpose — those are editors and modes, not
 * properties of the selection." `InspectorContent` and `RigPanelContent` are
 * different panels that happen to share a file, so the gate quoted never ran
 * because its panel was not mounted. The app was never broken; the probe was
 * looking at the wrong tab.
 *
 * The mechanism to open it is `useLayoutStore.getState().openPanel(<panelId>)`,
 * which un-collapses the region and makes the panel active. Measured: the
 * chain-mode control is absent before that call and present after it.
 *
 * Driven through the real UI on this branch: a genuine `change` event on the
 * real `<select>` switched the chain IK -> FK -> IK with the hand moving
 * 0.000000 both ways and one undo entry per switch.
 */

import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { BoneControls } from './BoneControls';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { readNodeSkeleton, type SkeletonRig } from '@core/rig/skeletonCommands';
import { defaultAnimation } from '@motion/animation';
import { chainModePropPath } from '@core/rig/ikfk';
import { computeWorldTransforms, boneTip } from '@core/rig/skeleton';
import { applyIk } from '@core/rig/rigDeform';
import { resolveActiveIkTargets } from '@core/rig/liveIkTargets';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { rigTestLayer } from '@layout/Workspace/__testHelpers__/rigLayer';
import { useUIStore } from '@stores/uiStore';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';

const DEG = Math.PI / 180;

let h: Awaited<ReturnType<typeof setupAppEngine>>;
/** The rig layer (engine-created). */
let ID = '';

const rigOf = () => readNodeSkeleton(defaultSceneGraph.getNode(ID)!)!;
const idle = (): Promise<void> => act(async () => { await engineIdle(); });

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

async function switchTo(mode: 'ik' | 'fk'): Promise<void> {
  fireEvent.change(screen.getByLabelText('Fore chain mode'), { target: { value: mode } });
  await idle();
}

beforeEach(async () => {
  h = await setupAppEngine();
  ID = await rigTestLayer(h);
  const rig: SkeletonRig = {
    bones: [
      { id: 'upper', name: 'Upper', parentId: null, length: 70, x: -55, y: 18, rotation: -22 * DEG },
      { id: 'fore', name: 'Fore', parentId: 'upper', length: 45, x: 70, y: 0, rotation: 48 * DEG },
    ],
    ikTargets: [{ boneId: 'fore', x: 15, y: 62, chainLength: 2 }],
  };
  await h.run({ type: 'setProperty', prop: { layer: ID, path: 'layer/skeleton' }, value: { kind: 'json', value: JSON.stringify(rig) } });
  await idle();
  getCommandSystem().getHistory().clear();
  useUIStore.setState({ boneRigMode: 'pose' });
  usePreferenceStore.setState({ timelineAutoKeyframe: false });
  useRigSelectionStore.getState().selectBone(ID, 'fore');
});

afterEach(async () => {
  cleanup();
  await h.dispose();
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

  it('switching to FK writes the mode — ONE undo entry, and undo restores the rig', async () => {
    render(<BoneControls nodeId={ID} />);
    const before = h.doc();
    await switchTo('fk');
    expect(rigOf().ikTargets![0]!.ikMode).toBe('fk');
    expect(historyLabels()).toEqual(['Switch Fore to FK']);
    expect((screen.getByLabelText('Fore chain mode') as HTMLSelectElement).value).toBe('fk');
    await act(async () => { await h.run({ type: 'undo' }); });
    expect(h.doc()).toEqual(before);
  });

  it('switching through the CONTROL preserves the pose — not just through the command', async () => {
    // The reason this control exists. Measured the same way the runtime check
    // measures it: the hand must not move.
    render(<BoneControls nodeId={ID} />);
    const before = handNow();
    await switchTo('fk');
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

  it('switching back to IK also preserves it', async () => {
    render(<BoneControls nodeId={ID} />);
    await switchTo('fk');
    const before = handNow();
    await switchTo('ik');
    expect(rigOf().ikTargets![0]!.ikMode ?? 'ik').toBe('ik');
    expect(Math.hypot(handNow().x - before.x, handNow().y - before.y)).toBeCloseTo(0, 4);
    expect(historyLabels()).toEqual(['Switch Fore to FK', 'Switch Fore to IK']);
  });

  it('with auto-keyframe on, the switch keys the mode and the pose at the playhead', async () => {
    usePreferenceStore.setState({ timelineAutoKeyframe: true });
    render(<BoneControls nodeId={ID} />);
    const before = handNow();
    await switchTo('fk');
    expect(defaultAnimation.isAnimated(ID, chainModePropPath('fore'))).toBe(true);
    expect(defaultAnimation.isAnimated(ID, 'bone.upper.rotation')).toBe(true);
    expect(Math.hypot(handNow().x - before.x, handNow().y - before.y)).toBeCloseTo(0, 6);
    expect(historyLabels()).toEqual(['Switch Fore to FK']);
  });
});
