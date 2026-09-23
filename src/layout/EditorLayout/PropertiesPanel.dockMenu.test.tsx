/**
 * PropertiesPanel inside a DockPanel: the header-menu hand-off must settle.
 *
 * v0.8.1 (cbdc3d45) built the panel's `menuItems` as a fresh array on every
 * render and listed it as a dependency of the effect that hands it to the
 * DockPanel header. The hand-off is a state update in DockPanel, which
 * re-renders the panel, which builds a new array, which re-runs the effect —
 * "Maximum update depth exceeded", hundreds of times, the moment a layer was
 * selected.
 *
 * The console spy THROWS on that warning rather than only recording it: under
 * act() the loop never drains, so a recording spy would hang the suite instead
 * of failing it. The throw unwinds React and ends the loop. It unwinds it from
 * the middle of a render, though, so once the loop is back every LATER case in
 * this file fails with React's "Should not already be working" — read the
 * first failure; that one names the loop.
 *
 * Rendered through the real DockPanel, not a hand-made context value: the
 * second half of this bug lived in DockPanel's own reset effect (see the
 * header-menu cases below), which a stub provider would not have.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DockPanel } from '@components/DockPanel';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import { useLayoutStore } from '@stores/layoutStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { PropertiesPanel } from './PropertiesPanel';
import { engineIdle } from '@core/engine/engineInstance';

const ID = 'dock_menu_probe_layer';
const OTHER = 'dock_menu_probe_other_panel';
const LANES_ROW = 'Keyframe lanes under animated rows';
/** The composition the layer lives in: layer switches go through the engine API (B3), which addresses LAYERS. */
const ROOT = 'dock_menu_probe_root';

function textNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0, width: 200, height: 60, opacity: 100 } },
      { id: `${id}_txt`, type: 'Text', props: { content: 'Hi', fontSize: 48, fontFamily: 'Inter' } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

const renderers = {
  properties: () => <PropertiesPanel />,
  [OTHER]: () => <div>other panel</div>,
};

function renderDock(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <DockPanel region="rightInspector" renderers={renderers} />
    </TooltipProvider>,
  );
}

function openHeaderMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Panel options' }));
}

let loopWarnings: string[] = [];
let errorSpy: jest.SpyInstance;
const realError = console.error;

beforeEach(() => {
  loopWarnings = [];
  errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const msg = args.map(String).join(' ');
    if (/Maximum update depth/.test(msg)) {
      loopWarnings.push(msg);
      throw new Error(`update loop: ${msg.slice(0, 160)}`);
    }
    realError(...args);
  });

  const layout = useLayoutStore.getState();
  layout.registerPanel({ id: 'properties', title: 'Properties', icon: 'settings', region: 'rightInspector', closable: false } as never);
  layout.registerPanel({ id: OTHER, title: 'Other', icon: 'layers', region: 'rightInspector', closable: false } as never);
  layout.openPanel('properties');

  if (!defaultSceneGraph.getNode(ROOT)) {
    defaultSceneGraph.addNode({
      id: ROOT, name: 'Comp', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, components: [],
    } as unknown as SceneNode);
  }
  defaultSceneGraph.addChild(ROOT, textNode(ID));
  useSelectionStore.setState({ ids: [ID] } as never);
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
  useSelectionStore.setState({ ids: [] } as never);
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
});

describe('PropertiesPanel in a DockPanel with a layer selected', () => {
  it('mounts without an update loop', () => {
    renderDock();
    expect(loopWarnings).toEqual([]);
    // Positive control: the selection really reached the panel — the search
    // button only renders (portalled into the dock header) for a live layer.
    expect(screen.getByRole('button', { name: 'Search properties' })).toBeInTheDocument();
  });

  it('settles again when an input of the menu changes', () => {
    renderDock();
    act(() => {
      const prefs = usePreferenceStore.getState();
      prefs.set('inspectorShowLane', !prefs.inspectorShowLane);
    });
    expect(loopWarnings).toEqual([]);
  });

  it('hands its rows to the dock header menu', () => {
    // DockPanel clears the custom rows when the active panel changes. Its
    // effect runs AFTER the child's on the same commit, so a naive clear wiped
    // the rows the panel had just handed over — the loop above had been
    // re-handing them every pass, which is the only reason they ever showed.
    renderDock();
    openHeaderMenu();
    expect(screen.getByText(LANES_ROW)).toBeInTheDocument();
    expect(screen.getByText('Open Effect Controls panel')).toBeInTheDocument();
  });

  it('keeps the dock header to the search toggle — no switch glyphs beside the title', () => {
    renderDock();
    expect(screen.queryByRole('group', { name: 'Layer switches' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Solo' })).not.toBeInTheDocument();
  });

  it('lists the layer switches as labelled menu rows, and settles after one is toggled', async () => {
    // The switch rows are derived from scene state, so toggling one MUST
    // change the menu — the case the memo has to get right without looping.
    renderDock();
    openHeaderMenu();
    for (const label of ['Visible', 'Solo', 'Lock']) expect(screen.getByText(label)).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByText('Solo'));
    });
    await act(async () => { await engineIdle(); });
    expect(defaultSceneGraph.getNode(ID)?.solo).toBe(true);
    expect(loopWarnings).toEqual([]);
  });

  it('takes its rows back out when another panel becomes active', () => {
    renderDock();
    act(() => useLayoutStore.getState().openPanel(OTHER));
    expect(screen.getByText('other panel')).toBeInTheDocument();
    openHeaderMenu();
    expect(screen.queryByText(LANES_ROW)).not.toBeInTheDocument();
    expect(loopWarnings).toEqual([]);
  });
});
