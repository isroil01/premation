/**
 * Menu translation keys. The translator source file built from them,
 * `locales/en.json`, is pinned by `core/i18n/sourceCatalogue.test.ts`.
 */

import { setCatalogue } from '@core/i18n';
import { APP_MENU, type MenuGroupModel, type MenuItemModel } from './menuModel';
import { buildPluginsMenuGroup } from './pluginMenu';
import { collectMenuKeys, localizeMenuGroups, menuItemKey } from './menuI18n';

/** The groups as the app assembles them: Plugins before Help (see useAppMenuGroups). */
function allGroups(): MenuGroupModel[] {
  const help = APP_MENU.findIndex((g) => g.id === 'help');
  return [...APP_MENU.slice(0, help), buildPluginsMenuGroup(), ...APP_MENU.slice(help)];
}

afterEach(() => setCatalogue({}));

describe('menu translation keys', () => {
  it('gives every submenu parent an explicit labelKey', () => {
    const missing: string[] = [];
    const walk = (items: ReadonlyArray<MenuItemModel>, trail: string): void => {
      for (const it of items) {
        if (!it.children) continue;
        const here = `${trail} ▸ ${it.label}`;
        if (!it.commandId && !it.labelKey) missing.push(here);
        walk(typeof it.children === 'function' ? it.children() : it.children, here);
      }
    };
    for (const g of allGroups()) walk(g.items, g.label);
    expect(missing).toEqual([]);
  });

  it('maps each key to exactly one English string', () => {
    // Two different labels under one key would force one translation onto both.
    const seen = new Map<string, { english: string; path: string }>();
    const clashes: string[] = [];
    for (const e of collectMenuKeys(allGroups())) {
      const prev = seen.get(e.key);
      if (prev && prev.english !== e.english) {
        clashes.push(`${e.key}: "${prev.english}" (${prev.path}) vs "${e.english}" (${e.path})`);
      }
      if (!prev) seen.set(e.key, e);
    }
    expect(clashes).toEqual([]);
  });

  it('derives command keys from the command id, not the words', () => {
    expect(menuItemKey({ commandId: 'project.new', label: 'New Project' })).toBe('menu.project.new');
    expect(menuItemKey({ label: 'Transform', labelKey: 'menu.sub.transform', children: [] })).toBe('menu.sub.transform');
    // A saved workspace: the user's own name, never translated.
    expect(menuItemKey({ label: 'My Layout', onSelect: () => {} })).toBeUndefined();
  });
});

describe('localizeMenuGroups', () => {
  it('translates groups, commands and submenu parents, and leaves user data alone', () => {
    setCatalogue({
      'menu.file': '文件',
      'menu.project.new': '新建项目',
      'menu.sub.import': '导入',
      'menu.assets.importFiles': '文件…',
    });
    const file = localizeMenuGroups(APP_MENU).find((g) => g.id === 'file');
    expect(file?.label).toBe('文件');
    expect(file?.items.find((i) => i.commandId === 'project.new')?.label).toBe('新建项目');
    const importMenu = file?.items.find((i) => i.labelKey === 'menu.sub.import');
    expect(importMenu?.label).toBe('导入');
    const kids = importMenu?.children;
    expect(Array.isArray(kids) && kids[0]?.label).toBe('文件…');
    // Anything the catalogue does not cover stays English.
    expect(file?.items.find((i) => i.commandId === 'project.save')?.label).toBe('Save');
  });

  it('keeps thunk children lazy, so saved workspaces stay live', () => {
    let calls = 0;
    const [g] = localizeMenuGroups([
      { id: 'window', label: 'Window', items: [{ label: 'Workspace', labelKey: 'menu.sub.workspace', children: () => { calls += 1; return [{ label: 'Mine', onSelect: () => {} }]; } }] },
    ]);
    expect(calls).toBe(0);
    const kids = g?.items[0]?.children;
    expect(typeof kids).toBe('function');
    setCatalogue({ 'menu.sub.workspace': '工作区' });
    expect(typeof kids === 'function' && kids()[0]?.label).toBe('Mine');
    expect(calls).toBe(1);
  });

  it('does not mutate APP_MENU', () => {
    setCatalogue({ 'menu.file': '文件' });
    localizeMenuGroups(APP_MENU);
    expect(APP_MENU.find((g) => g.id === 'file')?.label).toBe('File');
  });
});
