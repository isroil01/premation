/**
 * Installed plugins' panels in the dock (owner board 2, 2026-11-03): their own
 * icon on the tab, and a section of their own in the "+" / Open Panel lists
 * once closed — on either side, opened into the group the menu belongs to.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { DockPanel, closedExtraPanels } from './DockPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useLayoutStore, type PanelRegistration } from '@stores/layoutStore';

const GLOW = 'plugin:premation.deepglow';
const PALETTES = 'plugin:atelier/palettes';

function reg(over: Partial<PanelRegistration> & { id: string; title: string }): PanelRegistration {
  return { region: 'rightInspector', closable: true, onDemand: true, icon: 'plugin', ...over };
}

beforeEach(() => {
  useLayoutStore.setState({
    panels: {},
    panelOrder: {
      leftSidebar: [],
      leftSidebar_bottom: [],
      rightInspector: [],
      rightInspector_bottom: [],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: {},
    dockGroups: { leftSidebar: [], rightInspector: [] },
  });
  const s = useLayoutStore.getState();
  s.registerPanel({ id: 'properties', title: 'Properties', icon: 'sliders', region: 'rightInspector', closable: true });
  s.registerPanel({ id: 'assets', title: 'Project', icon: 'folder', region: 'leftSidebar', closable: true });
  s.registerPanel(reg({ id: GLOW, title: 'Deep Glow Studio', iconUrl: 'plugin-ui://premation.deepglow/icon.png' }));
  s.registerPanel(reg({ id: PALETTES, title: 'Palettes', menuTitle: 'Atelier: Palettes', iconUrl: null }));
});

describe('closedExtraPanels', () => {
  it('lists registered panels that are not built in and not docked anywhere', () => {
    expect(closedExtraPanels(useLayoutStore.getState().panels, useLayoutStore.getState().panelOrder)).toEqual([]);
    act(() => useLayoutStore.getState().closePanel(PALETTES));
    const ids = closedExtraPanels(useLayoutStore.getState().panels, useLayoutStore.getState().panelOrder).map((p) => p.id);
    // Never a built-in panel (closed Properties is the built-in list's), never a docked one.
    act(() => useLayoutStore.getState().closePanel('properties'));
    expect(ids).toEqual([PALETTES]);
    expect(closedExtraPanels(useLayoutStore.getState().panels, useLayoutStore.getState().panelOrder).map((p) => p.id)).toEqual([PALETTES]);
  });

  it('never lists a plugin that is not loaded (parked: no registration)', () => {
    act(() => useLayoutStore.getState().closePanel(PALETTES));
    act(() => useLayoutStore.getState().parkPanel(PALETTES));
    expect(closedExtraPanels(useLayoutStore.getState().panels, useLayoutStore.getState().panelOrder)).toEqual([]);
  });
});

describe('plugin tabs', () => {
  it('draw the plugin\'s own icon (alt="") or the generic glyph; built-in tabs stay text only', () => {
    const { container } = render(<TooltipProvider><DockPanel region="rightInspector" renderers={{}} /></TooltipProvider>);
    const glow = screen.getByRole('tab', { name: 'Deep Glow Studio' });
    const img = glow.querySelector('img');
    expect(img?.getAttribute('src')).toBe('plugin-ui://premation.deepglow/icon.png');
    expect(img?.getAttribute('alt')).toBe('');
    expect(glow.textContent).toBe('Deep Glow Studio');
    expect(screen.getByRole('tab', { name: 'Palettes' }).querySelector('img')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Palettes' }).querySelector('svg, span[class*="tabIcon"], [class*="tabIcon"]')).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Properties' }).querySelector('[class*="tabIcon"]')).toBeNull();
    expect(container).toBeTruthy();
  });

  it('a parked plugin panel leaves the strip but keeps its place', () => {
    render(<TooltipProvider><DockPanel region="rightInspector" renderers={{}} /></TooltipProvider>);
    act(() => useLayoutStore.getState().parkPanel(GLOW));
    expect(screen.queryByRole('tab', { name: 'Deep Glow Studio' })).toBeNull();
    expect(useLayoutStore.getState().panelOrder.rightInspector).toContain(GLOW);
  });

  it('a closed one is offered by the "+" on the other side, under Extensions, and opens there', () => {
    act(() => useLayoutStore.getState().closePanel(PALETTES));
    render(<TooltipProvider><DockPanel region="leftSidebar" renderers={{}} /></TooltipProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open a sidebar panel' }));
    expect(screen.getByText('Extensions')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Atelier: Palettes'));
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toContain(PALETTES);
  });
});
