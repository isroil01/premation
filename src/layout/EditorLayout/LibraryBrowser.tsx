/**
 * Shared browsing chrome for the asset-library sections.
 *
 * Each of Motion GFX / Transitions / Sound FX / Lottie had grown its own copy
 * of the same category strip and its own footer count, and none of them had a
 * search box: the only way to find "Glitch" was to know which of the four
 * sections it lived in and which category chip filtered to it. Sixty-odd items
 * behind two levels of tab is a browsing problem, and it was being solved four
 * times, badly.
 *
 * One toolbar, one filter pipeline, one empty state — sections supply their
 * items and render their own cards.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { usePreferenceStore } from '@stores/preferenceStore';
import styles from './panels.module.css';

/** The least a library item must expose to be browsable. */
export interface BrowsableItem {
  id: string;
  name: string;
  cat: string;
}

export interface LibraryBrowserProps<T extends BrowsableItem> {
  items: readonly T[];
  /** Category ids in display order (without `all`, which is added). */
  categories: readonly string[];
  /** Display name for a category chip. */
  categoryLabel?: (cat: string) => string;
  /** Noun for the footer count ("preset", "transition", …). */
  noun: string;
  /** Extra controls above the list — the Lottie import button, say. */
  toolbar?: ReactNode;
  children: (items: T[]) => ReactNode;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Starred ids and a toggle. Shared so a card in any section can star itself. */
export function useLibraryFavorites(): {
  favorites: ReadonlySet<string>;
  toggle: (id: string) => void;
  isFavorite: (id: string) => boolean;
} {
  const list = usePreferenceStore((s) => s.libraryFavorites);
  const setPref = usePreferenceStore((s) => s.set);
  const favorites = useMemo(() => new Set(list), [list]);
  return {
    favorites,
    isFavorite: (id) => favorites.has(id),
    toggle: (id) =>
      setPref('libraryFavorites', favorites.has(id) ? list.filter((x) => x !== id) : [...list, id]),
  };
}

/**
 * A star toggle for a library card.
 *
 * NOT a `<button>`: every card in this panel is itself a button, and a button
 * inside a button is invalid HTML — React warns about it and browsers recover
 * however they like, which typically means the inner control never receives the
 * click at all. A `role="button"` span is the standard escape, so it carries
 * its own keyboard handling to stay operable without the native element.
 *
 * The click is stopped from reaching the card, whose job is to INSERT: starring
 * something you did not want in the comp must not put it in the comp.
 */
export function FavoriteStar({ id, label }: { id: string; label: string }): JSX.Element {
  const { isFavorite, toggle } = useLibraryFavorites();
  const on = isFavorite(id);
  const description = on ? `Remove ${label} from favourites` : `Add ${label} to favourites`;
  const activate = (e: { stopPropagation: () => void; preventDefault: () => void }): void => {
    e.stopPropagation();
    e.preventDefault();
    toggle(id);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={on ? styles.libStarOn : styles.libStar}
      title={description}
      aria-label={description}
      aria-pressed={on}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') activate(e);
      }}
      // The card is draggable; a drag begun on the star would otherwise start
      // dragging the whole item from a control that means "remember this".
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Icon name="star" size="sm" />
    </span>
  );
}

export function LibraryBrowser<T extends BrowsableItem>({
  items, categories, categoryLabel, noun, toolbar, children,
}: LibraryBrowserProps<T>): JSX.Element {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const { favorites } = useLibraryFavorites();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (starredOnly && !favorites.has(it.id)) return false;
      if (cat !== 'all' && it.cat !== cat) return false;
      if (!q) return true;
      // Match the category too, so typing "glitch" finds both the item named
      // Glitch Cut and everything in the glitch category.
      return it.name.toLowerCase().includes(q) || it.cat.toLowerCase().includes(q);
    });
  }, [items, query, cat, starredOnly, favorites]);

  const starCount = useMemo(() => items.filter((i) => favorites.has(i.id)).length, [items, favorites]);

  return (
    <>
      <div className={styles.libSearchRow}>
        <Input
          placeholder={`Search ${noun}s…`}
          size="sm"
          fullWidth
          leftIcon="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label={`Search ${noun}s`}
        />
        <button
          type="button"
          className={starredOnly ? styles.libStarFilterOn : styles.libStarFilter}
          title={starredOnly ? 'Show all' : 'Show favourites only'}
          aria-label={starredOnly ? 'Show all' : 'Show favourites only'}
          aria-pressed={starredOnly}
          onClick={() => setStarredOnly((v) => !v)}
        >
          <Icon name="star" size="sm" />
        </button>
      </div>

      <div className={styles.libTabs} role="tablist" aria-label={`${noun} categories`}>
        {['all', ...categories].map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={cat === c}
            className={cat === c ? styles.libTabActive : styles.libTab}
            onClick={() => setCat(c)}
          >
            {c === 'all' ? 'All' : (categoryLabel?.(c) ?? titleCase(c))}
          </button>
        ))}
      </div>

      <div className={styles.libBody}>
        {toolbar}
        {filtered.length === 0 ? (
          <div className={styles.libEmpty}>
            <Icon name="search" size="md" />
            <span>
              {starredOnly && starCount === 0
                ? `No favourite ${noun}s yet — star one to pin it here.`
                : `No ${noun}s match “${query || cat}”.`}
            </span>
          </div>
        ) : (
          children(filtered)
        )}
      </div>

      <div className={styles.footer}>
        {filtered.length} {noun}
        {filtered.length !== 1 ? 's' : ''}
        {filtered.length !== items.length && ` of ${items.length}`}
        {starCount > 0 && ` · ${starCount} starred`}
      </div>
    </>
  );
}
