import { useLayoutStore } from './layoutStore';

describe('sidebar split layout', () => {
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

  it('splits left sidebar and distributes panels between top and bottom', () => {
    const store = useLayoutStore.getState();
    store.registerPanel({ id: 'scene', region: 'leftSidebar', title: 'Scene' });
    store.registerPanel({ id: 'effectControls', region: 'leftSidebar', title: 'Effect Controls' });
    store.registerPanel({ id: 'assets', region: 'leftSidebar', title: 'Assets' });
    store.registerPanel({ id: 'library', region: 'leftSidebar', title: 'Library' });

    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['scene', 'effectControls', 'assets', 'library']);
    expect(useLayoutStore.getState().leftSidebarSplit).toBe(false);

    // Split left sidebar
    store.splitSidebar('left');

    const state = useLayoutStore.getState();
    expect(state.leftSidebarSplit).toBe(true);
    expect(state.panelOrder.leftSidebar).toEqual(['scene', 'effectControls']);
    expect(state.panelOrder.leftSidebar_bottom).toEqual(['assets', 'library']);
    expect(state.activePanelByRegion.leftSidebar).toBe('scene');
    expect(state.activePanelByRegion.leftSidebar_bottom).toBe('assets');
  });

  it('unsplits left sidebar and cleanly merges bottom panels back into top dock', () => {
    const store = useLayoutStore.getState();
    store.registerPanel({ id: 'scene', region: 'leftSidebar', title: 'Scene' });
    store.registerPanel({ id: 'assets', region: 'leftSidebar', title: 'Assets' });

    store.splitSidebar('left');
    expect(useLayoutStore.getState().leftSidebarSplit).toBe(true);
    expect(useLayoutStore.getState().panelOrder.leftSidebar_bottom).toEqual(['assets']);

    // Unsplit left sidebar
    store.unsplitSidebar('left');

    const state = useLayoutStore.getState();
    expect(state.leftSidebarSplit).toBe(false);
    expect(state.panelOrder.leftSidebar).toEqual(['scene', 'assets']);
    expect(state.panelOrder.leftSidebar_bottom).toEqual([]);
    expect(state.panels['assets']?.region).toBe('leftSidebar');
  });

  it('splits right inspector and supports moving tabs between top and bottom', () => {
    const store = useLayoutStore.getState();
    store.registerPanel({ id: 'properties', region: 'rightInspector', title: 'Properties' });
    store.registerPanel({ id: 'align', region: 'rightInspector', title: 'Align' });
    store.registerPanel({ id: 'effects', region: 'rightInspector', title: 'Effects' });

    store.splitSidebar('right');
    expect(useLayoutStore.getState().rightInspectorSplit).toBe(true);
    expect(useLayoutStore.getState().panelOrder.rightInspector).toEqual(['properties', 'align']);
    expect(useLayoutStore.getState().panelOrder.rightInspector_bottom).toEqual(['effects']);

    // Move 'align' to bottom pane
    store.movePanel('align', 'rightInspector_bottom', 0);
    expect(useLayoutStore.getState().panelOrder.rightInspector).toEqual(['properties']);
    expect(useLayoutStore.getState().panelOrder.rightInspector_bottom).toEqual(['align', 'effects']);
    expect(useLayoutStore.getState().panels['align']?.region).toBe('rightInspector_bottom');

    // Unsplit merges all back
    store.unsplitSidebar('right');
    expect(useLayoutStore.getState().rightInspectorSplit).toBe(false);
    expect(useLayoutStore.getState().panelOrder.rightInspector).toEqual(['properties', 'align', 'effects']);
    expect(useLayoutStore.getState().panelOrder.rightInspector_bottom).toEqual([]);
  });
});
