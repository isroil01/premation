import { captureRegions, listLayouts, applyLayout, BUILTIN_LAYOUTS } from './workspaceLayouts';
import { useLayoutStore, type LayoutMap } from '@stores/layoutStore';

const regions = (): LayoutMap => useLayoutStore.getState().regions;

beforeEach(() => {
  useLayoutStore.getState().resetLayout();
});

describe('captureRegions', () => {
  test('snapshots size + collapsed and skips the center workspace', () => {
    const snap = captureRegions(regions());
    expect(snap.leftSidebar).toEqual({ size: 340, collapsed: false });
    expect(snap.bottomTimeline?.size).toBe(260);
    expect(snap).not.toHaveProperty('centerWorkspace');
  });
});

describe('listLayouts', () => {
  test('always includes the built-in presets', () => {
    const names = listLayouts().map((l) => l.name);
    for (const b of BUILTIN_LAYOUTS) expect(names).toContain(b.name);
  });
});

describe('applyLayout', () => {
  test('Minimal collapses the side + bottom regions', () => {
    expect(applyLayout('Minimal')).toBe(true);
    expect(regions().leftSidebar.collapsed).toBe(true);
    expect(regions().rightInspector.collapsed).toBe(true);
    expect(regions().bottomTimeline.collapsed).toBe(true);
  });

  test('Animation gives the timeline a tall height', () => {
    applyLayout('Animation');
    expect(regions().bottomTimeline.size).toBe(420);
    expect(regions().bottomTimeline.collapsed).toBe(false);
  });

  test('unknown layout returns false and changes nothing', () => {
    const before = regions().leftSidebar.size;
    expect(applyLayout('nope')).toBe(false);
    expect(regions().leftSidebar.size).toBe(before);
  });
});

describe('layoutStore.applyWorkspaceLayout', () => {
  test('clamps sizes to the region min/max', () => {
    useLayoutStore.getState().applyWorkspaceLayout({
      name: 'Test',
      regions: {
        leftSidebar: { size: 9999, collapsed: false }
      }
    });
    // leftSidebar maxSize is 640.
    expect(regions().leftSidebar.size).toBe(640);
  });
});
