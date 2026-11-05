/**
 * Columns within a side (2026-10-20, After Effects docking): a panel dropped on
 * a group's left / right edge stands in a column of its own beside it; a
 * column left empty goes and gives its width back.
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
    dockColumns: { leftSidebar: [1], rightInspector: [1] },
    maximizedGroup: null,
    externalPanels: [],
  });
  const s = useLayoutStore.getState();
  s.setCollapsed('leftSidebar', false);
  s.setCollapsed('rightInspector', false);
  s.setRegionSize('rightInspector', 320);
  s.setRegionSize('leftSidebar', 280);
}

const state = () => useLayoutStore.getState();
/** The right side as columns of groups of panels. */
const columns = (): string[][][] => {
  const out: string[][][] = [];
  for (const g of state().dockGroups.rightInspector) (out[g.column] ??= []).push(g.panels);
  return out;
};
const groupOf = (id: string) => state().dockGroups.rightInspector.find((g) => g.panels.includes(id))!;

function registerRight(...ids: string[]): void {
  for (const id of ids) state().registerPanel({ id, region: 'rightInspector', title: id, closable: true });
}

beforeEach(() => {
  // A wide window: room for the viewer and new columns (jsdom's default is 1024).
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2560 });
  reset();
});

describe('docking into a new column', () => {
  it('a panel dropped on a group\'s left edge makes a column left of it, and the side widens', () => {
    registerRight('properties', 'effects', 'plugins');
    state().dockDrop({ panel: 'plugins' }, { kind: 'column', side: 'rightInspector', column: 0 });
    expect(columns()).toEqual([[['plugins']], [['properties'], ['effects']]]);
    expect(state().dockColumns.rightInspector).toHaveLength(2);
    expect(state().regions.rightInspector.size).toBe(320 + 280);
    // panelOrder reads column by column.
    expect(state().panelOrder.rightInspector).toEqual(['plugins', 'properties', 'effects']);
  });

  it('new panels still open in the side\'s home column (the right side\'s last)', () => {
    registerRight('properties', 'plugins');
    state().dockDrop({ panel: 'plugins' }, { kind: 'column', side: 'rightInspector', column: 0 });
    registerRight('align');
    expect(columns()).toEqual([[['plugins']], [['properties'], ['align']]]);
  });

  it('a column left empty goes, and gives its width back', () => {
    registerRight('properties', 'plugins');
    state().dockDrop({ panel: 'plugins' }, { kind: 'column', side: 'rightInspector', column: 0 });
    expect(state().regions.rightInspector.size).toBe(600);
    state().dockDrop({ panel: 'plugins' }, { kind: 'tabs', groupId: groupOf('properties').id });
    expect(columns()).toEqual([[['properties', 'plugins']]]);
    expect(state().dockColumns.rightInspector).toHaveLength(1);
    expect(state().regions.rightInspector.size).toBeLessThan(400);
  });

  it('the column that stays fills the side (no empty strip beside it)', () => {
    registerRight('properties', 'plugins');
    state().dockDrop({ panel: 'plugins' }, { kind: 'column', side: 'rightInspector', column: 1 });
    // The divider dragged so the new column is the wide one: shares 0.5 : 1.5.
    state().setColumnWeights('rightInspector', [1, 3]);
    // Closing the new column: the remaining one's share must be a full 1, not
    // the fraction it had beside it (flex-grow < 1 leaves part of the side blank).
    state().dockDrop({ panel: 'plugins' }, { kind: 'tabs', groupId: groupOf('properties').id });
    expect(state().dockColumns.rightInspector).toEqual([1]);
  });

  it('a panel can make a column on the other side', () => {
    state().registerPanel({ id: 'assets', region: 'leftSidebar', title: 'assets' });
    registerRight('properties', 'plugins');
    state().dockDrop({ panel: 'plugins' }, { kind: 'column', side: 'leftSidebar', column: 1 });
    const left = state().dockGroups.leftSidebar.map((g) => [g.column, g.panels]);
    expect(left).toEqual([[0, ['assets']], [1, ['plugins']]]);
    expect(state().panelOrder.rightInspector).toEqual(['properties']);
  });
});

describe('splitting a column and moving whole groups', () => {
  it('a top / bottom drop is a group of its own in that column', () => {
    registerRight('properties', 'effects', 'align');
    state().dockDrop({ panel: 'align' }, { kind: 'split', side: 'rightInspector', column: 0, index: 1 });
    expect(columns()).toEqual([[['properties'], ['align'], ['effects']]]);
  });

  it('the group grip moves every tab of a group, keeping its front tab', () => {
    registerRight('properties', 'info', 'audio', 'effects');
    expect(groupOf('audio').panels).toEqual(['info', 'audio']);
    state().setGroupActive(groupOf('audio').id, 'audio');
    state().dockDrop({ group: groupOf('audio').id }, { kind: 'column', side: 'rightInspector', column: 1 });
    expect(columns()).toEqual([[['properties'], ['effects']], [['info', 'audio']]]);
    expect(groupOf('audio').active).toBe('audio');
  });

  it('a group dropped on another\'s tabs merges into it', () => {
    registerRight('properties', 'info', 'audio', 'effects');
    state().dockDrop({ group: groupOf('audio').id }, { kind: 'tabs', groupId: groupOf('effects').id });
    expect(columns()).toEqual([[['properties'], ['effects', 'info', 'audio']]]);
  });

  it('a group dropped beside itself changes nothing', () => {
    registerRight('properties', 'effects');
    const before = JSON.stringify(state().dockGroups);
    state().dockDrop({ group: groupOf('effects').id }, { kind: 'split', side: 'rightInspector', column: 0, index: 1 });
    state().dockDrop({ group: groupOf('effects').id }, { kind: 'tabs', groupId: groupOf('effects').id });
    expect(JSON.stringify(state().dockGroups)).toBe(before);
  });

  it('Merge with Group Above stays within a column', () => {
    registerRight('properties', 'plugins');
    state().dockDrop({ panel: 'plugins' }, { kind: 'column', side: 'rightInspector', column: 0 });
    state().mergeGroupUp(groupOf('properties').id);
    expect(columns()).toEqual([[['plugins']], [['properties']]]);
  });
});

describe('a window with no room left', () => {
  it('keeps the viewer its minimum and docks at the foot of the column instead of a sliver column', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    registerRight('properties', 'effects', 'plugins');
    state().dockDrop({ panel: 'plugins' }, { kind: 'column', side: 'rightInspector', column: 0 });
    state().dockDrop({ panel: 'effects' }, { kind: 'column', side: 'rightInspector', column: 0 });
    const left = state().regions.leftSidebar.collapsed ? 8 : state().regions.leftSidebar.size;
    expect(1100 - left - state().regions.rightInspector.size).toBeGreaterThanOrEqual(480);
    for (const col of columns()) expect(col.length).toBeGreaterThan(0);
    expect(columns().length).toBeLessThanOrEqual(2);
  });
});

describe('column widths and Maximize Frame', () => {
  it('setColumnWeights keeps the ratios, normalised', () => {
    registerRight('properties', 'plugins');
    state().dockDrop({ panel: 'plugins' }, { kind: 'column', side: 'rightInspector', column: 0 });
    state().setColumnWeights('rightInspector', [300, 100]);
    const [a, b] = state().dockColumns.rightInspector;
    expect(a! / b!).toBeCloseTo(3);
  });

  it('toggles one maximized group at a time', () => {
    registerRight('properties');
    const id = groupOf('properties').id;
    state().toggleMaximizeGroup(id);
    expect(state().maximizedGroup).toBe(id);
    state().toggleMaximizeGroup(id);
    expect(state().maximizedGroup).toBeNull();
  });
});
