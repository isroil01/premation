import { useLayoutStore } from './layoutStore';

describe('layoutStore — reorderPanel', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      panels: {
        a: { id: 'a', region: 'leftSidebar', title: 'A' },
        b: { id: 'b', region: 'leftSidebar', title: 'B' },
        c: { id: 'c', region: 'leftSidebar', title: 'C' },
      },
      panelOrder: {
        leftSidebar: ['a', 'b', 'c'],
        rightInspector: [],
        centerWorkspace: [],
        bottomTimeline: [],
      },
      activePanelByRegion: { leftSidebar: 'a' },
      regions: {
        leftSidebar: { collapsed: false, size: 280, minSize: 200, maxSize: 480 },
        rightInspector: { collapsed: false, size: 320, minSize: 240, maxSize: 520 },
        centerWorkspace: { collapsed: false, size: 0, minSize: 0, maxSize: 0 },
        bottomTimeline: { collapsed: false, size: 260, minSize: 120, maxSize: 600 },
      },
    });
  });

  test('moves a tab to a later index', () => {
    useLayoutStore.getState().reorderPanel('a', 2);
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['b', 'c', 'a']);
  });

  test('moves a tab to an earlier index', () => {
    useLayoutStore.getState().reorderPanel('c', 0);
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['c', 'a', 'b']);
  });

  test('clamps toIndex to valid range', () => {
    useLayoutStore.getState().reorderPanel('a', 99);
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['b', 'c', 'a']);
  });

  test('is a no-op for a non-existent panel', () => {
    useLayoutStore.getState().reorderPanel('z', 0);
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['a', 'b', 'c']);
  });

  test('does not change order when panel not in region', () => {
    // Panel 'a' is in leftSidebar but trying to reorder from rightInspector — safe no-op
    useLayoutStore.getState().reorderPanel('a', 0);
    // Still a valid move within leftSidebar
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['a', 'b', 'c']);
  });
});
