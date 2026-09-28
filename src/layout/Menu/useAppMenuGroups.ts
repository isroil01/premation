/**
 * The menu groups the two menu renderers draw: `APP_MENU` with every edition
 * gate applied (`visibleItems`), localized. A hook so an open menu follows a
 * change of UI language. (The Plugins group and the plugin layer kinds under
 * Layer ▸ New are gone with the JavaScript plugin system, G2.)
 */

import { useMemo } from 'react';
import { APP_MENU, type MenuGroupModel, type MenuItemModel } from './menuModel';
import { useCatalogueRevision } from '@hooks/useLocale';
import { localizeMenuGroups } from './menuI18n';

export function useAppMenuGroups(): MenuGroupModel[] {
  const i18nRevision = useCatalogueRevision();
  return useMemo(
    () => localizeMenuGroups(APP_MENU.map((g) => ({ ...g, items: visibleItems(g.items) }))),
    // The catalogue is read by `t()` inside, not by this closure — hence the rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18nRevision],
  );
}

/**
 * Drop items whose `visible()` says no, then tidy the separators they leave.
 *
 * Hiding an edition-gated entry between two separators would otherwise leave a
 * double rule, and hiding the last entry a trailing one — which reads as a
 * rendering bug rather than as an absent feature.
 */
export function visibleItems(items: ReadonlyArray<MenuItemModel>): MenuItemModel[] {
  const kept = items.filter((it) => it.visible === undefined || it.visible());
  const out: MenuItemModel[] = [];
  for (const item of kept) {
    // Collapse runs, and never open with one.
    if (item.separator && (out.length === 0 || out[out.length - 1]?.separator)) continue;
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1]?.separator) out.pop();
  return out;
}
