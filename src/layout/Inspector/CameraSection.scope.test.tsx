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
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CameraSection } from './CameraSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useProjectStore } from '@stores/projectStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { is3DEnabled } from '@core/scene/threeD';
import type { SceneNode } from '@core/types';

const COMP_A = 'scope_comp_a';
const COMP_B = 'scope_comp_b';
const LAYER_A = 'scope_layer_a';
const LAYER_B = 'scope_layer_b';
const CAMERA = 'scope_camera';

function node(id: string, kind: string, parent: string | null): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 } },
    ],
  } as unknown as SceneNode;
}

/** Two sibling comp roots, each with one 3D-capable layer; a camera in A. */
function buildTwoComps(): void {
  defaultSceneGraph.addNode(node(COMP_A, 'comp', null));
  defaultSceneGraph.addNode(node(COMP_B, 'comp', null));
  defaultSceneGraph.addChild(COMP_A, node(LAYER_A, 'shape', COMP_A));
  defaultSceneGraph.addChild(COMP_A, node(CAMERA, 'camera', COMP_A));
  defaultSceneGraph.addChild(COMP_B, node(LAYER_B, 'shape', COMP_B));
}

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
  beforeEach(() => {
    for (const id of [LAYER_A, LAYER_B, CAMERA, COMP_A, COMP_B]) {
      try { defaultSceneGraph.removeNode(id); } catch { /* first run */ }
    }
    buildTwoComps();
    openComp(COMP_A);
  });

  afterEach(cleanup);

  it('leaves layers in other comps 2D', () => {
    render(<CameraSection nodeId={CAMERA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make all 3D' }));

    expect(is3D(LAYER_A)).toBe(true);
    expect(is3D(LAYER_B)).toBe(false);
  });

  it('counts only the active comp, so the label cannot advertise other comps', () => {
    render(<CameraSection nodeId={CAMERA} />);
    // One 3D-capable layer in comp A (the camera is not one), none of it 3D yet.
    expect(screen.getByText(/No 3D layers/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Make all 3D' }));
    expect(screen.getByText('1 of 1 layers are 3D')).toBeInTheDocument();
  });
});
