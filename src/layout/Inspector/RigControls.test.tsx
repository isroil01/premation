/**
 * PuppetControls / BoneControls — the Rigging inspector.
 *
 * These panels had no coverage. The behaviours worth guarding are the ones with
 * a unit or a threshold behind them: the radians↔degrees conversion on bone
 * rest angle (typing "45" once meant 45 RADIANS), the solver-quality disclosure
 * (§12.11), and the "0 = unlimited" sentinel on rotation refinement.
 *
 * The rig layer is a real layer on the APP's engine (B3z): the panels read the
 * rig from the document mirror and write through engine commands, so every
 * write is awaited (`idle`) before the document is read back.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { PuppetControls } from './PuppetControls';
import { BoneControls } from './BoneControls';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodePuppet } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { maxExactMeshDensity, SMOOTH_PLAYBACK_MAX_DENSITY } from '@core/rig/arap';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { rigTestLayer } from '@layout/Workspace/__testHelpers__/rigLayer';
import { useUIStore } from '@stores/uiStore';
import { useRigSelectionStore } from '@stores/rigSelectionStore';

let h: Awaited<ReturnType<typeof setupAppEngine>>;
/** The rig layer (engine-created). */
let L = '';

const rigOf = () => readNodePuppet(defaultSceneGraph.getNode(L)!);
const skelOf = () => readNodeSkeleton(defaultSceneGraph.getNode(L)!);
const idle = (): Promise<void> => act(async () => { await engineIdle(); });
const undo = (): Promise<void> => act(async () => { await h.run({ type: 'undo' }); });

/** Write a whole rig through the engine (setup, then a clean history). */
async function setRig(path: 'layer/puppet' | 'layer/skeleton', rig: unknown): Promise<void> {
  await h.run({ type: 'setProperty', prop: { layer: L, path }, value: { kind: 'json', value: JSON.stringify(rig) } });
  await idle();
  getCommandSystem().getHistory().clear();
}

/**
 * A ValueField rests as a `role="spinbutton"` and only swaps to an <input> once
 * Enter opens it — same helper shape as TransformSection.keyframe.test.tsx.
 */
function field(name: string): HTMLElement {
  return screen.getByRole('spinbutton', { name });
}

async function setField(name: string, value: string): Promise<void> {
  const el = field(name);
  fireEvent.keyDown(el, { key: 'Enter' });
  const input = el.querySelector('input');
  if (!input) throw new Error(`ValueField "${name}" did not open an input on Enter`);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await idle();
}

/** The displayed value of a resting ValueField. */
function fieldValue(name: string): number {
  return Number(field(name).getAttribute('aria-valuenow'));
}

async function pick(label: string, value: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await idle();
}

beforeEach(async () => {
  h = await setupAppEngine();
  L = await rigTestLayer(h);
  useUIStore.getState().setBoneRigMode('pose');
  useRigSelectionStore.getState().clear();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

describe('PuppetControls', () => {
  const withPins = (extra: Record<string, unknown> = {}) =>
    setRig('layer/puppet', {
      meshDensity: 15,
      meshExpansion: 8,
      pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0 }],
      ...extra,
    });

  it('reports the pin count', async () => {
    await withPins();
    const { getByText } = render(<PuppetControls nodeId={L} />);
    expect(getByText('1 pin')).toBeTruthy();
  });

  it('switching the solver persists it', async () => {
    await withPins();
    render(<PuppetControls nodeId={L} />);
    await pick('Puppet deform solver', 'lbs');
    expect(rigOf()!.solver).toBe('lbs');
  });

  it('switching the mesh mode persists it', async () => {
    await withPins();
    render(<PuppetControls nodeId={L} />);
    await pick('Puppet mesh mode', 'silhouette');
    expect(rigOf()!.meshMode).toBe('silhouette');
  });

  // ── Pin type (bend pins) ────────────────────────────────────────────
  // The solver can do everything a bend pin needs and still ship nothing a
  // user can reach: `kind` has no default UI anywhere else, so without this
  // control the whole feature is unreachable from the app.

  it('lists After Effects pin types, defaulting to advanced', async () => {
    await withPins();
    const { getByLabelText } = render(<PuppetControls nodeId={L} />);
    const select = getByLabelText('Pin 1 pin type') as HTMLSelectElement;
    expect(select.value).toBe('advanced');
    expect([...select.options].map((o) => o.value)).toEqual([
      'position', 'starch', 'bend', 'advanced', 'overlap',
    ]);
  });

  it('switching a pin to bend persists it', async () => {
    await withPins();
    render(<PuppetControls nodeId={L} />);
    await pick('Pin 1 pin type', 'bend');
    expect(rigOf()!.pins[0]!.kind).toBe('bend');
  });

  it('switching back to advanced persists that too', async () => {
    await withPins({ pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0, kind: 'bend' }] });
    const { getByLabelText } = render(<PuppetControls nodeId={L} />);
    expect((getByLabelText('Pin 1 pin type') as HTMLSelectElement).value).toBe('bend');
    await pick('Pin 1 pin type', 'advanced');
    expect(rigOf()!.pins[0]!.kind).toBe('advanced');
  });

  it('explains what a bend pin does, but only when one is selected', async () => {
    // The rotation/scale fields look identical on both kinds, and on a bend pin
    // they mean something different. Showing the note unconditionally would
    // train people to ignore it.
    await withPins();
    const plain = render(<PuppetControls nodeId={L} />);
    expect(plain.container.textContent).not.toMatch(/derived from the advanced pins/i);
    plain.unmount();

    await withPins({ pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0, kind: 'bend' }] });
    const bend = render(<PuppetControls nodeId={L} />);
    expect(bend.container.textContent).toMatch(/derived from the advanced pins/i);
  });

  it('shows the exact-solve threshold, and lowers it when a pin has stiffness', async () => {
    await withPins();
    const plain = render(<PuppetControls nodeId={L} />);
    expect(plain.getByText(`(exact ≤ ${maxExactMeshDensity(false)} · fast ≤ ${SMOOTH_PLAYBACK_MAX_DENSITY})`)).toBeTruthy();
    plain.unmount();

    await setRig('layer/puppet', {
      meshDensity: 15,
      meshExpansion: 8,
      pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0, stiffness: 2 }],
    });
    const stiff = render(<PuppetControls nodeId={L} />);
    expect(stiff.getByText(`(exact ≤ ${maxExactMeshDensity(true)} · fast ≤ ${SMOOTH_PLAYBACK_MAX_DENSITY})`)).toBeTruthy();
  });

  const notes = (r: ReturnType<typeof render>) =>
    r.queryAllByRole('note').map((n) => n.textContent ?? '');

  it('is silent at a density that is both exact and fast', async () => {
    await withPins({ meshDensity: 20 });
    expect(notes(render(<PuppetControls nodeId={L} />))).toHaveLength(0);
  });

  it('warns about COST before it warns about exactness', async () => {
    // The two thresholds differ (fast <= 25, exact <= 33). Density 30 is still
    // exact but already expensive — conflating them would leave this silent and
    // let the "exact" marker read as a recommendation.
    await withPins({ meshDensity: 30 });
    const n = notes(render(<PuppetControls nodeId={L} />));
    expect(n.some((t) => /heavy to solve/.test(t))).toBe(true);
    expect(n.some((t) => /falls\s+back/.test(t))).toBe(false);
  });

  it('warns about BOTH past the exact threshold (§12.11)', async () => {
    await withPins({ meshDensity: 45 });
    const n = notes(render(<PuppetControls nodeId={L} />));
    expect(n.some((t) => /heavy to solve/.test(t))).toBe(true);
    expect(n.some((t) => /falls\s+back/.test(t))).toBe(true);
  });

  it('does not warn for the LBS solver, which has neither cliff', async () => {
    await withPins({ meshDensity: 45, solver: 'lbs' });
    expect(notes(render(<PuppetControls nodeId={L} />))).toHaveLength(0);
  });

  it('rotation refinement treats 0 as "unlimited" (stored as undefined)', async () => {
    await withPins({ maxRotationDeg: 30 });
    render(<PuppetControls nodeId={L} />);
    await setField('Mesh rotation refinement', '0');
    expect(rigOf()!.maxRotationDeg).toBeUndefined();
  });

  it('per-pin scale persists on an advanced pin', async () => {
    await withPins();
    render(<PuppetControls nodeId={L} />);
    await setField('Pin 1 scale', '1.5');
    expect(rigOf()!.pins[0]!.scale).toBeCloseTo(1.5, 5);
  });

  it('per-pin overlap persists on an overlap pin', async () => {
    await withPins();
    render(<PuppetControls nodeId={L} />);
    await pick('Pin 1 pin type', 'overlap');
    await setField('Pin 1 overlap', '40');
    expect(rigOf()!.pins[0]!.overlap).toBeCloseTo(40, 5);
  });

  it('overlap 0 clears the value rather than storing a no-op', async () => {
    await withPins({ pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0, kind: 'overlap', overlap: 40 }] });
    render(<PuppetControls nodeId={L} />);
    await setField('Pin 1 overlap', '40');
    await setField('Pin 1 overlap', '0');
    expect(rigOf()!.pins[0]!.overlap).toBeUndefined();
  });
});

describe('BoneControls', () => {
  const ONE_BONE = { id: 'bone_1', name: 'Upper', parentId: null, length: 50, x: 0, y: 0, rotation: 0 };
  const withBones = (bone: Record<string, unknown> = {}) =>
    setRig('layer/skeleton', { bones: [{ ...ONE_BONE, ...bone }], ikTargets: [] });

  it('reports the bone count', async () => {
    await withBones();
    const { getByText } = render(<BoneControls nodeId={L} />);
    expect(getByText('1 bone')).toBeTruthy();
  });

  it('renames a bone on commit — ONE undo entry, and undo restores the name', async () => {
    await withBones();
    const { getByLabelText } = render(<BoneControls nodeId={L} />);
    const input = getByLabelText('Upper name') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'Shoulder' } });
    fireEvent.change(input, { target: { value: 'Shoulders' } });
    // Typing edits a draft; nothing is written per keystroke.
    expect(skelOf()!.bones[0]!.name).toBe('Upper');
    fireEvent.keyDown(input, { key: 'Enter' });
    await idle();
    expect(skelOf()!.bones[0]!.name).toBe('Shoulders');
    expect(historyLabels()).toEqual(['Rename Bone']);
    await undo();
    expect(skelOf()!.bones[0]!.name).toBe('Upper');
  });

  it('Escape abandons a rename', async () => {
    await withBones();
    const { getByLabelText } = render(<BoneControls nodeId={L} />);
    const input = getByLabelText('Upper name') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'Oops' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await idle();
    expect(skelOf()!.bones[0]!.name).toBe('Upper');
    expect(historyLabels()).toEqual([]);
  });

  it('clearing the name falls back to the id rather than storing empty', async () => {
    await withBones();
    const { getByLabelText } = render(<BoneControls nodeId={L} />);
    const input = getByLabelText('Upper name');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await idle();
    expect(skelOf()!.bones[0]!.name).toBeUndefined();
  });

  it('Rest Angle converts DEGREES to radians (typing 45 must not mean 45 rad)', async () => {
    await withBones();
    render(<BoneControls nodeId={L} />);
    await setField('Upper rotation', '45');
    // The store is radians; 45° ≈ 0.7854 rad. Storing 45 would fold the limb
    // into itself — the bug this conversion was added for.
    expect(skelOf()!.bones[0]!.rotation).toBeCloseTo(Math.PI / 4, 5);
    // A rig-mode edit: the bind pose (what the skin is bound to) moves with it.
    expect(skelOf()!.bindPose?.find((b) => b.id === 'bone_1')?.rotation).toBeCloseTo(Math.PI / 4, 5);
    expect(historyLabels()).toEqual(['Set Bone Rest Angle']);
    await undo();
    expect(skelOf()!.bones[0]!.rotation).toBe(0);
    expect(skelOf()!.bindPose).toBeUndefined();
  });

  it('Rest Angle displays the stored radians AS degrees', async () => {
    await withBones({ rotation: Math.PI / 2 });
    render(<BoneControls nodeId={L} />);
    expect(fieldValue('Upper rotation')).toBeCloseTo(90, 3);
  });

  it('bone scale persists', async () => {
    await withBones();
    render(<BoneControls nodeId={L} />);
    await setField('Upper scale x', '2');
    expect(skelOf()!.bones[0]!.scaleX).toBeCloseTo(2, 5);
    expect(skelOf()!.bones[0]!.scaleY ?? 1).toBeCloseTo(1, 5);
    expect(historyLabels()).toEqual(['Set Bone Scale']);
  });

  it('Rest Length and Falloff write the bone; Falloff 0 means unlimited (cleared)', async () => {
    await withBones({ influenceRadius: 30 });
    render(<BoneControls nodeId={L} />);
    await setField('Upper length', '80');
    expect(skelOf()!.bones[0]!.length).toBe(80);
    await setField('Upper influence radius', '0');
    expect(skelOf()!.bones[0]!.influenceRadius).toBeUndefined();
    expect(historyLabels()).toEqual(['Set Bone Length', 'Set Bone Falloff']);
    await undo();
    expect(skelOf()!.bones[0]!.influenceRadius).toBe(30);
  });

  it('a scrub of Rest Length is ONE undo entry, and undo restores the length', async () => {
    await withBones();
    render(<BoneControls nodeId={L} />);
    const pointer = (type: string, x: number, target: EventTarget = window): void => {
      act(() => {
        target.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
          clientX: x, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        }));
      });
    };
    pointer('pointerdown', 0, field('Upper length'));
    for (const x of [10, 20, 30, 40]) pointer('pointermove', x);
    pointer('pointerup', 40);
    await idle();
    expect(skelOf()!.bones[0]!.length).toBeGreaterThan(50);
    expect(historyLabels()).toEqual(['Set Bone Length']);
    await undo();
    expect(skelOf()!.bones[0]!.length).toBe(50);
  });

  it('enabling IK adds a target, and the pole button then appears', async () => {
    await withBones();
    const { getByText, queryByText } = render(<BoneControls nodeId={L} />);
    expect(queryByText('Add Pole')).toBeNull();
    fireEvent.click(getByText('Enable IK Target'));
    await idle();
    expect(skelOf()!.ikTargets).toHaveLength(1);
    // At the chain's effector: the bone's tip.
    expect(skelOf()!.ikTargets![0]).toMatchObject({ boneId: 'bone_1', x: 50, y: 0 });
    expect(getByText('Add Pole')).toBeTruthy();
    expect(historyLabels()).toEqual(['Enable IK Target']);
  });

  it('the IK button toggles the goal off again, and undo brings it back', async () => {
    await setRig('layer/skeleton', { bones: [ONE_BONE], ikTargets: [{ boneId: 'bone_1', x: 10, y: 20, chainLength: 1 }] });
    const { getByText } = render(<BoneControls nodeId={L} />);
    fireEvent.click(getByText('IK Active'));
    await idle();
    expect(skelOf()!.ikTargets).toHaveLength(0);
    await undo();
    expect(skelOf()!.ikTargets).toEqual([{ boneId: 'bone_1', x: 10, y: 20, chainLength: 1 }]);
  });

  it('pole, chain length and goal edit the IK goal, one entry each', async () => {
    await setRig('layer/skeleton', { bones: [ONE_BONE], ikTargets: [{ boneId: 'bone_1', x: 10, y: 20 }] });
    const { getByText } = render(<BoneControls nodeId={L} />);
    fireEvent.click(getByText('Add Pole'));
    await idle();
    expect(skelOf()!.ikTargets![0]!.pole).toBeDefined();
    await setField('Upper IK chain length', '3');
    expect(skelOf()!.ikTargets![0]!.chainLength).toBe(3);
    await setField('Upper IK goal x', '42');
    expect(skelOf()!.ikTargets![0]).toMatchObject({ x: 42, y: 20 });
    fireEvent.click(getByText('Remove'));
    await idle();
    expect(skelOf()!.ikTargets![0]!.pole).toBeUndefined();
    expect(historyLabels()).toEqual(['Add Pole', 'Set IK Chain Length', 'Set IK Goal', 'Remove Pole']);
  });

  it('deleting a bone is one entry; undo restores it', async () => {
    await withBones();
    render(<BoneControls nodeId={L} />);
    const before = h.doc();
    fireEvent.click(screen.getByLabelText('Delete bone Upper'));
    await idle();
    expect(skelOf()!.bones).toHaveLength(0);
    expect(historyLabels()).toEqual(['Delete Bone']);
    await undo();
    expect(h.doc()).toEqual(before);
  });

  it('the skinning mesh settings write the skeleton', async () => {
    await withBones();
    act(() => useUIStore.getState().setBoneRigMode('weights'));
    render(<BoneControls nodeId={L} />);
    await setField('Skinning mesh density', '12');
    await pick('Skinning mesh mode', 'silhouette');
    await setField('Skinning mesh expansion', '4');
    expect(skelOf()).toMatchObject({ meshDensity: 12, meshMode: 'silhouette', meshExpansion: 4 });
    expect(historyLabels()).toEqual(['Edit Skeleton Mesh', 'Edit Skeleton Mesh', 'Edit Skeleton Mesh']);
  });

  it('Auto-Rig replaces the rig in ONE entry', async () => {
    await withBones();
    render(<BoneControls nodeId={L} />);
    await pick('Auto-rig preset', 'biped');
    expect(skelOf()!.bones.length).toBeGreaterThan(1);
    expect(skelOf()!.bones.some((b) => b.id === 'bone_1')).toBe(false);
    expect(historyLabels()).toHaveLength(1);
    expect(historyLabels()[0]).toMatch(/^Auto-Rig /);
    await undo();
    expect(skelOf()!.bones.map((b) => b.id)).toEqual(['bone_1']);
  });

  it('hides the standalone skinning-mesh card when a puppet rig owns the mesh', async () => {
    await withBones();
    act(() => useUIStore.getState().setBoneRigMode('weights'));
    const plain = render(<BoneControls nodeId={L} />);
    expect(plain.queryByRole('spinbutton', { name: 'Skinning mesh density' })).not.toBeNull();
    plain.unmount();

    await setRig('layer/puppet', { pins: [{ id: 'p', name: 'p', x: 0, y: 0 }] });
    const shared = render(<BoneControls nodeId={L} />);
    expect(shared.queryByRole('spinbutton', { name: 'Skinning mesh density' })).toBeNull();
    expect(shared.getByText(/the two rigs compose/i)).toBeTruthy();
  });
});
