/**
 * The Pathfinder's contract is entirely about WHICH COMMAND ID it dispatches.
 * The booleans themselves are tested where they live (mergePaths); what can go
 * wrong here is the panel quietly calling the bake while showing "Live", or
 * calling the live merge for the button labelled Merge Paths — either of which
 * looks correct on screen and destroys the user's operands.
 *
 * So the command system is the seam under test, and the ids are asserted
 * literally: they are also the keys into the user's persisted shortcut
 * overrides, so a "tidy-up" rename here would orphan every remap.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { PathOpsSection } from './PathOpsSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const executed: string[] = [];
jest.mock('@core/commands/CommandSystem', () => ({
  getCommandSystem: () => ({
    execute: (id: string) => {
      executed.push(id);
      return Promise.resolve();
    },
  }),
}));

function addShape(id: string): void {
  defaultSceneGraph.addNode({
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 100, height: 100, shapeType: 'rect' },
      },
    ],
  } as never);
}

beforeEach(() => {
  executed.length = 0;
  defaultSceneGraph.clear();
  useUIStore.getState().setActiveTool('select');
});

describe('PathOpsSection', () => {
  it('renders nothing when no shape layer is selected', () => {
    useSelectionStore.getState().set([]);
    const { container } = render(<PathOpsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows for ONE shape layer, with the four ops disabled', () => {
    // Disabled rather than absent: a pathfinder that disappears at one
    // selected shape never explains that it wants two.
    addShape('a');
    useSelectionStore.getState().set(['a']);
    render(<PathOpsSection />);
    expect(screen.getByLabelText('Union (Add)')).toBeDisabled();
    expect(screen.getByText('Select two or more shape layers to combine.')).toBeInTheDocument();
    // The Knife needs only one path, so it stays live.
    expect(screen.getByTitle(/^Knife —/)).toBeEnabled();
  });

  it('dispatches the LIVE boolean command ids by default', () => {
    addShape('a');
    addShape('b');
    useSelectionStore.getState().set(['a', 'b']);
    render(<PathOpsSection />);
    fireEvent.click(screen.getByLabelText('Union (Add)'));
    fireEvent.click(screen.getByLabelText('Subtract (top minus below)'));
    fireEvent.click(screen.getByLabelText('Intersect'));
    fireEvent.click(screen.getByLabelText('Exclude (XOR)'));
    expect(executed).toEqual([
      'shape.boolean.union',
      'shape.boolean.subtract',
      'shape.boolean.intersect',
      'shape.boolean.exclude',
    ]);
  });

  it('dispatches the BAKE ids after switching the result mode', () => {
    addShape('a');
    addShape('b');
    useSelectionStore.getState().set(['a', 'b']);
    render(<PathOpsSection />);
    fireEvent.click(screen.getByText('Bake now'));
    fireEvent.click(screen.getByLabelText('Union (Add) (bake)'));
    fireEvent.click(screen.getByLabelText('Exclude (XOR) (bake)'));
    // The original ids, not renamed-for-symmetry ones — they key the user's
    // persisted shortcut overrides.
    expect(executed).toEqual(['shape.mergeUnion', 'shape.mergeExclude']);
  });

  it('Merge Paths always bakes, whatever the mode toggle says', () => {
    addShape('a');
    addShape('b');
    useSelectionStore.getState().set(['a', 'b']);
    render(<PathOpsSection />);
    fireEvent.click(screen.getByText('Merge Paths (bake)'));
    expect(executed).toEqual(['shape.mergeUnion']);
  });

  it('the Knife button arms the tool rather than running a command', () => {
    addShape('a');
    useSelectionStore.getState().set(['a']);
    render(<PathOpsSection />);
    fireEvent.click(screen.getByText('Knife'));
    expect(useUIStore.getState().activeTool).toBe('knife');
    expect(executed).toEqual([]);
  });
});
