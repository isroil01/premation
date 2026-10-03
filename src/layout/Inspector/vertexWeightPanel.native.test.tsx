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
import { useSelectionStore } from '@stores/selectionStore';
import { clearRestMeshCache } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { nodeRestMesh } from '@core/rig/rigMeshInputs';
import { getSkeletonBinding } from '@core/rig/rigDeform';
import { readGeometry } from '@core/workspace/geometry';
import { clearHistory, setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { engineIdle } from '@core/engine/engineInstance';
import { rigTestLayer } from '@layout/Workspace/__testHelpers__/rigLayer';
import { selectRigVertex, clearRigVertex } from '@stores/rigVertexStore';
import { useUIStore } from '@stores/uiStore';
import type { VertexWeight } from '@core/rig/skinning';

const TWO_BONES = [
  { id: 'upper', name: 'Upper', parentId: null, length: 60, x: -70, y: 0, rotation: 0 },
  { id: 'fore', name: 'Fore', parentId: 'upper', length: 60, x: 60, y: 0, rotation: 0 },
];

let h: Awaited<ReturnType<typeof setupAppEngine>>;
/** The rig layer (engine-created, 240 × 160 at the comp origin). */
let ID = '';

/** Let the engine settle — several rounds: the panel asks getRigPose for the pose it shows (B4 round 5). */
const idle = (): Promise<void> => act(async () => { for (let i = 0; i < 6; i++) await engineIdle(); });

/** The starting rig, written through the engine (setup: the history is cleared after). */
async function setBones(bones: typeof TWO_BONES): Promise<void> {
  const rig = { bones, ikTargets: [], meshDensity: 8, meshExpansion: 0 };
  await h.run({ type: 'setProperty', prop: { layer: ID, path: 'layer/skeleton' }, value: { kind: 'json', value: JSON.stringify(rig) } });
  await idle();
  await clearHistory();
}

/** The binding the panel itself will build — same mesh assembly, by construction. */
async function influencesAt(vertexIndex: number): Promise<VertexWeight[]> {
  const node = (await docView()).getNode(ID)!;
  const geom = readGeometry(node)!;
  const mesh = nodeRestMesh(node, geom, () => undefined);
  const skel = readNodeSkeleton(node);
  return getSkeletonBinding(mesh, skel?.bones ?? [], skel?.weightPaint).weights[vertexIndex] ?? [];
}

/** First vertex reached by more than one bone. Derived, not guessed. */
async function findMultiInfluenceVertex(): Promise<number> {
  const node = (await docView()).getNode(ID)!;
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

const entryCount = async (): Promise<number> => (await historyLabels()).length;

/** ArrowUp on the resting spinbutton is a real user gesture that commits. */
async function nudgeUp(field: HTMLElement): Promise<void> {
  fireEvent.keyDown(field, { key: 'ArrowUp' });
  await idle();
}

beforeEach(async () => {
  h = await setupAppEngine();
  clearRestMeshCache();
  clearRigVertex();
  useUIStore.setState({ boneRigMode: 'weights' });
  ID = await rigTestLayer(h, { width: 240, height: 160 });
  await setBones(TWO_BONES);
  useSelectionStore.getState().set([ID]);
});

afterEach(async () => {
  cleanup();
  clearRigVertex();
  await h.dispose();
});

describe('the fixture is a real rig', () => {
  it('POSITIVE CONTROL: some vertex has more than one influence', async () => {
    // Without this, every "editable field appears" assertion below could be
    // passing on a mesh where the panel correctly renders the read-only
    // single-influence message instead.
    expect((await findMultiInfluenceVertex())).toBeGreaterThanOrEqual(0);
  });
});

describe('with no vertex picked', () => {
  it('shows no weight fields at all', async () => {
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    expect(weightFields(container)).toHaveLength(0);
  });
});

describe('with a multi-influence vertex picked', () => {
  it('renders one editable field per influencing bone, named for the bone', async () => {
    const v = (await findMultiInfluenceVertex());
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    const fields = weightFields(container);
    expect(fields).toHaveLength((await influencesAt(v)).length);
    // Labelled by BONE NAME, not by id — the id is unreadable on a real rig.
    const labels = fields.map((f) => f.getAttribute('aria-label'));
    expect(labels.some((l) => l?.startsWith('Upper '))).toBe(true);
    expect(labels.some((l) => l?.startsWith('Fore '))).toBe(true);
  });

  it('shows each weight as a PERCENTAGE matching the binding', async () => {
    const v = (await findMultiInfluenceVertex());
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    const infl = (await influencesAt(v));
    for (const field of weightFields(container)) {
      const label = field.getAttribute('aria-label')!;
      const bone = infl.find((w) => label.startsWith(`${w.boneId === 'upper' ? 'Upper' : 'Fore'} `))!;
      // Read back off the rendered attribute, not off what was passed in.
      expect(Number(field.getAttribute('aria-valuenow'))).toBeCloseTo(bone.weight * 100, 4);
      expect(field.getAttribute('aria-valuetext')).toMatch(/%$/);
    }
  });

  it('DRIVING a field changes the weights the renderer will skin with', async () => {
    const v = (await findMultiInfluenceVertex());
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    const field = weightFields(container)[0]!;
    const boneName = field.getAttribute('aria-label')!.split(' weight at')[0]!;
    const boneId = boneName === 'Upper' ? 'upper' : 'fore';
    const before = (await influencesAt(v)).find((w) => w.boneId === boneId)!.weight;

    await nudgeUp(field);

    const after = (await influencesAt(v)).find((w) => w.boneId === boneId)!.weight;
    expect(after).toBeGreaterThan(before);
  });

  it('and the edit is stored as an override, not lost on re-read', async () => {
    const v = (await findMultiInfluenceVertex());
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    await nudgeUp(weightFields(container)[0]!);
    expect(readNodeSkeleton((await docView()).getNode(ID)!)!.weightPaint).toBeDefined();
  });

  it('normalisation still holds after an edit made through the UI', async () => {
    // The model guarantees this; asserted again HERE because the panel could
    // reasonably have written a partial vertex and broken it at the seam.
    const v = (await findMultiInfluenceVertex());
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    await nudgeUp(weightFields(container)[0]!);
    const total = (await influencesAt(v)).reduce((a, w) => a + w.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('is ONE history entry per edit', async () => {
    const v = (await findMultiInfluenceVertex());
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    const before = (await entryCount());
    await nudgeUp(weightFields(container)[0]!);
    expect((await entryCount()) - before).toBe(1);
    expect((await historyLabels()).at(-1)).toBe('Set Vertex Weight');
  });

  it('undo restores the auto binding', async () => {
    const v = (await findMultiInfluenceVertex());
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    const before = (await influencesAt(v)).map((w) => w.weight);
    await nudgeUp(weightFields(container)[0]!);
    expect((await influencesAt(v)).map((w) => w.weight)).not.toEqual(before);
    await act(async () => { await h.run({ type: 'undo' }); });
    expect((await influencesAt(v)).map((w) => w.weight)).toEqual(before);
    expect(readNodeSkeleton((await docView()).getNode(ID)!)!.weightPaint).toBeUndefined();
  });
});

describe('the single-influence boundary, through the UI', () => {
  it('offers NO editable field — the state is unrepresentable, not corrected', async () => {
    // One bone reaches every vertex, so each is at weight 1 by definition. An
    // editable field here would renormalise whatever was typed straight back.
    await setBones([TWO_BONES[0]!]);
    clearRestMeshCache();
    const v = 5;
    expect((await influencesAt(v))).toHaveLength(1);
    selectRigVertex(ID, v);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    expect(weightFields(container)).toHaveLength(0);
    // And it says why, rather than rendering an empty card.
    expect(container.textContent).toMatch(/only influence/i);
  });
});

describe('a selection from a different mesh resolution', () => {
  it('reports the mismatch instead of editing whatever holds that index', async () => {
    selectRigVertex(ID, 99999);
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    expect(weightFields(container)).toHaveLength(0);
    expect(container.textContent).toMatch(/different mesh resolution/i);
  });

  it('and a selection belonging to ANOTHER layer is not shown here', async () => {
    // The pairing `rigVertexStore` keeps: an index alone addresses a different
    // part of the artwork on every layer.
    selectRigVertex('some_other_layer', (await findMultiInfluenceVertex()));
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    expect(weightFields(container)).toHaveLength(0);
  });
});
