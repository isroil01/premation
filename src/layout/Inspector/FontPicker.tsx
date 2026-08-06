/**
 * FontPicker — searchable font-family dropdown for the text inspector.
 *
 * Enumerates locally installed fonts via the Chromium Local Font Access API
 * (`window.queryLocalFonts`) lazily on first open (the call may show a
 * permission prompt). On failure or unavailability it falls back to a curated
 * Google-font list plus universal system fonts. Each option renders in its own
 * font family as a live preview. Arrow keys + Enter select, Escape closes
 * (via Popover).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@components/Popover';
import { Input } from '@components/Input';
import { VirtualList } from '@components/VirtualList';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import styles from './FontPicker.module.css';

/** Curated Google fonts (the previous hardcoded list) — kept as fallback. */
const CURATED_FONTS = [
  'Inter', 'Roboto', 'Outfit', 'Playfair Display', 'Fira Code', 'Montserrat',
  'Lora', 'Merriweather', 'PT Sans', 'Open Sans',
];

/** Universal system fonts available on virtually every desktop OS. */
const SYSTEM_FONTS = [
  'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New',
  'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'Segoe UI',
];

const FALLBACK_FONTS = [...new Set([...CURATED_FONTS, ...SYSTEM_FONTS])]
  .sort((a, b) => a.localeCompare(b));

interface LocalFontData {
  family?: string;
  fullName?: string;
  style?: string;
}

/** Module-level cache so the (possibly permission-prompting) query runs once. */
let fontListCache: string[] | null = null;
let fontListPromise: Promise<string[]> | null = null;

function loadFontList(): Promise<string[]> {
  if (fontListCache) return Promise.resolve(fontListCache);
  if (fontListPromise) return fontListPromise;

  fontListPromise = (async () => {
    let families: string[] = [];
    try {
      const query = (window as unknown as {
        queryLocalFonts?: () => Promise<ReadonlyArray<LocalFontData>>;
      }).queryLocalFonts;
      if (typeof query === 'function') {
        const fonts = await query.call(window);
        families = [...new Set(
          (fonts ?? [])
            .map((f) => String(f?.family ?? '').trim())
            .filter((f) => f.length > 0),
        )].sort((a, b) => a.localeCompare(b));
      }
    } catch {
      families = [];
    }
    const result = families.length > 0 ? families : FALLBACK_FONTS;
    fontListCache = result;
    return result;
  })();

  return fontListPromise;
}

const ITEM_HEIGHT = 26;
const LIST_MAX_HEIGHT = 234; // 9 rows

export interface FontPickerProps {
  value: string;
  onChange: (family: string) => void;
}

export function FontPicker({ value, onChange }: FontPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<string[] | null>(fontListCache);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listWrapRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const all = fonts ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((f) => f.toLowerCase().includes(q));
  }, [fonts, search]);

  const listHeight = Math.max(
    ITEM_HEIGHT,
    Math.min(filtered.length * ITEM_HEIGHT, LIST_MAX_HEIGHT),
  );

  /** VirtualList's root div (our wrapper's only child) is the scroll container. */
  const getScroller = (): HTMLElement | null =>
    (listWrapRef.current?.firstElementChild as HTMLElement | null) ?? null;

  const scrollIndexIntoView = (index: number): void => {
    const scroller = getScroller();
    if (!scroller) return;
    const top = index * ITEM_HEIGHT;
    const bottom = top + ITEM_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    }
  };

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) {
      setSearch('');
      // Lazy-load local fonts on first open (may show a permission prompt).
      if (!fonts) void loadFontList().then(setFonts);
    }
  };

  // When the list becomes available while open (or on open), highlight and
  // reveal the currently selected family.
  useEffect(() => {
    if (!open || !fonts) return;
    const idx = Math.max(0, fonts.indexOf(value));
    setActiveIndex(idx);
    // Wait a frame so the portal + VirtualList have mounted and measured.
    const raf = requestAnimationFrame(() => scrollIndexIntoView(idx));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fonts]);

  // Reset the highlight when the filter changes.
  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const select = (family: string): void => {
    onChange(family);
    setOpen(false);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (filtered.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(filtered.length - 1, Math.max(0, activeIndex + dir));
      setActiveIndex(next);
      scrollIndexIntoView(next);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : filtered.length - 1;
      setActiveIndex(next);
      scrollIndexIntoView(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const family = filtered[activeIndex];
      if (family) select(family);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      placement="bottom-start"
      closeOnOutside
      closeOnEscape
      trigger={
        <button
          type="button"
          className={styles.trigger}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={value}
        >
          <span className={styles.triggerLabel} style={{ fontFamily: value }}>
            {value}
          </span>
          <Icon name="chevron-down" size="sm" className={styles.chevron} />
        </button>
      }
    >
      <div className={styles.panel}>
        <div className={styles.searchWrap}>
          <Input
            size="sm"
            leftIcon="search"
            placeholder="Search fonts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
            fullWidth
            autoFocus
            aria-label="Search fonts"
          />
        </div>
        {!fonts ? (
          <div className={styles.status}>Loading fonts…</div>
        ) : filtered.length === 0 ? (
          <div className={styles.status}>No fonts match “{search}”</div>
        ) : (
          <div
            ref={listWrapRef}
            className={styles.listWrap}
            style={{ height: listHeight }}
            role="listbox"
            aria-label="Font family"
          >
            <VirtualList
              items={filtered}
              itemHeight={ITEM_HEIGHT}
              height="100%"
              renderItem={(family, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={family === value}
                  className={cn(
                    styles.item,
                    i === activeIndex && styles.itemActive,
                    family === value && styles.itemSelected,
                  )}
                  onClick={() => select(family)}
                  onMouseEnter={() => setActiveIndex(i)}
                  title={family}
                >
                  <span className={styles.itemLabel} style={{ fontFamily: family }}>
                    {family}
                  </span>
                  {family === value ? (
                    <Icon name="check" size="sm" className={styles.check} />
                  ) : null}
                </button>
              )}
            />
          </div>
        )}
      </div>
    </Popover>
  );
}

export default FontPicker;
