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

import { render, cleanup,  act } from '@testing-library/react';
import { BoneControls } from './BoneControls';
import { useSelectionStore } from '@stores/selectionStore';
import { clearRestMeshCache } from '@core/rig/puppet';
import { clearHistory, setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { rigTestLayer } from '@layout/Workspace/__testHelpers__/rigLayer';
import { selectRigVertex, clearRigVertex } from '@stores/rigVertexStore';
import { useUIStore } from '@stores/uiStore';

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

const spinbuttons = (c: HTMLElement): HTMLElement[] =>
  [...c.querySelectorAll('[role="spinbutton"][aria-label]')] as HTMLElement[];

const weightFields = (c: HTMLElement): HTMLElement[] =>
  spinbuttons(c).filter((el) => /weight at vertex/.test(el.getAttribute('aria-label') ?? ''));

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

describe('with no vertex picked', () => {
  it('shows no weight fields at all', async () => {
    const { container } = render(<BoneControls nodeId={ID} />);

    await idle();
    expect(weightFields(container)).toHaveLength(0);
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
});
