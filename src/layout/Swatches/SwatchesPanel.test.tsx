/**
 * The panel's one irreversible action: painting the selection.
 *
 * Everything else here is palette bookkeeping the store already covers. What
 * this file exists for is the write path — that "Apply to selection" goes
 * through the engine's `layer/fillPaint` (G1), the same write the Appearance
 * section's fill picker sends, so a multi-fill layer's STACK and its legacy
 * single-fill slot stay in agreement, as ONE undo entry. A panel that wrote `fx.props.fill` itself would look
 * correct in the viewport and be wrong in the inspector.
 */

import { act, render, screen, fireEvent } from '@testing-library/react';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { SwatchesPanel } from './SwatchesPanel';
import { useSwatchStore } from '@stores/swatchStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getNodeFill, getNodeFills } from '@core/paint/fill';
import type { SceneNode } from '@core/types';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

function shapeNode(id: string, fxProps: Record<string, unknown>): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'shape' } },
      { id: `${id}_fx`, type: 'fx', props: fxProps },
    ],
  };
}

function clearScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  clearScene();
  useSwatchStore.getState().restore([]);
  useSelectionStore.getState().clear();
});

describe('applying a swatch to the selection', () => {
  let h: Awaited<ReturnType<typeof setupAppEngine>>;
  const layer = async (name: string, fills: unknown[]): Promise<string> => {
    const { layer: id } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name, init: [] });
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'layer/fills' }, value: { kind: 'json', value: JSON.stringify(fills) } });
    return id;
  };
  beforeEach(async () => { h = await setupAppEngine(); });
  afterEach(async () => { await h.dispose(); });

  it('fills every selected layer, one undo entry', async () => {
    const black = { type: 'solid', color: '#000000' };
    const a = await layer('a', [black]);
    const b = await layer('b', [black]);
    const c = await layer('c', [black]);
    useSelectionStore.getState().set([a, b]);
    useSwatchStore.getState().addSwatch('#ff0000', 'Brand Red');
    const entries = historyLabels().length;

    render(<SwatchesPanel />);
    await act(async () => { fireEvent.click(screen.getByLabelText('Apply Brand Red to selection')); await engineIdle(); });

    expect(getNodeFill(a)).toEqual({ type: 'solid', color: '#ff0000' });
    expect(getNodeFill(b)).toEqual({ type: 'solid', color: '#ff0000' });
    // Unselected layers are untouched — the action is "apply to SELECTION".
    expect(getNodeFill(c)).toEqual({ type: 'solid', color: '#000000' });
    expect(historyLabels().length).toBe(entries + 1);
  });

  it('keeps the rest of a multi-fill stack, replacing only the primary', async () => {
    // A direct write would leave fills[0] and the legacy slot disagreeing.
    const multi = await layer('multi', [
      { type: 'solid', color: '#000000' },
      { type: 'solid', color: '#222222' },
    ]);
    useSelectionStore.getState().set([multi]);
    useSwatchStore.getState().addSwatch('#ff0000', 'Brand Red');

    render(<SwatchesPanel />);
    await act(async () => { fireEvent.click(screen.getByLabelText('Apply Brand Red to selection')); await engineIdle(); });

    expect(getNodeFills(multi)).toEqual([
      { type: 'solid', color: '#ff0000' },
      { type: 'solid', color: '#222222' },
    ]);
    expect(getNodeFill(multi)).toEqual({ type: 'solid', color: '#ff0000' });
  });

  it('is inert with nothing selected, rather than painting at random', () => {
    defaultSceneGraph.addNode(shapeNode('a', { fill: { type: 'solid', color: '#000000' } }));
    useSwatchStore.getState().addSwatch('#ff0000', 'Brand Red');

    render(<SwatchesPanel />);
    const apply = screen.getByLabelText('Apply Brand Red to selection');
    expect(apply).toBeDisabled();
    fireEvent.click(apply);

    expect(getNodeFill('a')).toEqual({ type: 'solid', color: '#000000' });
  });
});

describe('managing the palette', () => {
  it('reorders and deletes', () => {
    useSwatchStore.getState().addSwatch('#ff0000', 'A');
    useSwatchStore.getState().addSwatch('#00ff00', 'B');

    render(<SwatchesPanel />);
    fireEvent.click(screen.getByLabelText('Move B up'));
    expect(useSwatchStore.getState().swatches.map((s) => s.name)).toEqual(['B', 'A']);

    fireEvent.click(screen.getByLabelText('Delete A'));
    expect(useSwatchStore.getState().swatches.map((s) => s.name)).toEqual(['B']);
  });

  it('promotes a document colour into the palette', () => {
    defaultSceneGraph.addNode(shapeNode('a', { fill: { type: 'solid', color: '#c0ffee' } }));

    render(<SwatchesPanel />);
    fireEvent.click(screen.getByLabelText('Add #c0ffee to project swatches'));

    expect(useSwatchStore.getState().swatches.map((s) => s.hex)).toEqual(['#c0ffee']);
  });
});

describe('the empty palette', () => {
  it('names both empty sections and offers the one action that works', () => {
    render(<SwatchesPanel />);

    expect(screen.getByText('No swatches yet')).toBeTruthy();
    expect(screen.getByText('Nothing in this composition is painted yet.')).toBeTruthy();

    // The empty state's action does the same thing as the Add button above it
    // — which is the point: the panel is empty precisely when that button is
    // the only thing a new user can usefully press, and it is an unlabelled
    // "+" in a header until you hover it.
    fireEvent.click(screen.getByRole('button', { name: /add the picked colour/i }));
    expect(useSwatchStore.getState().swatches.length).toBe(1);
  });
});
