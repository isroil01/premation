/**
 * The controller section of the rig inspector must be REACHABLE and must write
 * through to the rig.
 *
 * A controller model with no way to create one is the failure this run was told
 * not to ship. The overlay draws whatever the rig holds, so without this section
 * the only way to get a controller is to hand-edit a document.
 */

import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { BoneControls } from './BoneControls';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { CONTROLLER_SHAPES, CONTROLLER_SIDES } from '@core/rig/controllers';
import type { SceneNode } from '@core/types';

const ID = 'ctrl_ui';

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

const rigOf = () => readNodeSkeleton(defaultSceneGraph.getNode(ID)!);
const controllersOf = () => rigOf()?.controllers ?? [];

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode(shapeNode(ID));
  defaultSceneGraph.setSkeleton(ID, {
    bones: [
      { id: 'upper', name: 'Upper', parentId: null, length: 60, x: -40, y: 0, rotation: 0 },
      { id: 'fore', name: 'Fore', parentId: 'upper', length: 60, x: 60, y: 0, rotation: 0 },
    ],
    ikTargets: [{ boneId: 'fore', x: 40, y: 10 }],
  });
});

afterEach(() => {
  cleanup();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
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

  it('adding writes a controller with the chosen link', () => {
    render(<BoneControls nodeId={ID} />);
    fireEvent.change(screen.getByLabelText('Add controller'), { target: { value: 'ikTarget:fore' } });
    expect(controllersOf()).toHaveLength(1);
    expect(controllersOf()[0]!.link).toEqual({ kind: 'ikTarget', boneId: 'fore' });
  });

  it('an FK add links to the bone, not to its goal', () => {
    // The two adds must not collapse into one meaning — this is the UI half of
    // the link-kind distinction the solver depends on.
    render(<BoneControls nodeId={ID} />);
    fireEvent.change(screen.getByLabelText('Add controller'), { target: { value: 'bone:upper' } });
    expect(controllersOf()[0]!.link).toEqual({ kind: 'bone', boneId: 'upper' });
  });

  it('exposes every shape and side the model defines', () => {
    // Subject sets derived from the model: adding a shape without a UI for it
    // fails here rather than shipping an unreachable option.
    render(<BoneControls nodeId={ID} />);
    fireEvent.change(screen.getByLabelText('Add controller'), { target: { value: 'bone:fore' } });
    cleanup();
    render(<BoneControls nodeId={ID} />);
    const name = controllersOf()[0]!.name ?? controllersOf()[0]!.id;
    const shapeSel = screen.getByLabelText(`${name} shape`) as HTMLSelectElement;
    const sideSel = screen.getByLabelText(`${name} side`) as HTMLSelectElement;
    expect(Array.from(shapeSel.options).map((o) => o.value)).toEqual([...CONTROLLER_SHAPES]);
    expect(Array.from(sideSel.options).map((o) => o.value)).toEqual([...CONTROLLER_SIDES]);
  });

  it('changing shape and side writes through to the rig', () => {
    render(<BoneControls nodeId={ID} />);
    fireEvent.change(screen.getByLabelText('Add controller'), { target: { value: 'bone:fore' } });
    cleanup();
    render(<BoneControls nodeId={ID} />);
    const name = controllersOf()[0]!.name ?? controllersOf()[0]!.id;
    fireEvent.change(screen.getByLabelText(`${name} shape`), { target: { value: 'square' } });
    fireEvent.change(screen.getByLabelText(`${name} side`), { target: { value: 'left' } });
    expect(controllersOf()[0]!.shape).toBe('square');
    expect(controllersOf()[0]!.side).toBe('left');
  });

  it('deletes from the list', () => {
    render(<BoneControls nodeId={ID} />);
    fireEvent.change(screen.getByLabelText('Add controller'), { target: { value: 'bone:fore' } });
    cleanup();
    render(<BoneControls nodeId={ID} />);
    const name = controllersOf()[0]!.name ?? controllersOf()[0]!.id;
    fireEvent.click(screen.getByLabelText(`Delete controller ${name}`));
    expect(controllersOf()).toHaveLength(0);
  });
});
