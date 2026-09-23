/**
 * AddEffectMenu — the "+" beside an applied effect stack.
 *
 * A searchable list of every effect type, favourites first, that adds the
 * picked effect to the target layers. It is the quick path from the Properties
 * panel's Effects section; the full browser (folders, previews, presets, shape
 * operators, drag onto a layer) stays the Effects library in the Library panel.
 *
 * Reads the SAME catalogue that browser does (`effectCatalog`), so a plugin
 * effect installed mid-session appears in both or in neither.
 */

import { useMemo, useState } from 'react';
import { Popover } from '@components/Popover';
import { SearchField } from '@components/SearchField';
import { Icon } from '@components/Icon';
import type { EffectDef, EffectType } from '@core/effects/effects';
import { PLUGIN_EFFECT_CATEGORY } from '@core/effects/pluginEffectDefs';
import { addEffectEdit } from './effectEdits';
import { EFFECT_CATEGORY } from './effectCategory';
import { useAllEffectDefs, useEffectFavorites } from './effectCatalog';
import styles from './AddEffectMenu.module.css';

export interface AddEffectMenuGroup {
  label: string;
  defs: EffectDef[];
}

/**
 * The menu's groups. With a query: one flat list of matches, because typing is
 * hunting and folder headers only push the match down. Without one: favourites,
 * then every category in catalogue order.
 */
export function addEffectMenuGroups(
  defs: ReadonlyArray<EffectDef>,
  favorites: ReadonlySet<string>,
  query: string,
): AddEffectMenuGroup[] {
  const q = query.trim().toLowerCase();
  if (q) {
    const matches = defs.filter((d) => d.label.toLowerCase().includes(q));
    return matches.length > 0 ? [{ label: 'Results', defs: matches }] : [];
  }
  const groups: AddEffectMenuGroup[] = [];
  const favs = defs.filter((d) => favorites.has(d.type));
  if (favs.length > 0) groups.push({ label: 'Favourites', defs: favs });
  const byCategory = new Map<string, EffectDef[]>();
  for (const d of defs) {
    // A plugin effect's namespaced type is absent from the built-in map.
    const cat = EFFECT_CATEGORY[d.type] ?? PLUGIN_EFFECT_CATEGORY;
    const list = byCategory.get(cat);
    if (list) list.push(d);
    else byCategory.set(cat, [d]);
  }
  for (const [label, list] of byCategory) groups.push({ label, defs: list });
  return groups;
}

export function AddEffectMenu({ nodeIds }: { nodeIds: ReadonlyArray<string> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const defs = useAllEffectDefs();
  const { favorites } = useEffectFavorites();
  const groups = useMemo(() => addEffectMenuGroups(defs, favorites, query), [defs, favorites, query]);
  const first = groups[0]?.defs[0];

  const close = (): void => {
    setOpen(false);
    setQuery('');
  };

  /** One undo step however many layers are selected (ONE `addEffect` over all of them). */
  const apply = (type: EffectType): void => {
    if (nodeIds.length === 0) return;
    void addEffectEdit(nodeIds, type);
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => (v ? setOpen(true) : close())}
      placement="bottom-end"
      trigger={
        <button
          type="button"
          className={styles.trigger}
          aria-label="Add effect"
          title="Add effect"
          disabled={nodeIds.length === 0}
        >
          <Icon name="plus" size="sm" />
        </button>
      }
    >
      <div className={styles.menu} role="dialog" aria-label="Add effect">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search effects…"
          ariaLabel="Search effects to add"
          size="sm"
          autoFocus
          onKeyDown={(e) => {
            // Enter takes the top match — type "gaus", press Enter, done.
            if (e.key === 'Enter' && first) {
              e.preventDefault();
              apply(first.type);
            }
          }}
        />
        {groups.length === 0 ? (
          <p className={styles.empty}>No effects match “{query.trim()}”.</p>
        ) : (
          <div className={styles.list}>
            {groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label}>
                <div className={styles.groupLabel}>{g.label}</div>
                {g.defs.map((d) => (
                  <button
                    key={`${g.label}:${d.type}`}
                    type="button"
                    className={styles.item}
                    title={`Add ${d.label}`}
                    onClick={() => apply(d.type)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </Popover>
  );
}

export default AddEffectMenu;
