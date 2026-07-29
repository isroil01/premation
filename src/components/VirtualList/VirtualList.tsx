/**
 * VirtualList — renders only the visible window of a large list.
 *
 * <VirtualList
 *   items={items}            // up to ~1M elements
 *   itemHeight={28}          // px; fixed height for fast math
 *   overscan={6}
 *   renderItem={(item, i) => <Row... />}
 * />
 *
 * For variable heights use the `estimatedItemHeight` and let users override
 * via the `onMeasured` callback — or switch to a virtualization library
 * later. For now, fixed height is the simple, fast path the timeline uses.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@utils/cn';
import styles from './VirtualList.module.css';

export interface VirtualListProps<T> {
  items: ReadonlyArray<T>;
  itemHeight: number;
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  /** Render header content above the list (inside the scroll container). */
  header?: ReactNode;
  /** Render footer content below the list (inside the scroll container). */
  footer?: ReactNode;
  /** Optional fixed total height override (defaults to parent's height). */
  height?: number | string;
  /** Current scrollTop (controlled). */
  scrollTop?: number;
  /** Fires when the user scrolls. */
  onScroll?: (scrollTop: number) => void;
}

export function VirtualList<T>({
  items,
  itemHeight,
  overscan = 6,
  renderItem,
  className,
  header,
  footer,
  height = '100%',
  scrollTop,
  onScroll,
}: VirtualListProps<T>): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [internalScrollTop, setInternalScrollTop] = useState(0);

  const currentScrollTop = scrollTop ?? internalScrollTop;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalHeight = items.length * itemHeight;
  const startIndex = Math.max(0, Math.floor(currentScrollTop / itemHeight) - overscan);
  const endIndex = Math.min(
    items.length,
    Math.ceil((currentScrollTop + viewportHeight) / itemHeight) + overscan,
  );

  const visible = items.slice(startIndex, endIndex);

  const onScrollHandler = (e: React.UIEvent<HTMLDivElement>): void => {
    const top = e.currentTarget.scrollTop;
    if (scrollTop === undefined) setInternalScrollTop(top);
    onScroll?.(top);
  };

  return (
    <div
      ref={ref}
      className={cn(styles.root, className)}
      style={{ height }}
      onScroll={onScrollHandler}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {header ? <div className={styles.header}>{header}</div> : null}
        <div
          className={styles.window}
          style={{ transform: `translateY(${startIndex * itemHeight}px)` }}
        >
          {visible.map((item, i) => (
            <div
              key={startIndex + i}
              className={styles.row}
              style={{ height: itemHeight }}
              data-index={startIndex + i}
            >
              {renderItem(item, startIndex + i)}
            </div>
          ))}
        </div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
