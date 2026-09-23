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
import { useHistoryStore, attachHistoryRecording, baselineHistory } from '@stores/historyStore';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { EventBus, setEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { inspectorSectionsForSelection } from '@layout/Inspector/inspectorSections';
import { LAYER_SWITCHES, applyLayerSwitch, kindBreakdown } from '@layout/Inspector/SelectionHeader';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { PropertiesPanel } from './PropertiesPanel';

const A = 'shell_shape_a';
const B = 'shell_shape_b';
const T = 'shell_text_t';

function shapeNode(id: string): SceneNode {
  return {
    id, name: `${id} name`, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ff0000' } },
    ],
  } as unknown as SceneNode;
}

function textNode(id: string): SceneNode {
  return {
    id, name: `${id} name`, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0, width: 200, height: 60, opacity: 100 } },
      { id: `${id}_txt`, type: 'Text', props: { content: 'Hi', fontSize: 48, fontFamily: 'Inter' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

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
/** The composition the layers live in: layer switches go through the engine API (B3), which addresses LAYERS. */
const ROOT = 'shell_root';
const entries = (): number => getCommandSystem().getHistory().getEntries().length;

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  for (const id of [A, B, T]) if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode(id);
  if (!defaultSceneGraph.getNode(ROOT)) {
    defaultSceneGraph.addNode({
      id: ROOT, name: 'Comp', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, components: [],
    } as unknown as SceneNode);
  }
  defaultSceneGraph.addChild(ROOT, shapeNode(A));
  defaultSceneGraph.addChild(ROOT, shapeNode(B));
  defaultSceneGraph.addChild(ROOT, textNode(T));
  useSelectionStore.setState({ ids: [] } as never);
});

afterEach(() => {
  cleanup();
  useSelectionStore.setState({ ids: [] } as never);
  for (const id of [A, B, T]) if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode(id);
});

describe('one list, no sub-tabs', () => {
  it('draws no tab strip for a selected layer', () => {
    select([A]);
    renderPanel();
    // Positive control: the panel really is showing the layer.
    expect(screen.getByText(`${A} name`)).toBeInTheDocument();
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
    expect(screen.getByText(`${A} name`)).toBeInTheDocument();
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

  it('renames on double-click + Enter, and Escape leaves the name alone', () => {
    select([A]);
    renderPanel();
    fireEvent.doubleClick(screen.getByText(`${A} name`));
    const input = screen.getByRole('textbox', { name: 'Layer name' });
    fireEvent.change(input, { target: { value: 'Hero' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(defaultSceneGraph.getNode(A)?.name).toBe('Hero');

    fireEvent.doubleClick(screen.getByText('Hero'));
    const again = screen.getByRole('textbox', { name: 'Layer name' });
    fireEvent.change(again, { target: { value: 'Discarded' } });
    act(() => {
      fireEvent.keyDown(again, { key: 'Escape' });
    });
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
    // History wired the way boot wires it, and the debounce flushed before
    // counting — the same measurement modifierStack.test.ts makes.
    setEventBus(new EventBus());
    const recording = attachHistoryRecording();
    try {
      defaultSceneGraph.getNode(A)!.solo = true;
      baselineHistory();
      const before = entries();
      // B3: the switch is an engine batch — one entry on the one history.
      await applyLayerSwitch([A, B], SOLO);
      useHistoryStore.getState().flush();
      expect([defaultSceneGraph.getNode(A)?.solo, defaultSceneGraph.getNode(B)?.solo]).toEqual([true, true]);
      expect(entries() - before).toBe(1);
      await engine().execute({ type: 'undo' });
      expect(defaultSceneGraph.getNode(B)?.solo).not.toBe(true);
    } finally {
      recording.dispose();
    }
  });
});

describe('with nothing selected', () => {
  const realProject = useProjectStore.getState();
  afterEach(() => {
    act(() => {
      useProjectStore.setState(realProject, true);
    });
  });

  it('keeps the short hint for the auto-minted pristine comp', () => {
    // A fresh store's active comp IS the pristine one, which the tab strip
    // calls "(none)" — describing it would describe a comp nobody made.
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
