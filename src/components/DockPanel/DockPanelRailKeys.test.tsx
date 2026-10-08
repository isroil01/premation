/**
 * Keyboard traversal of a dock column.
 *
 * Each group's strip is a `role="tablist"` with a roving tabindex: Left /
 * Right walk its tabs (wrapping), Home / End jump, Enter / Space bring the
 * focused tab forward. Up / Down move to the front tab of the group above or
 * below, so the whole column is reachable without a mouse.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { DockPanel } from './DockPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useLayoutStore } from '@stores/layoutStore';

// jsdom has no ResizeObserver, and Radix tooltips construct one when their content mounts.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

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
    dockGroups: { leftSidebar: [], rightInspector: [] },
  });
}

const renderers = {
  alpha: () => <div>alpha body</div>,
  beta: () => <div>beta body</div>,
  gamma: () => <div>gamma body</div>,
  delta: () => <div>delta body</div>,
};

/** [Alpha | Beta | Gamma] as one group, [Delta] below it. */
function mount(): void {
  act(() => {
    const s = useLayoutStore.getState();
    for (const [id, title] of [['alpha', 'Alpha'], ['beta', 'Beta'], ['gamma', 'Gamma'], ['delta', 'Delta']] as const) {
      s.registerPanel({ id, region: 'rightInspector', title });
    }
    const top = useLayoutStore.getState().dockGroups.rightInspector[0]!.id;
    useLayoutStore.getState().movePanelToGroup('beta', top);
    useLayoutStore.getState().movePanelToGroup('gamma', top);
    useLayoutStore.getState().openPanel('alpha');
  });
  render(<TooltipProvider><DockPanel region="rightInspector" renderers={renderers} /></TooltipProvider>);
}

const tab = (name: string): HTMLElement => screen.getByRole('tab', { name });

describe('DockPanel keyboard traversal', () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  });

  beforeEach(resetLayoutStore);

  it('puts one tab per group in the tab order — its front tab', () => {
    mount();
    expect(tab('Alpha').tabIndex).toBe(0);
    expect(tab('Beta').tabIndex).toBe(-1);
    expect(tab('Gamma').tabIndex).toBe(-1);
    expect(tab('Delta').tabIndex).toBe(0);
  });

  it('ArrowRight / ArrowLeft move focus within the group, wrapping, without activating', () => {
    mount();
    tab('Alpha').focus();
    fireEvent.keyDown(tab('Alpha'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Beta'));
    expect(tab('Beta').tabIndex).toBe(0);
    expect(tab('Alpha').tabIndex).toBe(-1);
    expect(screen.getByText('alpha body')).toBeInTheDocument();

    fireEvent.keyDown(tab('Beta'), { key: 'ArrowLeft' });
    fireEvent.keyDown(tab('Alpha'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('Gamma'));
    fireEvent.keyDown(tab('Gamma'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Alpha'));
  });

  it('Home and End jump to the group\'s first and last tab', () => {
    mount();
    tab('Alpha').focus();
    fireEvent.keyDown(tab('Alpha'), { key: 'End' });
    expect(document.activeElement).toBe(tab('Gamma'));
    fireEvent.keyDown(tab('Gamma'), { key: 'Home' });
    expect(document.activeElement).toBe(tab('Alpha'));
  });

  it('ArrowDown / ArrowUp move to the front tab of the next / previous group', () => {
    mount();
    tab('Alpha').focus();
    fireEvent.keyDown(tab('Alpha'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tab('Delta'));
    fireEvent.keyDown(tab('Delta'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(tab('Alpha'));
  });

  it('Enter and Space bring the focused tab forward', () => {
    mount();
    tab('Alpha').focus();
    fireEvent.keyDown(tab('Alpha'), { key: 'ArrowRight' });
    fireEvent.keyDown(tab('Beta'), { key: 'Enter' });
    expect(screen.getByText('beta body')).toBeInTheDocument();
    expect(useLayoutStore.getState().activePanelByRegion.rightInspector).toBe('beta');

    fireEvent.keyDown(tab('Beta'), { key: 'ArrowRight' });
    fireEvent.keyDown(tab('Gamma'), { key: ' ' });
    expect(screen.getByText('gamma body')).toBeInTheDocument();
  });
});
