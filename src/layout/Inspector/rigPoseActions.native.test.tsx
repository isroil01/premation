/**
 * Copy, Paste and Mirror Pose on the real engine: where the keys land, what they
 * hold, and that each is one undo entry.
 *
 * ── THE POSE IS ASYMMETRIC ON PURPOSE ─────────────────────────────────────
 *
 * A symmetric pose cannot show a left/right swap: mirror it and the same values
 * come back (the point `rigPresets.test.ts` rule 2b makes about sides). So every
 * limb below holds its own distinct angle, goal and pole, and each expected
 * value is written out from the reflection, never computed by the code under
 * test. `src/core/rig/poseMirror.test.ts` has the positive control: a swap that
 * skips the reflection fails.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setupAppEngine, historyLabels, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { bipedPreset } from '@core/rig/rigPresets';
import { useRigPoseClipboard } from '@stores/rigPoseClipboard';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { usePreferenceStore } from '@stores/preferenceStore';
import { rigTestLayer } from '@layout/Workspace/__testHelpers__/rigLayer';
import { rigKey, rigPaths, rigValues } from '@core/engine/rigPaths';
import { copyRigPose, mirrorRigPose, pasteRigPose } from './rigPoseActions';
import { RigPoseButtons } from './RigPoseButtons';
import { BoneControls } from './BoneControls';
import { buildStaticCommands } from '@providers/Providers';
import { useUIStore } from '@stores/uiStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';

const DEG = Math.PI / 180;
const RIG = bipedPreset({ width: 200, height: 400 });
const rest = (id: string): number => RIG.bones.find((b) => b.id === id)!.rotation / DEG;

let h: Harness;
let L = '';

const key = (bone: string, deg: number, at: number) => rigKey(L, rigPaths.boneProp(bone, 'rotation'), at, rigValues.scalar(deg));
const goalKey = (bone: string, x: number, y: number, at: number) => rigKey(L, rigPaths.ikProp(bone, 'target'), at, rigValues.vec2(x, y));
const keysOf = async (track: string): Promise<Array<{ t: number; v: number }>> =>
  ((await docView()).getTrackKeyframes(L, track) ?? []).map((k) => ({ t: k.t, v: k.value }));
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;

/** Select a layer, as the app does before any of this, and wait for its tree in the mirror. */
async function selectLayer(layer: string): Promise<void> {
  useSelectionStore.getState().set([layer]);
  await waitFor(() => expect(documentMirror().tree(layer)?.nodes.has('skeleton')).toBe(true));
}

/** A bone's live rotation at a time, in degrees. */
async function rotationAt(bone: string, seconds: number): Promise<number> {
  const res = await engine().query({ type: 'getRigPose', layer: L, time: compTime(seconds), points: [] });
  if (!res.ok) throw new Error('getRigPose');
  return res.value.bones.find((b) => b.id === bone)!.rotation / DEG;
}

beforeEach(async () => {
  h = await setupAppEngine();
  L = await rigTestLayer(h, { width: 200, height: 400, skeleton: RIG });
  await selectLayer(L);
  useRigSelectionStore.getState().clear();
  useRigPoseClipboard.getState().clear();
  usePreferenceStore.setState({ timelineAutoKeyframe: false });
});
afterEach(async () => { await h.dispose(); });

describe('Mirror Pose', () => {
  beforeEach(async () => {
    await h.batch('pose', [
      key('arm_l_upper', 150, 1), key('arm_r_upper', 20, 1),
      key('arm_l_lower', 35, 1), key('arm_r_lower', -70, 1),
      key('head', 11, 1), key('hips', -90, 1),
      goalKey('arm_l_lower', -130, 40, 1), goalKey('arm_r_lower', 90, -10, 1),
    ]);
  });

  it('swaps the sides by reflection, keys the playhead, is one undo entry', async () => {
    await mirrorRigPose(L, 1);
    await settleEdits();

    // new left = left rest − (right pose − right rest), and the other way round.
    const armL = rest('arm_l_upper'); // 129.6
    const armR = rest('arm_r_upper'); // 50.4
    expect(await rotationAt('arm_l_upper', 1)).toBeCloseTo(armL - (20 - armR), 3);
    expect(await rotationAt('arm_r_upper', 1)).toBeCloseTo(armR - (150 - armL), 3);
    expect(await rotationAt('arm_l_lower', 1)).toBeCloseTo(70, 3);
    expect(await rotationAt('arm_r_lower', 1)).toBeCloseTo(-35, 3);

    // A goal reflects about the centre line, into the OTHER limb.
    const res = await engine().query({ type: 'getRigPose', layer: L, time: compTime(1), points: [] });
    const goal = (bone: string) => res.ok ? res.value.ik.find((g) => g.bone === bone)! : undefined;
    expect(goal('arm_l_lower')).toMatchObject({ x: -90, y: -10 });
    expect(goal('arm_r_lower')).toMatchObject({ x: 130, y: 40 });

    expect((await historyLabels()).at(-1)).toBe('Mirror Pose');
    await h.run({ type: 'undo' });
    expect(await rotationAt('arm_l_upper', 1)).toBeCloseTo(150, 3);
    expect(await rotationAt('arm_r_upper', 1)).toBeCloseTo(20, 3);
  });

  it('leaves a bone with no opposite exactly as it was', async () => {
    await mirrorRigPose(L, 1);
    await settleEdits();
    expect(await rotationAt('head', 1)).toBeCloseTo(11, 3);
    expect(await rotationAt('hips', 1)).toBeCloseTo(-90, 3);
  });

  it('twice is the pose it started from', async () => {
    await mirrorRigPose(L, 1);
    await mirrorRigPose(L, 1);
    await settleEdits();
    expect(await rotationAt('arm_l_upper', 1)).toBeCloseTo(150, 3);
    expect(await rotationAt('arm_r_lower', 1)).toBeCloseTo(-70, 3);
  });

  it('with a bone selected swaps only that pair', async () => {
    useRigSelectionStore.getState().selectBones(L, ['leg_l_lower']);
    await h.batch('legs', [key('leg_l_lower', 25, 1), key('leg_r_lower', -5, 1)]);
    await mirrorRigPose(L, 1);
    await settleEdits();
    expect(await rotationAt('leg_l_lower', 1)).toBeCloseTo(5, 3);
    expect(await rotationAt('leg_r_lower', 1)).toBeCloseTo(-25, 3);
    expect(await rotationAt('arm_l_upper', 1)).toBeCloseTo(150, 3);
  });

  it('keys a static opposite too: a key never pours into a whole track', async () => {
    await h.batch('one side', [key('leg_l_lower', 25, 1)]);
    await mirrorRigPose(L, 1);
    await settleEdits();
    expect(await keysOf('bone.leg_r_lower.rotation')).toHaveLength(1);
    expect((await keysOf('bone.leg_r_lower.rotation'))[0]!.t).toBe(1);
  });

  it('a static pose with auto-key off stays static', async () => {
    const S = await rigTestLayer(h, { width: 200, height: 400, skeleton: RIG });
    await h.batch('static', [
      { type: 'setProperty', prop: { layer: S, path: rigPaths.boneProp('leg_l_lower', 'rotation') }, value: rigValues.scalar(30) },
    ]);
    await selectLayer(S);
    await mirrorRigPose(S, 0);
    await settleEdits();
    expect((await docView()).getTrackKeyframes(S, 'bone.leg_l_lower.rotation') ?? []).toHaveLength(0);
    expect((await docView()).getTrackKeyframes(S, 'bone.leg_r_lower.rotation') ?? []).toHaveLength(0);
    const res = await engine().query({ type: 'getRigPose', layer: S, time: 0, points: [] });
    const r = res.ok ? res.value.bones.find((b) => b.id === 'leg_r_lower')!.rotation / DEG : NaN;
    expect(r).toBeCloseTo(-30, 3);
  });
});

describe('Copy and Paste Pose', () => {
  beforeEach(async () => {
    await h.batch('two poses', [
      key('arm_l_lower', 40, 1), key('arm_l_lower', 90, 2),
      key('arm_r_lower', -15, 1), key('arm_r_lower', -60, 2),
      key('head', 5, 1), key('head', 25, 2),
    ]);
  });

  it('pastes the selected bones at the new time, one entry, and leaves the rest alone', async () => {
    useRigSelectionStore.getState().selectBones(L, ['head', 'arm_r_lower']);
    await copyRigPose(L, 1);
    await pasteRigPose(L, 3);
    await settleEdits();

    expect(await keysOf('bone.head.rotation')).toEqual(expect.arrayContaining([{ t: 3, v: expect.anything() }]));
    expect(await rotationAt('head', 3)).toBeCloseTo(5, 3);
    expect(await rotationAt('arm_r_lower', 3)).toBeCloseTo(-15, 3);
    // The other arm was not copied: no key at 3, and the source keys did not move.
    expect((await keysOf('bone.arm_l_lower.rotation')).map((k) => k.t)).toEqual([1, 2]);
    expect(await rotationAt('head', 1)).toBeCloseTo(5, 3);
    expect(await rotationAt('head', 2)).toBeCloseTo(25, 3);

    expect((await historyLabels()).at(-1)).toBe('Paste Pose');
    await h.run({ type: 'undo' });
    expect((await keysOf('bone.head.rotation')).map((k) => k.t)).toEqual([1, 2]);
  });

  it('replaces a key already at the paste time rather than stacking one', async () => {
    useRigSelectionStore.getState().selectBones(L, ['head']);
    await copyRigPose(L, 1);
    await pasteRigPose(L, 2);
    await settleEdits();
    expect((await keysOf('bone.head.rotation')).map((k) => k.t)).toEqual([1, 2]);
    expect(await rotationAt('head', 2)).toBeCloseTo(5, 3);
  });

  it('copying one bone of an IK chain carries the goal that poses it', async () => {
    await h.batch('goal', [goalKey('arm_l_lower', -50, 60, 1), goalKey('arm_l_lower', -20, 90, 2)]);
    useRigSelectionStore.getState().selectBones(L, ['arm_l_upper']);
    await copyRigPose(L, 1);
    await pasteRigPose(L, 4);
    await settleEdits();
    const x = await keysOf('ikTarget.arm_l_lower.x');
    expect(x.at(-1)).toMatchObject({ t: 4 });
    expect(near(x.at(-1)!.v, -50)).toBe(true);
  });

  it('adds no position or scale tracks to a rig that only rotates', async () => {
    await copyRigPose(L, 1);
    await pasteRigPose(L, 3);
    await settleEdits();
    expect((await docView()).getTrackKeyframes(L, 'bone.head.x') ?? []).toHaveLength(0);
    expect((await docView()).getTrackKeyframes(L, 'bone.head.scaleX') ?? []).toHaveLength(0);
  });

  it('skips a copied bone this rig does not have, and pastes the rest', async () => {
    useRigSelectionStore.getState().selectBones(L, ['head']);
    await copyRigPose(L, 1);
    const copied = useRigPoseClipboard.getState().pose!;
    useRigPoseClipboard.getState().copy({ ...copied, bones: new Map([...copied.bones, ['gone', copied.bones.get('head')!]]) });
    await pasteRigPose(L, 3);
    await settleEdits();
    expect(await rotationAt('head', 3)).toBeCloseTo(5, 3);
  });
});

describe('the chords', () => {
  const command = (id: string) => buildStaticCommands().find((c) => String(c.id) === id)!;
  const run = async (id: string): Promise<void> => {
    await act(async () => { await command(id).execute({} as never); });
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); await settleEdits(); });
  };

  beforeEach(async () => {
    await h.batch('pose', [key('head', 12, 1)]);
    useUIStore.getState().setActiveTool('bone');
    useUIStore.getState().setBoneRigMode('pose');
    useRigSelectionStore.getState().selectBones(L, ['head']);
    useKeyframeSelectionStore.getState().clear();
  });
  afterEach(() => { useUIStore.getState().setActiveTool('select'); });

  it('Ctrl+C copies the pose in Pose mode; in any other mode it stays a layer copy', async () => {
    await run('edit.copy');
    expect(useRigPoseClipboard.getState().pose?.bones.has('head')).toBe(true);

    useUIStore.getState().setBoneRigMode('draw');
    await run('edit.copy');
    expect(useRigPoseClipboard.getState().pose).toBeNull();
  });

  it('Ctrl+V pastes the pose at the playhead in Pose mode', async () => {
    await run('edit.copy');
    await h.batch('moved', [key('head', 50, 0)]);
    await run('edit.paste');
    expect((await historyLabels()).at(-1)).toBe('Paste Pose');
  });

  it('Mirror has a chord, and is off on a rig with no sides', async () => {
    expect(command('rig.mirrorPose').shortcut).toEqual({ key: 'm', meta: true, shift: true });
    expect(command('rig.mirrorPose').enabled?.()).toBe(true);
    const S = await rigTestLayer(h, { skeleton: { bones: [{ id: 'a', parentId: null, length: 50, x: 0, y: 0, rotation: 0 }], ikTargets: [] } });
    await selectLayer(S);
    expect(command('rig.mirrorPose').enabled?.()).toBe(false);
  });
});

describe('the Rig panel hierarchy', () => {
  it('Shift-click extends the selection, a plain click replaces it', async () => {
    render(<BoneControls nodeId={L} />);
    const row = async (name: string): Promise<HTMLElement> => screen.findByRole('treeitem', { name });
    fireEvent.click(await row('Head'));
    fireEvent.click(await row('Chest'), { shiftKey: true });
    expect(useRigSelectionStore.getState().boneIds).toEqual(['head', 'chest']);
    expect((await row('Head')).getAttribute('aria-selected')).toBe('true');
    expect((await row('Chest')).getAttribute('aria-selected')).toBe('true');
    expect(useRigSelectionStore.getState().boneId).toBe('chest');
    fireEvent.click(await row('Hips'));
    expect(useRigSelectionStore.getState().boneIds).toEqual(['hips']);
  });
});

describe('the buttons', () => {
  it('Paste waits for a copy, then writes at the time the panel shows', async () => {
    await h.batch('pose', [key('head', 33, 1)]);
    const { rerender } = render(<RigPoseButtons nodeId={L} seconds={1} />);
    expect(await screen.findByRole('button', { name: 'Paste pose' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy pose' }));
    await act(async () => { await settleEdits(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    rerender(<RigPoseButtons nodeId={L} seconds={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Paste pose' }));
    await act(async () => { await settleEdits(); await new Promise((r) => setTimeout(r, 50)); await settleEdits(); });
    expect((await keysOf('bone.head.rotation')).map((k) => k.t)).toContain(2);
  });

  it('Mirror is off on a rig with no sides', async () => {
    const S = await rigTestLayer(h, { skeleton: { bones: [{ id: 'a', parentId: null, length: 50, x: 0, y: 0, rotation: 0 }], ikTargets: [] } });
    await selectLayer(S);
    render(<RigPoseButtons nodeId={S} seconds={0} />);
    expect(await screen.findByRole('button', { name: 'Mirror pose' })).toBeDisabled();
  });
});
