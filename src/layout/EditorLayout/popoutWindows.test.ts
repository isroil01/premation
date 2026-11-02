/**
 * Pop-out windows follow the layout store's `externalPanels`: undocking takes a
 * panel out of its dock and opens one window, re-docking closes it, and the
 * user closing the window puts the panel back where it was.
 */

import { useLayoutStore, type RegionId } from '@stores/layoutStore';
import { installPopoutWindows, popOutPanel } from './popoutWindows';

const EMPTY_ORDER: Record<RegionId, string[]> = {
  leftSidebar: [],
  leftSidebar_bottom: [],
  rightInspector: [],
  rightInspector_bottom: [],
  centerWorkspace: [],
  bottomTimeline: [],
};

interface FakeBridge {
  spawnWindow: jest.Mock;
  close: jest.Mock;
  list: jest.Mock;
  onClosed: jest.Mock;
  /** Main reporting that the window of `panelId` closed. */
  fireClosed(panelId: string): void;
}

function fakeBridge(open: string[] = []): FakeBridge {
  let closed: ((id: string) => void) | null = null;
  return {
    spawnWindow: jest.fn(),
    close: jest.fn(async () => undefined),
    list: jest.fn(async () => open),
    onClosed: jest.fn((h: (id: string) => void) => {
      closed = h;
      return () => { closed = null; };
    }),
    fireClosed: (id) => closed?.(id),
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const side = (): string[] => [...(useLayoutStore.getState().panelOrder.leftSidebar ?? [])];

let bridge: FakeBridge;
let teardown: () => void;

async function install(open: string[] = []): Promise<void> {
  bridge = fakeBridge(open);
  (window as unknown as { motionEditor: unknown }).motionEditor = { popout: bridge };
  teardown = installPopoutWindows();
  await flush();
}

beforeEach(() => {
  useLayoutStore.setState({
    panels: {},
    panelOrder: { ...EMPTY_ORDER },
    activePanelByRegion: {},
    dockGroups: { leftSidebar: [], rightInspector: [] },
    externalPanels: [],
  });
  for (const id of ['assets', 'effectControls']) useLayoutStore.getState().registerPanel({ id, region: 'leftSidebar', title: id });
});

afterEach(() => {
  teardown?.();
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('pop-out windows', () => {
  it('undocking a sidebar panel takes it out of the dock and opens one window', async () => {
    await install();
    popOutPanel('effectControls');
    expect(side()).toEqual(['assets']);
    expect(useLayoutStore.getState().externalPanels).toEqual(['effectControls']);
    expect(bridge.spawnWindow).toHaveBeenCalledTimes(1);
    expect(bridge.spawnWindow).toHaveBeenCalledWith('effectControls');
  });

  it('undocking a panel that is already out brings its window forward instead of opening another', async () => {
    await install();
    popOutPanel('effectControls');
    popOutPanel('effectControls');
    expect(useLayoutStore.getState().externalPanels).toEqual(['effectControls']);
    // Main focuses an existing window rather than making a second one.
    expect(bridge.spawnWindow).toHaveBeenCalledTimes(2);
  });

  it('closing the window docks the panel back in its side', async () => {
    await install();
    popOutPanel('effectControls');
    bridge.fireClosed('effectControls');
    expect(useLayoutStore.getState().externalPanels).toEqual([]);
    expect(side()).toContain('effectControls');
  });

  it('re-docking from the editor closes the window', async () => {
    await install();
    popOutPanel('timeline');
    expect(bridge.spawnWindow).toHaveBeenCalledWith('timeline');
    useLayoutStore.getState().dockPanel('timeline');
    expect(useLayoutStore.getState().externalPanels).toEqual([]);
    expect(bridge.close).toHaveBeenCalledWith('timeline');
  });

  it('the viewport and timeline are tracked though they are not registered panels', async () => {
    await install();
    popOutPanel('viewport');
    expect(useLayoutStore.getState().externalPanels).toEqual(['viewport']);
    bridge.fireClosed('viewport');
    expect(useLayoutStore.getState().externalPanels).toEqual([]);
  });

  it('adopts windows that outlived a reload of the editor page without reopening them', async () => {
    await install(['timeline']);
    expect(useLayoutStore.getState().externalPanels).toEqual(['timeline']);
    expect(bridge.spawnWindow).not.toHaveBeenCalled();
  });

  it('opens windows for panels a workspace marked external before it ran', async () => {
    useLayoutStore.getState().popoutPanel('viewport');
    await install();
    expect(bridge.spawnWindow).toHaveBeenCalledWith('viewport');
  });
});
