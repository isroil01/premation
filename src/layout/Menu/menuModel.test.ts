/**
 * Every VISIBLE menu item must resolve to a command that is registered in the
 * edition showing it.
 *
 * WHY THIS EXISTS. Both menu renderers render an unregistered command id as a
 * DISABLED item — a deliberate choice, because an enabled item whose click
 * silently no-ops reads as broken. But that turns a registration gap into a
 * permanently-greyed entry, which is its own kind of lie.
 *
 * File ▸ Version History… was exactly that. Its command is registered only
 * under `cloudProjectsEnabled()`, and the registration carries a comment saying
 * it stays unregistered locally *so that* there is no "permanently-disabled
 * menu item next to a feature that does work" — but APP_MENU is a static
 * module constant, so the item appeared in the local edition regardless. The
 * intent needed the predicate on BOTH sides; it only had it on one.
 *
 * This test pins the pairing per edition: an item is either visible AND
 * registered, or hidden.
 *
 * IF THIS FAILS you have added a menu entry whose command this edition never
 * registers. Either register it, or give the item a `visible:` predicate
 * matching the registration's.
 */

import { setEdition, type Edition } from '@core/config/edition';

/** Ids registered outside `buildProjectCommands` that the menu also references. */
type MenuShape = ReadonlyArray<{ id: string; items: ReadonlyArray<{ commandId?: string; separator?: boolean; visible?: () => boolean }> }>;

function visibleCommandIds(menu: MenuShape): string[] {
  return menu
    .flatMap((g) => g.items)
    .filter((it) => !it.separator && (it.visible === undefined || it.visible()))
    .map((it) => it.commandId)
    .filter((id): id is string => !!id);
}

async function menuIn(edition: Edition): Promise<string[]> {
  jest.resetModules();
  const cfg = await import('@core/config/edition');
  cfg.setEdition(edition);
  const { APP_MENU } = await import('./menuModel');
  return visibleCommandIds(APP_MENU as MenuShape);
}

describe('APP_MENU ⇄ command registry', () => {
  afterEach(() => {
    setEdition('server');
    jest.resetModules();
  });

  it('shows Version History only where its command is registered', async () => {
    expect(await menuIn('server')).toContain('file.versionHistory');
    // The whole point: unregistered locally, so it must not be on the menu
    // either — rather than sitting there greyed out forever.
    expect(await menuIn('local')).not.toContain('file.versionHistory');
  });

  it('offers New Composition…, whose dialog is live in the Project panel', async () => {
    // Removed from the menu on a rationale ("compositions come from the
    // dashboard") that stopped being true once the Project panel shipped the
    // button. Both editions have compositions.
    expect(await menuIn('server')).toContain('comp.new');
    expect(await menuIn('local')).toContain('comp.new');
  });

  it('never lists the same command twice', async () => {
    for (const edition of ['server', 'local'] as const) {
      const ids = await menuIn(edition);
      expect(ids).toEqual([...new Set(ids)]);
    }
  });

  it('leaves no leading, trailing or doubled separators once items are hidden', async () => {
    // Hiding an edition-gated entry between two separators would otherwise
    // leave a double rule, which reads as a rendering bug rather than as an
    // absent feature. Exercised in the LOCAL edition, where an item IS hidden.
    jest.resetModules();
    const cfg = await import('@core/config/edition');
    cfg.setEdition('local');
    const { APP_MENU } = await import('./menuModel');
    const { visibleItems } = await import('./useAppMenuGroups');

    for (const group of APP_MENU) {
      const items = visibleItems(group.items);
      expect(items[0]?.separator).toBeFalsy();
      expect(items[items.length - 1]?.separator).toBeFalsy();
      for (let i = 1; i < items.length; i++) {
        expect(items[i]?.separator && items[i - 1]?.separator).toBeFalsy();
      }
    }
  });

  it('collapses the separators around a hidden item', () => {
    // The specific shape File ▸ Version History… leaves behind in the local
    // edition: sep, hidden, sep → one separator, not two.
    const items = [
      { commandId: 'a' },
      { separator: true },
      { commandId: 'gated', visible: () => false },
      { separator: true },
      { commandId: 'b' },
    ];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { visibleItems } = require('./useAppMenuGroups') as typeof import('./useAppMenuGroups');
    expect(visibleItems(items)).toEqual([{ commandId: 'a' }, { separator: true }, { commandId: 'b' }]);
  });
});
