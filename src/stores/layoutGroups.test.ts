/**
 * Panel groups in the layout store: tabs within a group and groups stacked in
 * a column, both at once (2026-10) — what replaced the per-side "tabs OR
 * stack" chrome and the fixed two-pane split.
 */

import { useLayoutStore, type RegionId } from './layoutStore';

const EMPTY_ORDER: Record<RegionId, string[]> = {
  leftSidebar: [],
  leftSidebar_bottom: [],
  rightInspector: [],
  rightInspector_bottom: [],
  centerWorkspace: [],
  bottomTimeline: [],
};

function reset(): void {
  useLayoutStore.setState({
    panels: {},
    panelOrder: { ...EMPTY_ORDER },
    activePanelByRegion: {},
    dockGroups: { leftSidebar: [], rightInspector: [] },
    externalPanels: [],
  });
  const s = useLayoutStore.getState();
  s.setCollapsed('leftSidebar', false);
  s.setCollapsed('rightInspector', false);
}

const groups = (side: 'leftSidebar' | 'rightInspector'): string[][] =>
  useLayoutStore.getState().dockGroups[side].map((g) => g.panels);
const groupOf = (side: 'leftSidebar' | 'rightInspector', id: string) =>
  useLayoutStore.getState().dockGroups[side].find((g) => g.panels.includes(id))!;

function registerRight(...ids: string[]): void {
  for (const id of ids) useLayoutStore.getState().registerPanel({ id, region: 'rightInspector', title: id, closable: true });
}

beforeEach(reset);

describe('default groups as panels register', () => {
  it('builds After Effects\' Default right column: Properties open, [Info | Audio], the rest collapsed', () => {
    registerRight('properties', 'info', 'audio', 'preview', 'effects', 'align', 'character');
    expect(groups('rightInspector')).toEqual([['properties'], ['info', 'audio'], ['preview'], ['effects'], ['align'], ['character']]);
    expect(useLayoutStore.getState().dockGroups.rightInspector.map((g) => g.collapsed)).toEqual([false, true, true, true, true, true]);
    // panelOrder is the groups flattened — what the Window menu and the "+" read.
    expect(useLayoutStore.getState().panelOrder.rightInspector).toEqual(['properties', 'info', 'audio', 'preview', 'effects', 'align', 'character']);
  });

  it('makes the left sidebar one group of tabs', () => {
    const s = useLayoutStore.getState();
    for (const id of ['assets', 'effectControls', 'scene']) s.registerPanel({ id, region: 'leftSidebar', title: id });
    expect(groups('leftSidebar')).toEqual([['assets', 'effectControls', 'scene']]);
  });
});

describe('opening and closing', () => {
  it('opening a panel brings it to the front of its group and opens the group', () => {
    registerRight('properties', 'info', 'audio');
    useLayoutStore.getState().openPanel('audio');
    const g = groupOf('rightInspector', 'audio');
    expect(g.active).toBe('audio');
    expect(g.collapsed).toBe(false);
    expect(useLayoutStore.getState().activePanelByRegion.rightInspector).toBe('audio');
  });

  it('opening a closed panel adds it as an open group at the bottom of the right column', () => {
    registerRight('properties', 'scopes');
    useLayoutStore.getState().closePanel('scopes');
    expect(groups('rightInspector')).toEqual([['properties']]);
    useLayoutStore.getState().openPanel('scopes');
    expect(groups('rightInspector')).toEqual([['properties'], ['scopes']]);
    expect(groupOf('rightInspector', 'scopes').collapsed).toBe(false);
  });

  it('closing the front tab brings the next one forward; closing the last removes the group', () => {
    registerRight('properties', 'info', 'audio');
    useLayoutStore.getState().closePanel('info');
    expect(groupOf('rightInspector', 'audio').active).toBe('audio');
    useLayoutStore.getState().closePanel('audio');
    expect(groups('rightInspector')).toEqual([['properties']]);
  });

  it('opening a panel reopens a hidden sidebar', () => {
    registerRight('properties');
    useLayoutStore.getState().setCollapsed('rightInspector', true);
    useLayoutStore.getState().openPanel('properties');
    expect(useLayoutStore.getState().regions.rightInspector.collapsed).toBe(false);
  });
});

describe('organising: tabs and stacking at the same time', () => {
  it('moves a panel into another group as a tab, at the drop index', () => {
    registerRight('properties', 'preview', 'effects');
    const target = groupOf('rightInspector', 'preview').id;
    useLayoutStore.getState().movePanelToGroup('effects', target, 0);
    expect(groups('rightInspector')).toEqual([['properties'], ['effects', 'preview']]);
    expect(groupOf('rightInspector', 'effects')).toMatchObject({ active: 'effects', collapsed: false });
  });

  it('takes a tab out into a group of its own between two groups', () => {
    registerRight('properties', 'info', 'audio', 'preview');
    // Gap index 1 = between Properties and [Info | Audio].
    useLayoutStore.getState().movePanelToNewGroup('audio', 'rightInspector', 1);
    expect(groups('rightInspector')).toEqual([['properties'], ['audio'], ['info'], ['preview']]);
  });

  it('moving a lone tab to a gap below its own group lands it where the user dropped it', () => {
    registerRight('properties', 'preview', 'effects', 'align');
    // [properties] [preview] [effects] [align] — drop "preview" in the gap
    // between effects and align (index 3 counted with preview still there).
    useLayoutStore.getState().movePanelToNewGroup('preview', 'rightInspector', 3);
    expect(groups('rightInspector')).toEqual([['properties'], ['effects'], ['preview'], ['align']]);
  });

  it('drags a tab across sidebars, into a left group', () => {
    useLayoutStore.getState().registerPanel({ id: 'assets', region: 'leftSidebar', title: 'Project' });
    registerRight('properties', 'align');
    useLayoutStore.getState().movePanelToGroup('align', groupOf('leftSidebar', 'assets').id);
    expect(groups('leftSidebar')).toEqual([['assets', 'align']]);
    expect(groups('rightInspector')).toEqual([['properties']]);
    expect(useLayoutStore.getState().panels.align!.region).toBe('leftSidebar');
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['assets', 'align']);
  });

  it('merges a group into the one above it', () => {
    registerRight('properties', 'preview', 'effects');
    useLayoutStore.getState().mergeGroupUp(groupOf('rightInspector', 'effects').id);
    expect(groups('rightInspector')).toEqual([['properties'], ['preview', 'effects']]);
  });

  it('collapses and expands a group without closing its panels', () => {
    registerRight('properties', 'preview');
    const id = groupOf('rightInspector', 'properties').id;
    useLayoutStore.getState().toggleGroupCollapsed(id);
    expect(groupOf('rightInspector', 'properties').collapsed).toBe(true);
    expect(useLayoutStore.getState().panelOrder.rightInspector).toEqual(['properties', 'preview']);
    useLayoutStore.getState().setGroupCollapsed(id, false);
    expect(groupOf('rightInspector', 'properties').collapsed).toBe(false);
  });

  it('closes every closable panel of a group and keeps a permanent one', () => {
    const s = useLayoutStore.getState();
    s.registerPanel({ id: 'audio', region: 'rightInspector', title: 'Audio', closable: false });
    s.registerPanel({ id: 'info', region: 'rightInspector', title: 'Info', closable: true });
    s.closeGroup(groupOf('rightInspector', 'audio').id);
    expect(groups('rightInspector')).toEqual([['audio']]);
  });

  it('reorders a tab within its group', () => {
    const s = useLayoutStore.getState();
    for (const id of ['a', 'b', 'c']) s.registerPanel({ id, region: 'leftSidebar', title: id });
    s.reorderPanel('a', 2);
    expect(groups('leftSidebar')).toEqual([['b', 'c', 'a']]);
    s.reorderPanel('a', 99);
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['b', 'c', 'a']);
  });

  it('shares heights by weight, normalised to a mean of 1 over the open groups', () => {
    registerRight('properties', 'preview');
    useLayoutStore.getState().openPanel('preview');
    const a = groupOf('rightInspector', 'properties').id;
    const b = groupOf('rightInspector', 'preview').id;
    useLayoutStore.getState().setGroupWeights('rightInspector', { [a]: 300, [b]: 100 });
    expect(groupOf('rightInspector', 'properties').weight).toBeCloseTo(1.5);
    expect(groupOf('rightInspector', 'preview').weight).toBeCloseTo(0.5);
  });
});

describe('the older move APIs', () => {
  it('movePanel to the other side lands where that side puts an opened panel, and shows it', () => {
    useLayoutStore.getState().registerPanel({ id: 'assets', region: 'leftSidebar', title: 'Project' });
    registerRight('properties', 'align');
    useLayoutStore.getState().movePanel('assets', 'rightInspector', 0);
    expect(groups('rightInspector')).toEqual([['properties'], ['align'], ['assets']]);
    expect(groupOf('rightInspector', 'assets').collapsed).toBe(false);
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual([]);
  });

  it('movePanel to an old bottom pane makes a group at the bottom of that side', () => {
    useLayoutStore.getState().registerPanel({ id: 'assets', region: 'leftSidebar', title: 'Project' });
    useLayoutStore.getState().registerPanel({ id: 'scene', region: 'leftSidebar', title: 'Layers' });
    useLayoutStore.getState().movePanel('scene', 'leftSidebar_bottom', 0);
    expect(groups('leftSidebar')).toEqual([['assets'], ['scene']]);
    expect(useLayoutStore.getState().panelOrder.leftSidebar_bottom).toEqual([]);
  });

  it('dockPanel moves a panel docked on the other side instead of duplicating it', () => {
    useLayoutStore.getState().registerPanel({ id: 'assets', region: 'leftSidebar', title: 'Project' });
    registerRight('properties');
    useLayoutStore.getState().dockPanel('assets', 'rightInspector');
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual([]);
    expect(useLayoutStore.getState().panelOrder.rightInspector).toEqual(['properties', 'assets']);
  });
});

describe('workspaces', () => {
  it('applies a workspace\'s own groups', () => {
    registerRight('properties', 'info', 'audio');
    useLayoutStore.getState().applyWorkspaceLayout({
      name: 'mine',
      regions: {},
      panelOrder: { rightInspector: ['properties', 'info', 'audio'] },
      dockGroups: {
        rightInspector: [
          { id: 'top', panels: ['properties', 'audio'], active: 'audio', collapsed: false, weight: 2 },
          { id: 'low', panels: ['info'], active: 'info', collapsed: true, weight: 1 },
        ],
      },
    });
    expect(groups('rightInspector')).toEqual([['properties', 'audio'], ['info']]);
    expect(useLayoutStore.getState().dockGroups.rightInspector[0]).toMatchObject({ id: 'top', active: 'audio', weight: 2 });
  });

  it('gives a workspace without groups the default grouping, with its active panel\'s group open', () => {
    registerRight('properties', 'scopes', 'align');
    useLayoutStore.getState().applyWorkspaceLayout({
      name: 'Color',
      regions: {},
      panelOrder: { rightInspector: ['properties', 'scopes', 'align'] },
      activePanelByRegion: { rightInspector: 'scopes' },
    });
    expect(groups('rightInspector')).toEqual([['properties'], ['scopes'], ['align']]);
    expect(groupOf('rightInspector', 'scopes').collapsed).toBe(false);
    expect(groupOf('rightInspector', 'align').collapsed).toBe(true);
  });

  it('turns an old workspace\'s split lists into groups', () => {
    registerRight('properties', 'effects');
    useLayoutStore.getState().applyWorkspaceLayout({
      name: 'old',
      regions: {},
      panelOrder: { rightInspector: ['properties'], rightInspector_bottom: ['effects'] },
    });
    expect(groups('rightInspector')).toEqual([['properties'], ['effects']]);
    expect(useLayoutStore.getState().panelOrder.rightInspector_bottom).toEqual([]);
  });

  it('Reset Layout rebuilds the default groups', () => {
    registerRight('properties', 'preview');
    useLayoutStore.getState().mergeGroupUp(groupOf('rightInspector', 'preview').id);
    useLayoutStore.getState().resetLayout();
    expect(groups('rightInspector')).toEqual([['properties'], ['preview']]);
  });
});
