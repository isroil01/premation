/**
 * The context-menu shortcut column fills itself from the command registry.
 */

import { getCommandRegistry } from '@core/commands/Command';
import { asCommandId } from '@app-types/common';
import { resolveContextMenuItems, useContextMenuStore } from './contextMenuStore';

beforeEach(() => {
  getCommandRegistry().register({
    id: asCommandId('test.dup'),
    label: 'Duplicate Thing',
    shortcut: { key: 'd', ctrl: true },
    enabled: () => true,
    execute: () => undefined,
  });
  getCommandRegistry().register({
    id: asCommandId('test.off'),
    label: 'Cannot Now',
    enabled: () => false,
    execute: () => undefined,
  });
});

afterEach(() => {
  getCommandRegistry().unregister(asCommandId('test.dup'));
  getCommandRegistry().unregister(asCommandId('test.off'));
  localStorage.clear();
});

describe('resolveContextMenuItems', () => {
  it('fills shortcut, label and a default action from the command', () => {
    const [item] = resolveContextMenuItems([{ id: 'dup', commandId: 'test.dup' }]);
    expect(item!.shortcut).toBe('Ctrl+D');
    expect(item!.label).toBe('Duplicate Thing');
    expect(typeof item!.onSelect).toBe('function');
    expect(item!.disabled).toBeUndefined();
  });

  it('keeps an explicit shortcut, label and handler', () => {
    const onSelect = jest.fn();
    const [item] = resolveContextMenuItems([{ id: 'dup', commandId: 'test.dup', shortcut: 'X', label: 'Mine', onSelect }]);
    expect(item!.shortcut).toBe('X');
    expect(item!.label).toBe('Mine');
    expect(item!.onSelect).toBe(onSelect);
  });

  it('disables an unregistered or currently-disabled command', () => {
    const items = resolveContextMenuItems([
      { id: 'a', commandId: 'test.off', label: 'Off' },
      { id: 'b', commandId: 'nope.missing', label: 'Missing' },
      { id: 'c', label: 'Plain', onSelect: () => undefined },
    ]);
    expect(items.map((i) => i.disabled)).toEqual([true, true, undefined]);
  });

  it('recurses into submenus, and the store applies it on open', () => {
    useContextMenuStore.getState().openMenu(0, 0, [
      { id: 'parent', label: 'More', children: [{ id: 'kid', commandId: 'test.dup' }] },
    ]);
    const parent = useContextMenuStore.getState().items[0]!;
    expect(parent.children?.[0]?.shortcut).toBe('Ctrl+D');
    useContextMenuStore.getState().close();
  });
});
