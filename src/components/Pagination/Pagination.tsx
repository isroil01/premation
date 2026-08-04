/**
 * Pagination — the page control for a server-paged list.
 *
 * Every list in this app is paged at the API (`{items, total, limit, offset}`),
 * but the UI used to ask for one page of 50 and render it as if it were
 * everything. That is the failure mode paging is supposed to prevent: it looks
 * correct until an account passes 50 rows, and then rows simply stop existing
 * with nothing on screen admitting it.
 *
 * So this component always states the truth — "25–48 of 143" — and only then
 * offers the controls to move. It is presentational: it owns no fetching, and
 * reports the `{limit, offset}` the caller should load next.
 */

import { useMemo } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import styles from './Pagination.module.css';

export interface PaginationProps {
  /** Rows matching the query, ignoring paging. From the API's `total`. */
  total: number;
  limit: number;
  offset: number;
  onChange: (page: { limit: number; offset: number }) => void;
  /** Singular noun for the count line: "project" → "…of 143 projects". */
  itemLabel?: string;
  /** Offered page sizes. Hidden when the list fits in the smallest one. */
  pageSizes?: number[];
  /** A request is in flight — the controls stay visible but stop responding. */
  busy?: boolean;
  className?: string;
}

const DEFAULT_PAGE_SIZES = [12, 24, 48, 96];

/**
 * The page numbers to render, with `null` for a gap.
 *
 * Always includes the first and last page, and a window around the current one,
 * so the control's width doesn't grow with the library.
 */
function pageWindow(current: number, count: number): Array<number | null> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);

  const pages = new Set<number>([1, count, current]);
  if (current - 1 > 1) pages.add(current - 1);
  if (current + 1 < count) pages.add(current + 1);
  // Keep the row a stable width near the ends, where the window is clipped.
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (current >= count - 2) [count - 3, count - 2, count - 1].forEach((p) => pages.add(p));

  const sorted = [...pages].filter((p) => p >= 1 && p <= count).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

export function Pagination({
  total,
  limit,
  offset,
  onChange,
  itemLabel = 'item',
  pageSizes = DEFAULT_PAGE_SIZES,
  busy = false,
  className,
}: PaginationProps): JSX.Element | null {
  const size = Math.max(1, limit);
  const pageCount = Math.max(1, Math.ceil(total / size));
  // Clamp: a delete can leave `offset` past the end of a shrunken list.
  const current = Math.min(pageCount, Math.floor(offset / size) + 1);
  const from = total === 0 ? 0 : (current - 1) * size + 1;
  const to = Math.min(total, current * size);

  const pages = useMemo(() => pageWindow(current, pageCount), [current, pageCount]);

  if (total === 0) return null;

  const goto = (page: number): void => {
    const next = Math.min(pageCount, Math.max(1, page));
    if (next === current) return;
    onChange({ limit: size, offset: (next - 1) * size });
  };

  const sizes = pageSizes.includes(size) ? pageSizes : [...pageSizes, size].sort((a, b) => a - b);
  const showSizes = total > Math.min(...sizes);

  return (
    <nav className={cn(styles.root, className)} aria-label="Pagination">
      <span className={styles.count}>
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}{' '}
        {total === 1 ? itemLabel : `${itemLabel}s`}
      </span>

      <div className={styles.controls}>
        {showSizes && (
          <label className={styles.sizeLabel}>
            <span>Rows</span>
            <select
              className={styles.sizeSelect}
              value={size}
              disabled={busy}
              onChange={(e) => {
                const nextSize = Number(e.target.value);
                // Keep the first visible row visible, so changing the page size
                // doesn't teleport the reader somewhere unrelated.
                const anchor = (current - 1) * size;
                onChange({ limit: nextSize, offset: Math.floor(anchor / nextSize) * nextSize });
              }}
            >
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}

        {pageCount > 1 && (
          <div className={styles.pager}>
            <button
              type="button"
              className={styles.step}
              onClick={() => goto(current - 1)}
              disabled={busy || current === 1}
              aria-label="Previous page"
            >
              <Icon name="chevron-left" size={13} />
            </button>

            {pages.map((p, i) =>
              p === null ? (
                <span key={`gap-${i}`} className={styles.gap} aria-hidden="true">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  className={cn(styles.page, p === current && styles.pageActive)}
                  onClick={() => goto(p)}
                  disabled={busy}
                  aria-current={p === current ? 'page' : undefined}
                  aria-label={`Page ${p}`}
                >
                  {p}
                </button>
              ),
            )}

            <button
              type="button"
              className={styles.step}
              onClick={() => goto(current + 1)}
              disabled={busy || current === pageCount}
              aria-label="Next page"
            >
              <Icon name="chevron-right" size={13} />
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
