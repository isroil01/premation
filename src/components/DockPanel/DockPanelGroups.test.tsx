/**
 * A dock column of panel groups, driven the way a user does it: tabs and
 * stacked groups at once, drag a tab between groups or into a gap, collapse a
 * group with its twirl, reach clipped tabs through the », see the subject in
 * the tab.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { DockPanel, useDockPanelHeader } from './DockPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useLayoutStore } from '@stores/layoutStore';

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
  useLayoutStore.getState().setCollapsed('rightInspector', false);
}

/** A panel that names its subject, the way Properties says "Properties: <layer>". */
function SubjectPanel(): JSX.Element {
  const header = useDockPanelHeader();
  const setTitleDetail = header?.setTitleDetail;
  useEffect(() => {
    setTitleDetail?.('Light 1');
    return () => setTitleDetail?.(null);
  }, [setTitleDetail]);
  return <div>properties body</div>;
}

const renderers = {
  properties: () => <SubjectPanel />,
  info: () => <div>info body</div>,
  audio: () => <div>audio body</div>,
  preview: () => <div>preview body</div>,
  effects: () => <div>effects body</div>,
};

const TITLES: Record<string, string> = {
  properties: 'Properties',
  info: 'Info',
  audio: 'Audio',
  preview: 'Preview',
  effects: 'Effects & Presets',
};

function mount(): void {
  act(() => {
    const s = useLayoutStore.getState();
    for (const id of Object.keys(renderers)) s.registerPanel({ id, region: 'rightInspector', title: TITLES[id]!, closable: true });
    s.openPanel('properties');
  });
  render(<TooltipProvider><DockPanel region="rightInspector" renderers={renderers} /></TooltipProvider>);
}

const panelGroups = (): string[][] => useLayoutStore.getState().dockGroups.rightInspector.map((g) => g.panels);

/** A minimal DataTransfer: jsdom has none. */
function dataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    setData: (k: string, v: string) => { data.set(k, v); },
    getData: (k: string) => data.get(k) ?? '',
  } as unknown as DataTransfer;
}

describe('a dock column of panel groups', () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  });
  beforeEach(resetLayoutStore);

  it('draws tabs and stacked groups at once: [Info | Audio] is one strip under Properties', () => {
    mount();
    const lists = screen.getAllByRole('tablist');
    expect(lists.map((l) => within(l).getAllByRole('tab').map((t) => t.getAttribute('aria-label')))).toEqual([
      ['Properties'],
      ['Info', 'Audio'],
      ['Preview'],
      ['Effects & Presets'],
    ]);
    // Properties open; the rest collapsed to their strips, bodies not mounted.
    expect(screen.getByText('properties body')).toBeInTheDocument();
    expect(screen.queryByText('info body')).not.toBeInTheDocument();
  });

  it('prints the subject after the title in the front tab, keeping the tab\'s name', () => {
    mount();
    const t = screen.getByRole('tab', { name: 'Properties' });
    expect(t.textContent).toBe('Properties: Light 1');
  });

  it('clicking a collapsed group\'s tab opens the group with that panel in front', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Audio' }));
    expect(screen.getByText('audio body')).toBeInTheDocument();
    // Properties stays open above it: two groups open at once.
    expect(screen.getByText('properties body')).toBeInTheDocument();
  });

  it('the twirl collapses and expands a group', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Properties' }));
    expect(screen.queryByText('properties body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Properties' }));
    expect(screen.getByText('properties body')).toBeInTheDocument();
  });

  it('double-clicking a tab flips its group: a collapsed one opens and stays open, an open one collapses', () => {
    mount();
    const dbl = (el: HTMLElement): void => {
      fireEvent.mouseDown(el, { detail: 1 });
      fireEvent.click(el, { detail: 1 });
      fireEvent.mouseDown(el, { detail: 2 });
      fireEvent.click(el, { detail: 2 });
      fireEvent.doubleClick(el, { detail: 2 });
    };
    dbl(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByText('preview body')).toBeInTheDocument();
    dbl(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.queryByText('preview body')).not.toBeInTheDocument();
  });

  it('dragging a tab onto another strip makes it a tab of that group', () => {
    mount();
    const dt = dataTransfer();
    const effects = screen.getByRole('tab', { name: 'Effects & Presets' }).parentElement!;
    const previewStrip = screen.getByRole('tab', { name: 'Preview' }).closest('[role="tablist"]')!.parentElement!.parentElement!;
    fireEvent.dragStart(effects, { dataTransfer: dt });
    fireEvent.dragOver(previewStrip, { dataTransfer: dt, clientX: 0 });
    fireEvent.drop(previewStrip, { dataTransfer: dt, clientX: 0 });
    expect(panelGroups()).toEqual([['properties'], ['info', 'audio'], ['preview', 'effects']]);
  });

  it('dragging a tab into a gap between groups gives it a group of its own', () => {
    mount();
    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByRole('tab', { name: 'Audio' }).parentElement!, { dataTransfer: dt });
    // While dragging, every gap is a drop zone; gap 1 is between Properties and [Info | Audio].
    const gap = document.querySelector('[data-dock-seam="1"]')!;
    fireEvent.dragOver(gap, { dataTransfer: dt });
    fireEvent.drop(gap, { dataTransfer: dt });
    expect(panelGroups()).toEqual([['properties'], ['audio'], ['info'], ['preview'], ['effects']]);
  });

  it('shows a » listing every tab of a group whose tabs do not fit', () => {
    // jsdom lays nothing out: report a strip narrower than its tabs.
    const sw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const cw = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.getAttribute('role') === 'tablist' && this.children.length > 1 ? 400 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.getAttribute('role') === 'tablist' ? 160 : 0; },
    });
    try {
      mount();
      const overflow = screen.getAllByRole('button', { name: 'All panels in this group' });
      // Only the [Info | Audio] strip has more than one tab here.
      expect(overflow).toHaveLength(1);
      fireEvent.click(overflow[0]!);
      fireEvent.click(screen.getByRole('menuitem', { name: /Audio/ }));
      expect(screen.getByText('audio body')).toBeInTheDocument();
    } finally {
      if (sw) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', sw);
      if (cw) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cw);
    }
  });

  it('a group\'s ≡ menu moves the front panel into a group of its own and merges groups', () => {
    mount();
    act(() => useLayoutStore.getState().openPanel('audio'));
    const audioGroup = screen.getByRole('tab', { name: 'Audio' }).closest('section')!;
    fireEvent.click(within(audioGroup).getByRole('button', { name: 'Panel options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to New Group' }));
    expect(panelGroups()).toEqual([['properties'], ['info'], ['audio'], ['preview'], ['effects']]);

    const audioAlone = screen.getByRole('tab', { name: 'Audio' }).closest('section')!;
    fireEvent.click(within(audioAlone).getByRole('button', { name: 'Panel options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Merge with Group Above' }));
    expect(panelGroups()).toEqual([['properties'], ['info', 'audio'], ['preview'], ['effects']]);
  });
});
