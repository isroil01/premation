/**
 * The pure half of dock groups: how a side's docked panels are divided into
 * After Effects panel groups, and how that division survives membership
 * changes the groups did not make (a closed panel, a seeded `panelOrder`).
 */

import {
  legacySplitGroups,
  normalizeWeights,
  placePanel,
  reconcileGroups,
  sanitizeDockGroups,
  sanitizeGroupList,
  sideOfRegion,
  uniqueGroupId,
  type DockGroupState,
} from './dockGroups';

const group = (panels: string[], over: Partial<DockGroupState> = {}): DockGroupState => ({
  id: `g-${panels[0]}`,
  panels,
  active: panels[0] ?? null,
  collapsed: false,
  weight: 1,
  ...over,
});

describe('placePanel — where a panel no group holds goes', () => {
  it('gives each right-column panel a group of its own, only the first open (AE Default)', () => {
    const groups: DockGroupState[] = [];
    for (const id of ['properties', 'preview', 'effects']) placePanel('rightInspector', groups, id);
    expect(groups.map((g) => g.panels)).toEqual([['properties'], ['preview'], ['effects']]);
    expect(groups.map((g) => g.collapsed)).toEqual([false, true, true]);
    // Properties keeps three times the height of an average group.
    expect(groups[0]!.weight).toBe(3);
  });

  it('puts Info and Audio, and Character and Paragraph, in one group each', () => {
    const groups: DockGroupState[] = [];
    for (const id of ['properties', 'info', 'audio', 'preview', 'character', 'paragraph']) placePanel('rightInspector', groups, id);
    expect(groups.map((g) => g.panels)).toEqual([['properties'], ['info', 'audio'], ['preview'], ['character', 'paragraph']]);
  });

  it('joins the left sidebar\'s first group, so Project · Effect Controls · Layers are tabs', () => {
    const groups: DockGroupState[] = [];
    for (const id of ['assets', 'effectControls', 'scene']) placePanel('leftSidebar', groups, id);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.panels).toEqual(['assets', 'effectControls', 'scene']);
    expect(groups[0]!.active).toBe('assets');
  });

  it('opens the new group when asked to', () => {
    const groups = [group(['properties'])];
    placePanel('rightInspector', groups, 'scopes', { expand: true });
    expect(groups[1]).toMatchObject({ panels: ['scopes'], collapsed: false });
  });
});

describe('reconcileGroups', () => {
  it('drops panels that are no longer docked, and groups left empty', () => {
    const out = reconcileGroups('rightInspector', ['properties', 'audio'], [
      group(['properties']),
      group(['info', 'audio'], { active: 'info' }),
      group(['preview']),
    ]);
    expect(out.map((g) => g.panels)).toEqual([['properties'], ['audio']]);
    // The front tab was closed: the next one comes forward.
    expect(out[1]!.active).toBe('audio');
  });

  it('places a docked panel no group holds, in member order', () => {
    const out = reconcileGroups('rightInspector', ['properties', 'scopes', 'align'], [group(['properties'])]);
    expect(out.map((g) => g.panels)).toEqual([['properties'], ['scopes'], ['align']]);
  });

  it('keeps the front tab, collapsed state and weight of the groups it keeps', () => {
    const groups = [group(['a', 'b'], { active: 'b', collapsed: true, weight: 2.5 }), group(['c'])];
    const out = reconcileGroups('rightInspector', ['a', 'b', 'c'], groups);
    expect(out).toEqual([
      { id: 'g-a', panels: ['a', 'b'], active: 'b', collapsed: true, weight: 2.5 },
      { id: 'g-c', panels: ['c'], active: 'c', collapsed: false, weight: 1 },
    ]);
    // Fresh objects: the input is untouched.
    expect(groups[0]!.panels).toEqual(['a', 'b']);
    expect(out[0]).not.toBe(groups[0]);
  });

  it('takes ORDER from the members — tabs within a group and groups down the column', () => {
    const groups = [group(['a', 'b']), group(['c'])];
    const out = reconcileGroups('rightInspector', ['c', 'b', 'a'], groups);
    expect(out.map((g) => g.panels)).toEqual([['c'], ['b', 'a']]);
  });

  it('keeps a panel listed in two groups only in the first', () => {
    const out = reconcileGroups('leftSidebar', ['a', 'b'], [group(['a', 'b']), group(['b'], { id: 'g-dup' })]);
    expect(out.map((g) => g.panels)).toEqual([['a', 'b']]);
  });

  it('is a no-op on groups that already agree', () => {
    const groups = [group(['a', 'b']), group(['c'], { collapsed: true })];
    expect(reconcileGroups('rightInspector', ['a', 'b', 'c'], groups)).toEqual(groups);
  });
});

describe('legacySplitGroups — a layout saved with the old two-pane split', () => {
  it('turns the right side\'s two panes into their default groups, top pane first', () => {
    const out = legacySplitGroups('rightInspector', ['properties', 'info', 'audio'], ['effects', 'align']);
    expect(out.map((g) => g.panels)).toEqual([['properties'], ['info', 'audio'], ['effects'], ['align']]);
    // The lower pane's first group was visible before: it stays open.
    expect(out[2]!.collapsed).toBe(false);
  });

  it('turns the left side\'s two panes into two tab groups', () => {
    const out = legacySplitGroups('leftSidebar', ['assets', 'scene'], ['library', 'transcript']);
    expect(out.map((g) => g.panels)).toEqual([['assets', 'scene'], ['library', 'transcript']]);
    expect(new Set(out.map((g) => g.id)).size).toBe(2);
  });

  it('leaves an unsplit side to the policy', () => {
    expect(legacySplitGroups('rightInspector', ['properties'], [])).toEqual([]);
  });
});

describe('normalizeWeights', () => {
  it('rescales the open groups to a mean of 1, keeping their ratios', () => {
    const groups = [group(['a'], { weight: 300 }), group(['b'], { weight: 100 }), group(['c'], { collapsed: true, weight: 7 })];
    normalizeWeights(groups);
    expect(groups[0]!.weight).toBeCloseTo(1.5);
    expect(groups[1]!.weight).toBeCloseTo(0.5);
    // A collapsed group's weight is not part of the share.
    expect(groups[2]!.weight).toBe(7);
  });
});

describe('ids, regions and persisted input', () => {
  it('makes group ids unique', () => {
    expect(uniqueGroupId([group(['a'])], 'a')).toBe('g-a-2');
    expect(uniqueGroupId([group(['a']), group(['x'], { id: 'g-a-2' })], 'a')).toBe('g-a-3');
  });

  it('maps a region to its side', () => {
    expect(sideOfRegion('rightInspector_bottom')).toBe('rightInspector');
    expect(sideOfRegion('leftSidebar')).toBe('leftSidebar');
    expect(sideOfRegion('bottomTimeline')).toBeNull();
  });

  it('cleans a persisted group list and rejects what is not one', () => {
    expect(sanitizeGroupList('nope')).toBeNull();
    expect(sanitizeGroupList([
      { id: 'g1', panels: ['a', 7, 'b'], active: 'zzz', collapsed: 'yes', weight: -2 },
      { id: 'g1', panels: ['c'] },
      { panels: [] },
      null,
    ])).toEqual([
      { id: 'g1', panels: ['a', 'b'], active: 'a', collapsed: false, weight: 1 },
      { id: 'g-c', panels: ['c'], active: 'c', collapsed: false, weight: 1 },
    ]);
    expect(sanitizeDockGroups({ leftSidebar: [{ id: 'x', panels: ['a'] }], rightInspector: 3 })).toEqual({
      leftSidebar: [{ id: 'x', panels: ['a'], active: 'a', collapsed: false, weight: 1 }],
    });
  });
});
