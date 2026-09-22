/**
 * Menu translation: which key each menu label is looked up under, and the pass
 * that swaps the English for the active language.
 *
 * KEYS
 *   group            `menu.<groupId>`              menu.file
 *   command item     `menu.<commandId>`            menu.project.new
 *   submenu parent   its explicit `labelKey`       menu.sub.transform
 *   runtime entry    none — never translated       (a workspace, a plugin name)
 *
 * Keyed by command id rather than by the English text on purpose. A key made
 * from the words ("menu.newProject") changes the day someone rewords the item,
 * and the translation silently stops matching; a command id does not change
 * when its label does. `locales/en.json` lists every key with its current
 * English, and a test keeps it in step with this model — so a reworded label
 * shows up as a diff a translator can see, not as a string that quietly fell
 * back to English.
 *
 * WHERE IT RUNS. Once, in `useAppMenuGroups`, on the assembled groups. Both the
 * in-app menu bar and the native Electron menu are drawn from those groups, so
 * neither renderer needs to know translation exists. `APP_MENU` itself stays
 * English — tests and the plugin/layer-kind splicing match on it.
 */

import { t } from '@core/i18n';
import type { MenuGroupModel, MenuItemModel } from './menuModel';

export function menuGroupKey(group: Pick<MenuGroupModel, 'id'>): string {
  return `menu.${group.id}`;
}

/** The key an item's label is translated under, or `undefined` if it is not translated. */
export function menuItemKey(item: MenuItemModel): string | undefined {
  if (item.separator) return undefined;
  if (item.labelKey) return item.labelKey;
  if (item.commandId) return `menu.${item.commandId}`;
  return undefined;
}

function localizeItem(item: MenuItemModel): MenuItemModel {
  if (item.separator) return item;
  const key = menuItemKey(item);
  // No `label` means the renderer shows the command registry's label; that is
  // the command palette's string, translated (later) under its own namespace.
  const label = key && item.label !== undefined ? t(key, item.label) : item.label;
  const children = item.children;
  if (!children) return label === item.label ? item : { ...item, label };
  return {
    ...item,
    label,
    // A thunk stays a thunk — it is evaluated per draw so user data (saved
    // workspaces, installed plugins) is live, and wrapping must not freeze it.
    children:
      typeof children === 'function'
        ? () => localizeItems(children())
        : localizeItems(children),
  };
}

export function localizeItems(items: ReadonlyArray<MenuItemModel>): MenuItemModel[] {
  return items.map(localizeItem);
}

/** The groups with every translatable label in the active language. */
export function localizeMenuGroups(groups: ReadonlyArray<MenuGroupModel>): MenuGroupModel[] {
  return groups.map((g) => ({ ...g, label: t(menuGroupKey(g), g.label), items: localizeItems(g.items) }));
}

export interface MenuKeyEntry {
  key: string;
  /** The English label — the translation's source text. */
  english: string;
  /** Where it sits, for error messages: "Layer ▸ Transform ▸ Reset". */
  path: string;
}

/**
 * Every translatable label in a menu tree, in menu order. Thunk children are
 * evaluated — for the static model that yields the fixed entries (Workspace's
 * Save/Reset); the user-data entries around them have no key and are skipped.
 */
export function collectMenuKeys(groups: ReadonlyArray<MenuGroupModel>): MenuKeyEntry[] {
  const out: MenuKeyEntry[] = [];
  const walk = (items: ReadonlyArray<MenuItemModel>, trail: string): void => {
    for (const it of items) {
      if (it.separator) continue;
      const here = `${trail} ▸ ${it.label ?? it.commandId ?? '?'}`;
      const key = menuItemKey(it);
      if (key && it.label !== undefined) out.push({ key, english: it.label, path: here });
      if (it.children) walk(typeof it.children === 'function' ? it.children() : it.children, here);
    }
  };
  for (const g of groups) {
    out.push({ key: menuGroupKey(g), english: g.label, path: g.label });
    walk(g.items, g.label);
  }
  return out;
}
