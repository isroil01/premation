/**
 * The labelled rail and its "+".
 *
 * When the rails were cut to the everyday panels (2026-09-15), everything else
 * went on demand — so the rail itself has to say what each tab is, and has to
 * offer the panels it no longer shows. Both are asserted here against the REAL
 * panel registry, because the "+" list is derived from it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { DockPanel, closedPanelDefsForSide } from './DockPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useLayoutStore } from '@stores/layoutStore';
import { PANEL_DEFS } from '@layout/EditorLayout/panelDefs';

function registerAll(): void {
  const s = useLayoutStore.getState();
  for (const d of PANEL_DEFS) {
    s.registerPanel({ id: d.id, title: d.title, icon: d.icon, region: d.region, closable: d.closable, onDemand: d.onDemand });
    if (d.onDemand) s.closePanel(d.id);
  }
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
    leftSidebarSplit: false,
    rightInspectorSplit: false,
  });
});

describe('closedPanelDefsForSide', () => {
  it('lists this side\'s undocked panels, and none docked in either pane', () => {
    const ids = closedPanelDefsForSide('leftSidebar', {
      leftSidebar: ['assets', 'library'],
      leftSidebar_bottom: ['scene'],
    }).map((d) => d.id);
    expect(ids).toContain('effectControls');
    expect(ids).not.toContain('scene');
    expect(ids).not.toContain('assets');
    // Never the other side's panels.
    expect(ids).not.toContain('scopes');
  });
});

describe('the rail', () => {
  it('prints each tab\'s name under its glyph, using the short title where one exists', () => {
    act(registerAll);
    act(() => useLayoutStore.getState().openPanel('effectControls'));
    render(<TooltipProvider><DockPanel region="leftSidebar" renderers={{}} /></TooltipProvider>);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(tabs.map((t) => t.getAttribute('aria-label')));
    expect(tabs.map((t) => t.textContent)).toEqual(['Project', 'Effect Controls', 'Layers']);
    expect(screen.getByRole('tab', { name: 'Effect Controls' })).toBeInTheDocument();
  });

  it('offers the closed panels from "+" and docks the one picked', () => {
    act(registerAll);
    render(<TooltipProvider><DockPanel region="rightInspector" renderers={{}} /></TooltipProvider>);
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual([
      'Properties',
      'Info',
      'Audio',
      'Preview',
      'Effects & Presets',
      'Align',
      'Character',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Open an inspector panel' }));
    expect(screen.getByText('Scopes')).toBeInTheDocument();
    expect(screen.queryByText('Project')).not.toBeInTheDocument();

    act(() => { fireEvent.click(screen.getByText('Scopes')); });
    const s = useLayoutStore.getState();
    expect(s.panelOrder.rightInspector).toEqual(['properties', 'info', 'audio', 'preview', 'effects', 'align', 'character', 'scopes']);
    expect(s.activePanelByRegion.rightInspector).toBe('scopes');
  });
});
