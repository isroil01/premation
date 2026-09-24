/**
 * "Make all 3D" is a WRITE, and it used to run scene-wide.
 *
 * Compositions are separate root subtrees of one graph, so the panel's
 * `flattenScene` meant one click flipped the 3D switch on every layer in every
 * OTHER comp too — persisted through `writeProp` + autosave. Unlike the scoping
 * bugs on the read side, fixing the renderer does not undo it: the damage is in
 * the saved document. Worse for solids, whose placement `set3DEnabled` seeds
 * from the ACTIVE comp's dimensions.
 *
 * The invariant here: the button and its "N of M" count see only the comp the
 * active tab is editing.
 *
 * The fixture is the app's engine (B3): both compositions and their layers are
 * created through the engine API, the button's write is an engine command
 * (one undo entry) and the panel reads the document mirror.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { CameraSection } from './CameraSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useProjectStore } from '@stores/projectStore';
import { is3DEnabled } from '@core/scene/threeD';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';

jest.useFakeTimers();

const COMP_A = 'comp_root';
let COMP_B: string;
let LAYER_A: string;
let LAYER_B: string;
let CAMERA: string;
let h: Harness & { engine: LocalEngine };

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };

/** Point the active tab at `rootId` — what `activeCompRootId()` resolves. */
function openComp(rootId: string): void {
  const s = useProjectStore.getState();
  const tabId = s.activeTabId ?? 'scope_tab';
  useProjectStore.setState({
    activeTabId: tabId,
    tabs: {
      ...s.tabs,
      [tabId]: {
        ...(s.tabs[tabId] ?? { breadcrumbPath: [], time: 0, frame: 0, playing: false, title: 'A', dirty: false }),
        id: tabId,
        compositionId: rootId,
      },
    },
  });
}

const is3D = (id: string): boolean => is3DEnabled(defaultSceneGraph.getNode(id)!);

describe('Make all 3D is scoped to the active composition', () => {
  /** Two compositions, each with one 3D-capable layer; a camera in A. */
  beforeEach(async () => {
    h = await setupAppEngine();
    ({ item: COMP_B } = await h.run({ type: 'createComposition', settings: { name: 'B', width: 800, height: 600 }, fromItems: [] }));
    ({ layer: LAYER_A } = await h.run({ type: 'createLayer', comp: COMP_A, kind: 'shape', name: 'A shape', init: [] }));
    ({ layer: CAMERA } = await h.run({ type: 'createLayer', comp: COMP_A, kind: 'camera', name: 'Camera', init: [] }));
    ({ layer: LAYER_B } = await h.run({ type: 'createLayer', comp: COMP_B, kind: 'shape', name: 'B shape', init: [] }));
    openComp(COMP_A);
    getCommandSystem().getHistory().clear();
  });

  afterEach(async () => {
    cleanup();
    await h.dispose();
  });

  it('leaves layers in other comps 2D', async () => {
    render(<CameraSection nodeId={CAMERA} />);
    const before = h.doc();
    fireEvent.click(screen.getByRole('button', { name: 'Make all 3D' }));
    await idle(); // an engine command (B3)

    expect(is3D(LAYER_A)).toBe(true);
    expect(is3D(LAYER_B)).toBe(false);
    settle();
    expect(historyLabels()).toEqual(['Make All Layers 3D']);

    await undo();
    expect(is3D(LAYER_A)).toBe(false);
    expect(h.doc()).toBe(before);
  });

  it('counts only the active comp, so the label cannot advertise other comps', async () => {
    render(<CameraSection nodeId={CAMERA} />);
    // One 3D-capable layer in comp A (the camera is not one), none of it 3D yet.
    expect(screen.getByText(/No 3D layers/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Make all 3D' }));
    await idle();
    expect(screen.getByText('1 of 1 layers are 3D')).toBeInTheDocument();
  });
});
