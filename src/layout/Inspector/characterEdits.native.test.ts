/**
 * Character rig (Tier 1) on the real engine: Rig Character makes one undo
 * entry that groups the layers, gives each a bone and binds it, without moving
 * anything; turning a bone moves its part; Detach keeps the part where it is.
 */
import { waitFor } from '@testing-library/react';
import { setupAppEngine, historyLabels, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import { useUIStore } from '@stores/uiStore';
import { rigCharacterEdit } from '@layout/Workspace/layerMenuEdits';
import { runToolTurn } from '@core/ai/aiTurn';
import { bindToBone } from './characterEdits';

let h: Harness;

async function rect(name: string, x: number, y: number): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name, init: [] });
  await h.run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x, y } } });
  return layer;
}

async function worldOf(layer: string): Promise<{ x: number; y: number }> {
  const res = await h.query({ type: 'getLayerTransforms', layers: [layer], time: 0 });
  const m = res.transforms[0]!.matrix;
  return { x: m[12]!, y: m[13]! };
}

beforeEach(async () => {
  h = await setupAppEngine();
  useRigSelectionStore.getState().clear();
});
afterEach(async () => { await h.dispose(); });

it('Rig Character: one undo entry, a bone per part, the legs in IK, nothing moves, the Bone tool in Pose mode', async () => {
  const torso = await rect('Torso', 400, 300);
  const thigh = await rect('Thigh R', 420, 420);
  const shin = await rect('Shin R', 420, 520);
  const before = await Promise.all([torso, thigh, shin].map(worldOf));
  useSelectionStore.getState().set([torso, thigh, shin]);

  await rigCharacterEdit('Pip');
  await settleEdits();

  const character = useSelectionStore.getState().ids[0]!;
  await waitFor(() => expect(documentMirror().layer(character)?.character).toBe(true));
  expect(documentMirror().layer(character)?.name).toBe('Pip');
  for (const part of [torso, thigh, shin]) {
    expect(documentMirror().layer(part)?.parent).toBe(character);
    expect(documentMirror().layer(part)?.parentBone).toBeTruthy();
  }
  const after = await Promise.all([torso, thigh, shin].map(worldOf));
  after.forEach((p, i) => {
    expect(p.x).toBeCloseTo(before[i]!.x, 6);
    expect(p.y).toBeCloseTo(before[i]!.y, 6);
  });
  const pose = await h.query({ type: 'getRigPose', layer: character, time: 0, points: [] });
  expect(pose.bones).toHaveLength(3);
  expect(pose.ik.map((g) => g.bone)).toEqual([documentMirror().layer(shin)!.parentBone]);
  expect((await historyLabels()).filter((l) => l === 'Rig Character')).toHaveLength(1);
  expect(useUIStore.getState().activeTool).toBe('bone');
  expect(useUIStore.getState().boneRigMode).toBe('pose');
  expect(useRigSelectionStore.getState().nodeId).toBe(character);
});

it('Rig Character hangs an upright arm from its top end (the shoulder), not the end nearest the torso centre', async () => {
  const turn = await runToolTurn('AI: parts', [
    { name: 'create_layer', args: { id: 'torso', kind: 'shape', name: 'Torso', x: 960, y: 470, width: 140, height: 220 } },
    { name: 'create_layer', args: { id: 'arm', kind: 'shape', name: 'Upper Arm L', x: 850, y: 430, width: 40, height: 130 } },
  ]);
  expect(turn.rolledBack).toBe(false);
  await settleEdits();
  const ids = turn.results.map((r) => (r as { data?: { id?: string } }).data?.id ?? '');
  const arm = ids.find((id) => documentMirror().layer(id)?.name === 'Upper Arm L')!;
  const torso = ids.find((id) => documentMirror().layer(id)?.name === 'Torso')!;
  useSelectionStore.getState().set([torso, arm]);
  await rigCharacterEdit('Pip');
  await settleEdits();
  const character = documentMirror().layer(arm)!.parent!;
  const g = await worldOf(character);
  const pose = await h.query({ type: 'getRigPose', layer: character, time: 0, points: [] });
  const bone = pose.bones.find((b) => b.id === documentMirror().layer(arm)!.parentBone)!;
  // world = [a, b, c, d, e, f]: (e, f) is the bone's base in the character's space.
  expect(g.x + bone.world[4]!).toBeCloseTo(850, 3);
  expect(g.y + bone.world[5]!).toBeCloseTo(430 - 65, 3);
});

it('Detach from Bone keeps the part where it stands', async () => {
  const torso = await rect('Torso', 400, 300);
  const arm = await rect('Arm L', 300, 300);
  useSelectionStore.getState().set([torso, arm]);
  await rigCharacterEdit('Pip');
  await settleEdits();
  const character = documentMirror().layer(arm)!.parent!;
  const before = await worldOf(arm);

  bindToBone([arm], character, null);
  await settleEdits();
  await waitFor(() => expect(documentMirror().layer(arm)?.parentBone).toBeUndefined());
  expect(documentMirror().layer(arm)?.parent).toBe(character);
  const after = await worldOf(arm);
  expect(after.x).toBeCloseTo(before.x, 6);
  expect(after.y).toBeCloseTo(before.y, 6);
});
