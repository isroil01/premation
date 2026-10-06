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
import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { PropertiesPanel } from './PropertiesPanel';

let ID = '';
let h: Harness;
const OTHER = 'dock_menu_probe_other_panel';
const LANES_ROW = 'Keyframe lanes under animated rows';

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

// Every bar of the inspector stack carries a ≡ (2026-10); Properties is the
// first panel, so its menu is the first one.
function openHeaderMenu(): void {
  fireEvent.click(screen.getAllByRole('button', { name: 'Panel options' })[0]!);
}

let loopWarnings: string[] = [];
let errorSpy: jest.SpyInstance;
const realError = console.error;

beforeEach(async () => {
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

  h = await setupAppEngine({ panels: true });
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'dock_menu_probe_layer', init: [] } as Command) as { layer: string }).layer;
  await settleEdits();
  await documentMirror().loadTree(ID);
  useSelectionStore.setState({ ids: [ID] } as never);
});

afterEach(async () => {
  cleanup();
  errorSpy.mockRestore();
  useSelectionStore.setState({ ids: [] } as never);
  await h.dispose();
});

describe('PropertiesPanel in a DockPanel with a layer selected', () => {
  it('mounts without an update loop', async () => {
    renderDock();
    // Positive control: the selection really reached the panel — the search
    // button only renders (portalled into the dock header) for a live layer.
    expect(await screen.findByRole('button', { name: 'Search properties' })).toBeInTheDocument();
    expect(loopWarnings).toEqual([]);
  });

  it('settles again when an input of the menu changes', () => {
    renderDock();
    act(() => {
      const prefs = usePreferenceStore.getState();
      prefs.set('inspectorShowLane', !prefs.inspectorShowLane);
    });
    expect(loopWarnings).toEqual([]);
  });

  it('hands its rows to the dock header menu', async () => {
    // DockPanel clears the custom rows when the active panel changes. Its
    // effect runs AFTER the child's on the same commit, so a naive clear wiped
    // the rows the panel had just handed over — the loop above had been
    // re-handing them every pass, which is the only reason they ever showed.
    renderDock();
    await screen.findByRole('button', { name: 'Search properties' });
    openHeaderMenu();
    expect(await screen.findByText(LANES_ROW)).toBeInTheDocument();
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
    await screen.findByRole('button', { name: 'Search properties' });
    openHeaderMenu();
    for (const label of ['Visible', 'Solo', 'Lock']) expect(await screen.findByText(label)).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByText('Solo'));
    });
    await act(async () => { await settleEdits(); });
    expect(documentMirror().layer(ID)?.switches.solo).toBe(true);
    expect(loopWarnings).toEqual([]);
  });

  // The inspector is a stack (2026-10): opening another panel leaves Properties
  // open above it, and each open panel has its OWN options menu. What must
  // still hold is that one panel's rows never show up in another panel's menu.
  it('keeps its rows out of another open panel\x27s menu', () => {
    renderDock();
    act(() => useLayoutStore.getState().openPanel(OTHER));
    expect(screen.getByText('other panel')).toBeInTheDocument();
    const menus = screen.getAllByRole('button', { name: 'Panel options' });
    expect(menus).toHaveLength(2);
    fireEvent.click(menus[1]!);
    expect(screen.queryByText(LANES_ROW)).not.toBeInTheDocument();
    expect(loopWarnings).toEqual([]);
  });
});
