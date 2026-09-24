/**
 * The controller section of the rig inspector must be REACHABLE and must write
 * through to the rig.
 *
 * A controller model with no way to create one is the failure this run was told
 * not to ship. The overlay draws whatever the rig holds, so without this section
 * the only way to get a controller is to hand-edit a document.
 *
 * ## Reachability resolved
 *
 * This file used to record that the section could not be surfaced in the probe
 * view. The cause was a misreading, not a limitation: Rigging is a separate
 * registered PANEL (`rig`), not a section of the Properties inspector, so the
 * probe was reading the wrong tab. Open it with
 * `useLayoutStore.getState().openPanel('rig')` — verified on this branch, where
 * the rig panel and its controls were driven through the real UI.
 *
 * These tests still only prove BEHAVIOUR; the app is what proves reachability.
 */

import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { BoneControls } from './BoneControls';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { CONTROLLER_SHAPES, CONTROLLER_SIDES } from '@core/rig/controllers';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { rigTestLayer } from '@layout/Workspace/__testHelpers__/rigLayer';
import { useUIStore } from '@stores/uiStore';

let h: Awaited<ReturnType<typeof setupAppEngine>>;
/** The rig layer (engine-created). */
let ID = '';

const rigOf = () => readNodeSkeleton(defaultSceneGraph.getNode(ID)!);
const controllersOf = () => rigOf()?.controllers ?? [];
const idle = (): Promise<void> => act(async () => { await engineIdle(); });
const undo = (): Promise<void> => act(async () => { await h.run({ type: 'undo' }); });

async function addController(value: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('Add controller'), { target: { value } });
  await idle();
}

beforeEach(async () => {
  h = await setupAppEngine();
  ID = await rigTestLayer(h);
  const rig = {
    bones: [
      { id: 'upper', name: 'Upper', parentId: null, length: 60, x: -40, y: 0, rotation: 0 },
      { id: 'fore', name: 'Fore', parentId: 'upper', length: 60, x: 60, y: 0, rotation: 0 },
    ],
    ikTargets: [{ boneId: 'fore', x: 40, y: 10 }],
  };
  await h.run({ type: 'setProperty', prop: { layer: ID, path: 'layer/skeleton' }, value: { kind: 'json', value: JSON.stringify(rig) } });
  await idle();
  getCommandSystem().getHistory().clear();
  useUIStore.setState({ boneRigMode: 'pose' });
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

describe('the Controllers section', () => {
  it('offers an add control once a skeleton has bones', () => {
    render(<BoneControls nodeId={ID} />);
    expect(screen.getByLabelText('Add controller')).toBeTruthy();
  });

  it('lists one option per bone (FK) and per IK goal — derived from the rig, not hard-coded', () => {
    render(<BoneControls nodeId={ID} />);
    const sel = screen.getByLabelText('Add controller') as HTMLSelectElement;
    const values = Array.from(sel.options).map((o) => o.value).filter(Boolean);
    const rig = rigOf()!;
    const expected = [
      ...rig.bones.map((b) => `bone:${b.id}`),
      ...(rig.ikTargets ?? []).map((t) => `ikTarget:${t.boneId}`),
    ];
    expect(values).toEqual(expected);
  });

  it('adding writes a controller with the chosen link — ONE entry, undone as one', async () => {
    render(<BoneControls nodeId={ID} />);
    await addController('ikTarget:fore');
    expect(controllersOf()).toHaveLength(1);
    expect(controllersOf()[0]!.link).toEqual({ kind: 'ikTarget', boneId: 'fore' });
    // The model's defaults: an IK goal's handle is a circle, named after its bone.
    expect(controllersOf()[0]).toMatchObject({ shape: 'circle', name: 'Fore' });
    expect(historyLabels()).toEqual(['Add Controller']);
    await undo();
    expect(controllersOf()).toHaveLength(0);
  });

  it('an FK add links to the bone, not to its goal', async () => {
    // The two adds must not collapse into one meaning — this is the UI half of
    // the link-kind distinction the solver depends on.
    render(<BoneControls nodeId={ID} />);
    await addController('bone:upper');
    expect(controllersOf()[0]!.link).toEqual({ kind: 'bone', boneId: 'upper' });
  });

  it('exposes every shape and side the model defines', async () => {
    // Subject sets derived from the model: adding a shape without a UI for it
    // fails here rather than shipping an unreachable option.
    render(<BoneControls nodeId={ID} />);
    await addController('bone:fore');
    const name = controllersOf()[0]!.name ?? controllersOf()[0]!.id;
    const shapeSel = screen.getByLabelText(`${name} shape`) as HTMLSelectElement;
    const sideSel = screen.getByLabelText(`${name} side`) as HTMLSelectElement;
    expect(Array.from(shapeSel.options).map((o) => o.value)).toEqual([...CONTROLLER_SHAPES]);
    expect(Array.from(sideSel.options).map((o) => o.value)).toEqual([...CONTROLLER_SIDES]);
  });

  it('changing shape, side and size writes through to the rig, one entry each', async () => {
    render(<BoneControls nodeId={ID} />);
    await addController('bone:fore');
    const name = controllersOf()[0]!.name ?? controllersOf()[0]!.id;
    getCommandSystem().getHistory().clear();
    fireEvent.change(screen.getByLabelText(`${name} shape`), { target: { value: 'square' } });
    await idle();
    fireEvent.change(screen.getByLabelText(`${name} side`), { target: { value: 'left' } });
    await idle();
    const size = screen.getByRole('spinbutton', { name: `${name} size` });
    fireEvent.keyDown(size, { key: 'Enter' });
    const input = size.querySelector('input')!;
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await idle();
    expect(controllersOf()[0]).toMatchObject({ shape: 'square', side: 'left', size: 30 });
    expect(historyLabels()).toEqual(['Set Controller Shape', 'Set Controller Side', 'Set Controller Size']);
    await undo();
    expect(controllersOf()[0]!.size).not.toBe(30);
    expect(controllersOf()[0]!.side).toBe('left');
  });

  it('deletes from the list', async () => {
    render(<BoneControls nodeId={ID} />);
    await addController('bone:fore');
    const name = controllersOf()[0]!.name ?? controllersOf()[0]!.id;
    fireEvent.click(screen.getByLabelText(`Delete controller ${name}`));
    await idle();
    expect(controllersOf()).toHaveLength(0);
    expect(historyLabels()).toEqual(['Add Controller', 'Delete Controller']);
    await undo();
    expect(controllersOf()).toHaveLength(1);
  });
});
