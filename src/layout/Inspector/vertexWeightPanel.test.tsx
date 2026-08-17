/**
 * The numeric weight editor is REACHABLE and DRIVEN — the Rigging panel half.
 *
 * `vertexWeightEdit.test.ts` proves `setVertexWeight` is right. It calls the
 * function directly, so it passes in full on a build where no UI reaches it —
 * the F29 shape, and exactly what an unwired panel looks like from the inside.
 * This file watches the other half: that picking a vertex produces editable
 * numbers in `BoneControls`, and that driving one of those fields changes the
 * weights the renderer skins with.
 *
 * ## What is read back
 *
 * `aria-valuenow` and `aria-valuetext` off the rendered spinbutton, and the
 * stored rig off the scene graph. Never the JSX, and never `innerText`.
 *
 * ## The subject vertex is DERIVED
 *
 * A hardcoded index would be a guess about mesh topology that silently stops
 * being a multi-influence vertex the first time the density default changes.
 * The suite finds the first vertex with more than one influence and asserts one
 * exists, which is also the positive control for the fixture being a real rig.
 */

import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { BoneControls } from './BoneControls';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { clearRestMeshCache } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { nodeRestMesh } from '@core/rig/rigMeshInputs';
import { getSkeletonBinding } from '@core/rig/rigDeform';
import { readGeometry } from '@core/workspace/geometry';
import { selectRigVertex, clearRigVertex } from '@stores/rigVertexStore';
import { useUIStore } from '@stores/uiStore';
import type { VertexWeight } from '@core/rig/skinning';
import type { SceneNode } from '@core/types';

const ID = 'vw_node';

const TWO_BONES = [
  { id: 'upper', name: 'Upper', parentId: null, length: 60, x: -70, y: 0, rotation: 0 },
  { id: 'fore', name: 'Fore', parentId: 'upper', length: 60, x: 60, y: 0, rotation: 0 },
];

function addNode(): void {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${ID}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, width: 240, height: 160 },
      },
    ],
  } as unknown as SceneNode);
}

function setBones(bones: typeof TWO_BONES): void {
  defaultSceneGraph.setSkeleton(ID, {
    bones, ikTargets: [], meshDensity: 8, meshExpansion: 0,
  } as never);
}

/** The binding the panel itself will build — same mesh assembly, by construction. */
function influencesAt(vertexIndex: number): VertexWeight[] {
  const node = defaultSceneGraph.getNode(ID)!;
  const geom = readGeometry(node)!;
  const mesh = nodeRestMesh(node, geom, () => undefined);
  const skel = readNodeSkeleton(node);
  return getSkeletonBinding(mesh, skel?.bones ?? [], skel?.weightPaint).weights[vertexIndex] ?? [];
}

/** First vertex reached by more than one bone. Derived, not guessed. */
function findMultiInfluenceVertex(): number {
  const node = defaultSceneGraph.getNode(ID)!;
  const geom = readGeometry(node)!;
  const mesh = nodeRestMesh(node, geom, () => undefined);
  const skel = readNodeSkeleton(node);
  const binding = getSkeletonBinding(mesh, skel?.bones ?? [], skel?.weightPaint);
  for (let i = 0; i < binding.weights.length; i++) {
    if ((binding.weights[i] ?? []).length > 1) return i;
  }
  return -1;
}

const spinbuttons = (c: HTMLElement): HTMLElement[] =>
  [...c.querySelectorAll('[role="spinbutton"][aria-label]')] as HTMLElement[];

const weightFields = (c: HTMLElement): HTMLElement[] =>
  spinbuttons(c).filter((el) => /weight at vertex/.test(el.getAttribute('aria-label') ?? ''));

const entryCount = (): number => getCommandSystem().getHistory().getEntries().length;

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.clear();
  clearRestMeshCache();
  clearRigVertex();
  useUIStore.setState({ boneRigMode: 'weights' });
  addNode();
  setBones(TWO_BONES);
  useSelectionStore.getState().set([ID]);
});

afterEach(() => {
  cleanup();
  clearRigVertex();
});

describe('the fixture is a real rig', () => {
  it('POSITIVE CONTROL: some vertex has more than one influence', () => {
    // Without this, every "editable field appears" assertion below could be
    // passing on a mesh where the panel correctly renders the read-only
    // single-influence message instead.
    expect(findMultiInfluenceVertex()).toBeGreaterThanOrEqual(0);
  });
});

describe('with no vertex picked', () => {
  it('shows no weight fields at all', () => {
    const { container } = render(<BoneControls nodeId={ID} />);
    expect(weightFields(container)).toHaveLength(0);
  });
});

describe('with a multi-influence vertex picked', () => {
  it('renders one editable field per influencing bone, named for the bone', () => {
    const v = findMultiInfluenceVertex();
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);
    const fields = weightFields(container);
    expect(fields).toHaveLength(influencesAt(v).length);
    // Labelled by BONE NAME, not by id — the id is unreadable on a real rig.
    const labels = fields.map((f) => f.getAttribute('aria-label'));
    expect(labels.some((l) => l?.startsWith('Upper '))).toBe(true);
    expect(labels.some((l) => l?.startsWith('Fore '))).toBe(true);
  });

  it('shows each weight as a PERCENTAGE matching the binding', () => {
    const v = findMultiInfluenceVertex();
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);
    const infl = influencesAt(v);
    for (const field of weightFields(container)) {
      const label = field.getAttribute('aria-label')!;
      const bone = infl.find((w) => label.startsWith(`${w.boneId === 'upper' ? 'Upper' : 'Fore'} `))!;
      // Read back off the rendered attribute, not off what was passed in.
      expect(Number(field.getAttribute('aria-valuenow'))).toBeCloseTo(bone.weight * 100, 4);
      expect(field.getAttribute('aria-valuetext')).toMatch(/%$/);
    }
  });

  it('DRIVING a field changes the weights the renderer will skin with', () => {
    const v = findMultiInfluenceVertex();
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);
    const field = weightFields(container)[0]!;
    const boneName = field.getAttribute('aria-label')!.split(' weight at')[0]!;
    const boneId = boneName === 'Upper' ? 'upper' : 'fore';
    const before = influencesAt(v).find((w) => w.boneId === boneId)!.weight;

    // ArrowUp on the resting spinbutton is a real user gesture that commits.
    fireEvent.keyDown(field, { key: 'ArrowUp' });

    const after = influencesAt(v).find((w) => w.boneId === boneId)!.weight;
    expect(after).toBeGreaterThan(before);
  });

  it('and the edit is stored as an override, not lost on re-read', () => {
    const v = findMultiInfluenceVertex();
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);
    fireEvent.keyDown(weightFields(container)[0]!, { key: 'ArrowUp' });
    expect(readNodeSkeleton(defaultSceneGraph.getNode(ID)!)!.weightPaint).toBeDefined();
  });

  it('normalisation still holds after an edit made through the UI', () => {
    // The model guarantees this; asserted again HERE because the panel could
    // reasonably have written a partial vertex and broken it at the seam.
    const v = findMultiInfluenceVertex();
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);
    fireEvent.keyDown(weightFields(container)[0]!, { key: 'ArrowUp' });
    const total = influencesAt(v).reduce((a, w) => a + w.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('is ONE history entry per edit', () => {
    const v = findMultiInfluenceVertex();
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);
    const before = entryCount();
    fireEvent.keyDown(weightFields(container)[0]!, { key: 'ArrowUp' });
    expect(entryCount() - before).toBe(1);
  });

  it('undo restores the auto binding', () => {
    const v = findMultiInfluenceVertex();
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);
    const before = influencesAt(v).map((w) => w.weight);
    fireEvent.keyDown(weightFields(container)[0]!, { key: 'ArrowUp' });
    // `undo` bumps the scene store, which re-renders subscribers — wrapped so
    // React flushes it here rather than warning about an update outside act().
    act(() => { getCommandSystem().getHistory().undo(); });
    expect(influencesAt(v).map((w) => w.weight)).toEqual(before);
  });
});

describe('the single-influence boundary, through the UI', () => {
  it('offers NO editable field — the state is unrepresentable, not corrected', () => {
    // One bone reaches every vertex, so each is at weight 1 by definition. An
    // editable field here would renormalise whatever was typed straight back.
    setBones([TWO_BONES[0]!]);
    clearRestMeshCache();
    const v = 5;
    expect(influencesAt(v)).toHaveLength(1);
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);
    expect(weightFields(container)).toHaveLength(0);
    // And it says why, rather than rendering an empty card.
    expect(container.textContent).toMatch(/only influence/i);
  });
});

describe('a selection from a different mesh resolution', () => {
  it('reports the mismatch instead of editing whatever holds that index', () => {
    selectRigVertex(ID, 99999);
    const { container } = render(<BoneControls nodeId={ID} />);
    expect(weightFields(container)).toHaveLength(0);
    expect(container.textContent).toMatch(/different mesh resolution/i);
  });

  it('and a selection belonging to ANOTHER layer is not shown here', () => {
    // The pairing `rigVertexStore` keeps: an index alone addresses a different
    // part of the artwork on every layer.
    selectRigVertex('some_other_layer', findMultiInfluenceVertex());
    const { container } = render(<BoneControls nodeId={ID} />);
    expect(weightFields(container)).toHaveLength(0);
  });
});
