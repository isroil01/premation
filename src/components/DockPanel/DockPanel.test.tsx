/**
 * DockPanel hook-order regression.
 *
 * The header's `visibleItems` memo used to sit BELOW the
 * `if (allItems.length === 0) return null` guard. A region that rendered
 * while empty therefore ran one fewer hook than the same region once a
 * panel appeared in it, and React tore the editor down with
 * "Rendered more hooks than during the previous render."
 */

import { act, render } from '@testing-library/react';
import { DockPanel } from './DockPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useLayoutStore } from '@stores/layoutStore';

function resetLayoutStore(): void {
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
  });
}

describe('DockPanel', () => {
  beforeEach(resetLayoutStore);

  it('survives an empty region gaining a panel', () => {
    const renderers = { alpha: () => <div>alpha body</div> };

    // First render: region is empty, component bails out early.
    // Rail tabs carry Radix tooltips, which need the provider main.tsx mounts.
    const { container } = render(<TooltipProvider><DockPanel region="rightInspector" renderers={renderers} /></TooltipProvider>);
    expect(container).toBeEmptyDOMElement();

    // Second render: a panel arrives. Hook count must not change.
    act(() => {
      useLayoutStore.getState().registerPanel({
        id: 'alpha',
        region: 'rightInspector',
        title: 'Alpha',
      });
    });

    expect(container.textContent).toContain('alpha body');
  });

  it('survives a region losing its last panel and getting it back', () => {
    const renderers = { alpha: () => <div>alpha body</div> };

    act(() => {
      useLayoutStore.getState().registerPanel({
        id: 'alpha',
        region: 'rightInspector',
        title: 'Alpha',
        closable: true,
      });
    });

    // Rail tabs carry Radix tooltips, which need the provider main.tsx mounts.
    const { container } = render(<TooltipProvider><DockPanel region="rightInspector" renderers={renderers} /></TooltipProvider>);
    expect(container.textContent).toContain('alpha body');

    act(() => useLayoutStore.getState().closePanel('alpha'));
    expect(container).toBeEmptyDOMElement();

    act(() => useLayoutStore.getState().openPanel('alpha'));
    expect(container.textContent).toContain('alpha body');
  });
});
