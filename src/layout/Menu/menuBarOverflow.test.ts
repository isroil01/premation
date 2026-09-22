import { countFittingGroups, foldOverflowGroups, OVERFLOW_GROUP_ID } from './menuBarOverflow';
import type { MenuGroupModel } from './menuModel';

const group = (id: string): MenuGroupModel => ({ id, label: id.toUpperCase(), items: [{ commandId: `${id}.x`, label: 'X' }] });

describe('countFittingGroups', () => {
  const widths = [40, 40, 40, 40]; // + 3 gaps of 4 = 172

  it('keeps every group when they fit exactly', () => {
    expect(countFittingGroups(widths, 4, 172, 28)).toBe(4);
  });

  it('charges the "…" button before the last group that would otherwise fit', () => {
    // 171: all four do not fit. Three groups + "…" = 3*44 + 28 = 160 <= 171.
    expect(countFittingGroups(widths, 4, 171, 28)).toBe(3);
    // 159: three + "…" no longer fit; two do (2*44 + 28 = 116).
    expect(countFittingGroups(widths, 4, 159, 28)).toBe(2);
  });

  it('folds everything rather than overflow when there is room for nothing', () => {
    expect(countFittingGroups(widths, 4, 30, 28)).toBe(0);
  });
});

describe('foldOverflowGroups', () => {
  const groups = ['file', 'edit', 'view', 'help'].map(group);

  it('returns the groups untouched when all fit', () => {
    expect(foldOverflowGroups(groups, 4, 'More').map((g) => g.id)).toEqual(['file', 'edit', 'view', 'help']);
    expect(foldOverflowGroups(groups, Number.POSITIVE_INFINITY, 'More')).toHaveLength(4);
  });

  it('moves the trailing groups, in order, under one "…" group as submenus', () => {
    const folded = foldOverflowGroups(groups, 2, 'More menus');
    expect(folded.map((g) => g.id)).toEqual(['file', 'edit', OVERFLOW_GROUP_ID]);
    const more = folded[2]!;
    expect(more.label).toBe('More menus');
    expect(more.items.map((i) => i.label)).toEqual(['VIEW', 'HELP']);
    // Nothing is lost: each submenu IS the folded group's item list.
    expect(more.items[1]!.children).toBe(groups[3]!.items);
  });
});
