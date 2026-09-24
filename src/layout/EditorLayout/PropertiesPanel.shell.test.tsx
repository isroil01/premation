/**
 * The Properties shell after the 2026-09-15 redesign.
 *
 * Measured in the running app before it: a truncated "PR…" title beside nine
 * unlabelled switch glyphs, four sub-tabs where "Layer" opened on a DISABLED
 * Pathfinder, and ALL-CAPS section names. Each case below pins one half of
 * what replaced that, so none of it can drift back one commit at a time:
 *
 *   • one list — no tab strip, sections in the registry's editing order;
 *   • sections that do not apply to the SELECTION are not drawn (Pathfinder
 *     needs two shapes);
 *   • an identity row that names the selection, with the switches moved to
 *     labelled ⋯ rows that still write every selected layer as ONE undo;
 *   • the composition summary with nothing selected.
 *
 * Rendered without a DockPanel, so the ⋯ menu is the fallback one at the end
 * of the identity row; `PropertiesPanel.dockMenu.test.tsx` covers the docked
 * hand-off and its update-loop guard.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { useHistoryStore } from '@stores/historyStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { inspectorSectionsForSelection } from '@layout/Inspector/inspectorSections';
import { LAYER_SWITCHES, applyLayerSwitch, kindBreakdown } from '@layout/Inspector/SelectionHeader';
import { engineIdle } from '@core/engine/engineInstance';
import { PropertiesPanel } from './PropertiesPanel';

/** Two shape layers and a text layer in the root composition, made through the app's engine. */
let A: string;
let B: string;
let T: string;
const NAME = { A: 'shell_shape_a name', B: 'shell_shape_b name', T: 'shell_text_t name' };

let h: Harness & { engine: LocalEngine };

function select(ids: string[]): void {
  act(() => {
    useSelectionStore.setState({ ids } as never);
  });
}

function renderPanel(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <PropertiesPanel />
    </TooltipProvider>,
  );
}

const SOLO = LAYER_SWITCHES.find((t) => t.id === 'solo')!;
const entries = (): number => getCommandSystem().getHistory().getEntries().length;

beforeEach(async () => {
  h = await setupAppEngine();
  const mk = async (kind: 'shape' | 'text', name: string): Promise<string> =>
    (await h.run({ type: 'createLayer', comp: 'comp_root', kind, name, init: [] })).layer;
  A = await mk('shape', NAME.A);
  B = await mk('shape', NAME.B);
  T = await mk('text', NAME.T);
  getCommandSystem().getHistory().clear();
  useSelectionStore.setState({ ids: [] } as never);
});

afterEach(async () => {
  cleanup();
  useSelectionStore.setState({ ids: [] } as never);
  await h.dispose();
});

describe('one list, no sub-tabs', () => {
  it('draws no tab strip for a selected layer', () => {
    select([A]);
    renderPanel();
    // Positive control: the panel really is showing the layer.
    expect(screen.getByText(NAME.A)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('orders a plain shape’s sections in editing order', () => {
    const ids = inspectorSectionsForSelection([A]).map((s) => s.id);
    // Relative order of what a plain shape has; sections gated on state this
    // fixture does not carry (pins, a material, morph targets) are absent.
    const want = ['transform', 'appearance', 'layerStyles', 'geometry', 'compositing', 'motionTools'];
    expect(ids.filter((id) => want.includes(id))).toEqual(want);
    expect(ids).not.toContain('pathOps');
  });

  it('renders sentence-case section names in that order', () => {
    select([A]);
    renderPanel();
    const titles = [...document.querySelectorAll('button[aria-controls]')].map((b) => b.textContent ?? '');
    const at = (t: string): number => titles.findIndex((x) => x.startsWith(t));
    expect(at('Transform')).toBeGreaterThanOrEqual(0);
    expect(at('Transform')).toBeLessThan(at('Appearance'));
    expect(at('Appearance')).toBeLessThan(at('Layer styles'));
    expect(at('Layer styles')).toBeLessThan(at('Blending and switches'));
    expect(at('Blending and switches')).toBeLessThan(at('Motion tools'));
  });

  it('names a text layer’s appearance section for what it is', () => {
    const def = inspectorSectionsForSelection([T]).find((s) => s.id === 'appearance')!;
    expect(typeof def.title === 'function' ? def.title(T) : def.title).toBe('Stroke');
  });
});

describe('Pathfinder needs two shapes', () => {
  it('is hidden with one shape selected', () => {
    select([A]);
    renderPanel();
    expect(screen.queryByText('Pathfinder')).not.toBeInTheDocument();
  });

  it('appears once a second shape joins the selection', () => {
    expect(inspectorSectionsForSelection([A, B]).map((s) => s.id)).toContain('pathOps');
    select([A, B]);
    renderPanel();
    expect(screen.getByText('Pathfinder')).toBeInTheDocument();
  });

  it('stays hidden for one shape plus a text layer', () => {
    expect(inspectorSectionsForSelection([A, T]).map((s) => s.id)).not.toContain('pathOps');
  });
});

describe('the identity row', () => {
  it('names one layer and its kind, with no switch buttons', () => {
    select([A]);
    renderPanel();
    expect(screen.getByText(NAME.A)).toBeInTheDocument();
    expect(screen.getByText('Shape layer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Visible' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Layer switches' })).not.toBeInTheDocument();
  });

  it('counts a multi-selection and breaks it down by kind, with the align row above', () => {
    expect(kindBreakdown([A, B, T])).toBe('2 shapes, 1 text');
    select([A, B, T]);
    renderPanel();
    expect(screen.getByText('3 layers')).toBeInTheDocument();
    expect(screen.getByText('2 shapes, 1 text')).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Align selected layers' })).toBeInTheDocument();
  });

  it('shows no align row for a single layer', () => {
    select([A]);
    renderPanel();
    expect(screen.queryByRole('toolbar', { name: 'Align selected layers' })).not.toBeInTheDocument();
  });

  it('renames on double-click + Enter, and Escape leaves the name alone', async () => {
    select([A]);
    renderPanel();
    fireEvent.doubleClick(screen.getByText(NAME.A));
    const input = screen.getByRole('textbox', { name: 'Layer name' });
    fireEvent.change(input, { target: { value: 'Hero' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await act(async () => { await engineIdle(); });
    expect(defaultSceneGraph.getNode(A)?.name).toBe('Hero');

    fireEvent.doubleClick(screen.getByText('Hero'));
    const again = screen.getByRole('textbox', { name: 'Layer name' });
    fireEvent.change(again, { target: { value: 'Discarded' } });
    act(() => {
      fireEvent.keyDown(again, { key: 'Escape' });
    });
    await act(async () => { await engineIdle(); });
    expect(defaultSceneGraph.getNode(A)?.name).toBe('Hero');
    expect(screen.queryByRole('textbox', { name: 'Layer name' })).not.toBeInTheDocument();
  });
});

describe('the switches live in the ⋯ menu', () => {
  it('lists the applicable switches as labelled rows', () => {
    select([A, B]);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Properties panel options' }));
    for (const label of ['Visible', 'Solo', 'Lock', 'Motion blur', 'Adjustment layer']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Keyframe lanes under animated rows')).toBeInTheDocument();
  });

  it('toggling a row writes every selected layer', async () => {
    select([A, B]);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Properties panel options' }));
    act(() => {
      fireEvent.click(screen.getByText('Solo'));
    });
    await act(async () => { await engineIdle(); });
    expect(defaultSceneGraph.getNode(A)?.solo).toBe(true);
    expect(defaultSceneGraph.getNode(B)?.solo).toBe(true);
  });

  it('a mixed switch turns everything on, as ONE undo entry', async () => {
    // History wired the way boot wires it (`setupAppEngine` attaches the
    // recorder), and the debounce flushed before counting — the same
    // measurement modifierStack.test.ts makes.
    await h.run({ type: 'setLayerSwitches', layers: [A], patch: SOLO.patch(true) });
    getCommandSystem().getHistory().clear();
    const before = entries();
    // B3: the switch is an engine batch — one entry on the one history.
    await applyLayerSwitch([A, B], SOLO);
    useHistoryStore.getState().flush();
    expect([defaultSceneGraph.getNode(A)?.solo, defaultSceneGraph.getNode(B)?.solo]).toEqual([true, true]);
    expect(entries() - before).toBe(1);
    expect(historyLabels()).toEqual(['Enable Solo']);
    await h.run({ type: 'undo' });
    expect(defaultSceneGraph.getNode(A)?.solo).toBe(true);
    expect(defaultSceneGraph.getNode(B)?.solo).not.toBe(true);
  });
});

describe('with nothing selected', () => {
  const realProject = useProjectStore.getState();
  afterEach(() => {
    act(() => {
      useProjectStore.setState(realProject, true);
    });
  });

  it('keeps the short hint for the auto-minted pristine comp', async () => {
    // A fresh store's active comp IS the pristine one, which the tab strip
    // calls "(none)" — describing it would describe a comp nobody made.
    // Pristine means layerless too: back to the fresh project, without the
    // fixture's layers (they live in that comp).
    await act(async () => { await h.run({ type: 'deleteLayers', layers: [A, B, T] }); });
    renderPanel();
    expect(screen.getByText('Select a layer to edit its properties.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Composition settings…' })).not.toBeInTheDocument();
  });

  it('summarises the composition and offers its settings', () => {
    act(() => {
      // The composition store is a view of the ACTIVE comp in the project
      // store, so the active comp is made the user's (not pristine) and then
      // edited through that view.
      const s = useProjectStore.getState();
      const compId = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
      expect(compId).toBeDefined();
      useProjectStore.setState({ comps: { ...s.comps, [compId!]: { ...s.comps[compId!]!, pristine: false } } } as never);
      useCompositionStore.setState({ name: 'Hero comp', width: 1280, height: 720, fps: 24 } as never);
    });
    renderPanel();
    expect(screen.getByText('Hero comp')).toBeInTheDocument();
    expect(screen.getByText('1280 × 720')).toBeInTheDocument();
    expect(screen.getByText('24 fps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Composition settings…' })).toBeInTheDocument();
    expect(screen.getByText('Select a layer to edit its properties')).toBeInTheDocument();
  });
});
