/**
 * PuppetControls / BoneControls — the Rigging inspector.
 *
 * These panels had no coverage. The behaviours worth guarding are the ones with
 * a unit or a threshold behind them: the radians↔degrees conversion on bone
 * rest angle (typing "45" once meant 45 RADIANS), the solver-quality disclosure
 * (§12.11), and the "0 = unlimited" sentinel on rotation refinement.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { PuppetControls } from './PuppetControls';
import { BoneControls } from './BoneControls';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodePuppet } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { maxExactMeshDensity, SMOOTH_PLAYBACK_MAX_DENSITY } from '@core/rig/arap';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, width: 200, height: 160 },
      },
    ],
  } as unknown as SceneNode;
}

const rigOf = () => readNodePuppet(defaultSceneGraph.getNode('n1')!);
const skelOf = () => readNodeSkeleton(defaultSceneGraph.getNode('n1')!);

/**
 * A ValueField rests as a `role="spinbutton"` and only swaps to an <input> once
 * Enter opens it — same helper shape as TransformSection.keyframe.test.tsx.
 */
function field(name: string): HTMLElement {
  return screen.getByRole('spinbutton', { name });
}

function setField(name: string, value: string): void {
  const el = field(name);
  fireEvent.keyDown(el, { key: 'Enter' });
  const input = el.querySelector('input');
  if (!input) throw new Error(`ValueField "${name}" did not open an input on Enter`);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** The displayed value of a resting ValueField. */
function fieldValue(name: string): number {
  return Number(field(name).getAttribute('aria-valuenow'));
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  try { defaultSceneGraph.removeNode('n1'); } catch { /* fresh */ }
  defaultSceneGraph.addNode(shapeNode('n1'));
});

describe('PuppetControls', () => {
  const withPins = (extra: Record<string, unknown> = {}) =>
    defaultSceneGraph.setPuppet('n1', {
      meshDensity: 15,
      meshExpansion: 8,
      pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0 }],
      ...extra,
    });

  it('reports the pin count', () => {
    withPins();
    const { getByText } = render(<PuppetControls nodeId="n1" />);
    expect(getByText('1 pins')).toBeTruthy();
  });

  it('switching the solver persists it', () => {
    withPins();
    const { getByLabelText } = render(<PuppetControls nodeId="n1" />);
    fireEvent.change(getByLabelText('Puppet deform solver'), { target: { value: 'lbs' } });
    expect(rigOf()!.solver).toBe('lbs');
  });

  it('switching the mesh mode persists it', () => {
    withPins();
    const { getByLabelText } = render(<PuppetControls nodeId="n1" />);
    fireEvent.change(getByLabelText('Puppet mesh mode'), { target: { value: 'silhouette' } });
    expect(rigOf()!.meshMode).toBe('silhouette');
  });

  // ── Pin type (bend pins) ────────────────────────────────────────────
  // The solver can do everything a bend pin needs and still ship nothing a
  // user can reach: `kind` has no default UI anywhere else, so without this
  // control the whole feature is unreachable from the app.

  it('offers a pin-type control, defaulting to advanced', () => {
    withPins();
    const { getByLabelText } = render(<PuppetControls nodeId="n1" />);
    expect((getByLabelText('Pin 1 pin type') as HTMLSelectElement).value).toBe('advanced');
  });

  it('switching a pin to bend persists it', () => {
    withPins();
    const { getByLabelText } = render(<PuppetControls nodeId="n1" />);
    fireEvent.change(getByLabelText('Pin 1 pin type'), { target: { value: 'bend' } });
    expect(rigOf()!.pins[0]!.kind).toBe('bend');
  });

  it('switching back to advanced persists that too', () => {
    withPins({ pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0, kind: 'bend' }] });
    const { getByLabelText } = render(<PuppetControls nodeId="n1" />);
    expect((getByLabelText('Pin 1 pin type') as HTMLSelectElement).value).toBe('bend');
    fireEvent.change(getByLabelText('Pin 1 pin type'), { target: { value: 'advanced' } });
    expect(rigOf()!.pins[0]!.kind).toBe('advanced');
  });

  it('explains what a bend pin does, but only when one is selected', () => {
    // The rotation/scale fields look identical on both kinds, and on a bend pin
    // they mean something different. Showing the note unconditionally would
    // train people to ignore it.
    withPins();
    const plain = render(<PuppetControls nodeId="n1" />);
    expect(plain.container.textContent).not.toMatch(/derived from the advanced pins/i);
    plain.unmount();

    withPins({ pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0, kind: 'bend' }] });
    const bend = render(<PuppetControls nodeId="n1" />);
    expect(bend.container.textContent).toMatch(/derived from the advanced pins/i);
  });

  it('shows the exact-solve threshold, and lowers it when a pin has stiffness', () => {
    withPins();
    const plain = render(<PuppetControls nodeId="n1" />);
    expect(plain.getByText(`(exact ≤ ${maxExactMeshDensity(false)} · fast ≤ ${SMOOTH_PLAYBACK_MAX_DENSITY})`)).toBeTruthy();
    plain.unmount();

    defaultSceneGraph.setPuppet('n1', {
      meshDensity: 15,
      meshExpansion: 8,
      pins: [{ id: 'pin_1', name: 'Pin 1', x: 0, y: 0, stiffness: 2 }],
    });
    const stiff = render(<PuppetControls nodeId="n1" />);
    expect(stiff.getByText(`(exact ≤ ${maxExactMeshDensity(true)} · fast ≤ ${SMOOTH_PLAYBACK_MAX_DENSITY})`)).toBeTruthy();
  });

  const notes = (r: ReturnType<typeof render>) =>
    r.queryAllByRole('note').map((n) => n.textContent ?? '');

  it('is silent at a density that is both exact and fast', () => {
    withPins({ meshDensity: 20 });
    expect(notes(render(<PuppetControls nodeId="n1" />))).toHaveLength(0);
  });

  it('warns about COST before it warns about exactness', () => {
    // The two thresholds differ (fast <= 25, exact <= 33). Density 30 is still
    // exact but already expensive — conflating them would leave this silent and
    // let the "exact" marker read as a recommendation.
    withPins({ meshDensity: 30 });
    const n = notes(render(<PuppetControls nodeId="n1" />));
    expect(n.some((t) => /heavy to solve/.test(t))).toBe(true);
    expect(n.some((t) => /falls\s+back/.test(t))).toBe(false);
  });

  it('warns about BOTH past the exact threshold (§12.11)', () => {
    withPins({ meshDensity: 45 });
    const n = notes(render(<PuppetControls nodeId="n1" />));
    expect(n.some((t) => /heavy to solve/.test(t))).toBe(true);
    expect(n.some((t) => /falls\s+back/.test(t))).toBe(true);
  });

  it('does not warn for the LBS solver, which has neither cliff', () => {
    withPins({ meshDensity: 45, solver: 'lbs' });
    expect(notes(render(<PuppetControls nodeId="n1" />))).toHaveLength(0);
  });

  it('rotation refinement treats 0 as "unlimited" (stored as undefined)', () => {
    withPins({ maxRotationDeg: 30 });
    render(<PuppetControls nodeId="n1" />);
    setField('Mesh rotation refinement', '0');
    expect(rigOf()!.maxRotationDeg).toBeUndefined();
  });

  it('per-pin scale and overlap persist', () => {
    withPins();
    render(<PuppetControls nodeId="n1" />);
    setField('Pin 1 scale', '1.5');
    expect(rigOf()!.pins[0]!.scale).toBeCloseTo(1.5, 5);
    setField('Pin 1 overlap', '40');
    expect(rigOf()!.pins[0]!.overlap).toBeCloseTo(40, 5);
  });

  it('overlap 0 clears the value rather than storing a no-op', () => {
    withPins();
    render(<PuppetControls nodeId="n1" />);
    setField('Pin 1 overlap', '40');
    setField('Pin 1 overlap', '0');
    expect(rigOf()!.pins[0]!.overlap).toBeUndefined();
  });
});

describe('BoneControls', () => {
  const withBones = () =>
    defaultSceneGraph.setSkeleton('n1', {
      bones: [
        { id: 'bone_1', name: 'Upper', parentId: null, length: 50, x: 0, y: 0, rotation: 0 },
      ],
      ikTargets: [],
    });

  it('reports the bone count', () => {
    withBones();
    const { getByText } = render(<BoneControls nodeId="n1" />);
    expect(getByText('1 bones')).toBeTruthy();
  });

  it('renames a bone', () => {
    withBones();
    const { getByLabelText } = render(<BoneControls nodeId="n1" />);
    fireEvent.change(getByLabelText('Upper name'), { target: { value: 'Shoulder' } });
    expect(skelOf()!.bones[0]!.name).toBe('Shoulder');
  });

  it('clearing the name falls back to the id rather than storing empty', () => {
    withBones();
    const { getByLabelText } = render(<BoneControls nodeId="n1" />);
    fireEvent.change(getByLabelText('Upper name'), { target: { value: '' } });
    expect(skelOf()!.bones[0]!.name).toBeUndefined();
  });

  it('Rest Angle converts DEGREES to radians (typing 45 must not mean 45 rad)', () => {
    withBones();
    render(<BoneControls nodeId="n1" />);
    setField('Upper rotation', '45');
    // The store is radians; 45° ≈ 0.7854 rad. Storing 45 would fold the limb
    // into itself — the bug this conversion was added for.
    expect(skelOf()!.bones[0]!.rotation).toBeCloseTo(Math.PI / 4, 5);
  });

  it('Rest Angle displays the stored radians AS degrees', () => {
    defaultSceneGraph.setSkeleton('n1', {
      bones: [{ id: 'bone_1', name: 'Upper', parentId: null, length: 50, x: 0, y: 0, rotation: Math.PI / 2 }],
      ikTargets: [],
    });
    render(<BoneControls nodeId="n1" />);
    expect(fieldValue('Upper rotation')).toBeCloseTo(90, 3);
  });

  it('bone scale persists', () => {
    withBones();
    render(<BoneControls nodeId="n1" />);
    setField('Upper scale x', '2');
    expect(skelOf()!.bones[0]!.scaleX).toBeCloseTo(2, 5);
  });

  it('enabling IK adds a target, and the pole button then appears', () => {
    withBones();
    const { getByText, queryByText } = render(<BoneControls nodeId="n1" />);
    expect(queryByText('Add Pole')).toBeNull();
    fireEvent.click(getByText('Enable IK Target'));
    expect(skelOf()!.ikTargets).toHaveLength(1);
  });

  it('hides the standalone skinning-mesh card when a puppet rig owns the mesh', () => {
    withBones();
    const plain = render(<BoneControls nodeId="n1" />);
    expect(plain.queryByRole('spinbutton', { name: 'Skinning mesh density' })).not.toBeNull();
    plain.unmount();

    defaultSceneGraph.setPuppet('n1', { pins: [{ id: 'p', name: 'p', x: 0, y: 0 }] });
    const shared = render(<BoneControls nodeId="n1" />);
    expect(shared.queryByRole('spinbutton', { name: 'Skinning mesh density' })).toBeNull();
    expect(shared.getByText(/the two rigs compose/i)).toBeTruthy();
  });
});
