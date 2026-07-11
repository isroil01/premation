/**
 * List — small non-virtualized list with selection and keyboard nav.
 * Use VirtualList for large collections.
 */

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@utils/cn';
import styles from './List.module.css';

export interface ListItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}

export interface ListProps {
  items: ReadonlyArray<ListItem>;
  className?: string;
  emptyMessage?: ReactNode;
  /** Density of rows. */
  size?: 'sm' | 'md';
}

export function List({ items, className, emptyMessage = 'No items', size = 'md' }: ListProps): JSX.Element {
  const ref = useRef<HTMLUListElement | null>(null);

  const onKey = (e: KeyboardEvent<HTMLUListElement>): void => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? []);
      const i = all.indexOf(active);
      const next = e.key === 'ArrowDown' ? all[i + 1] : all[i - 1];
      next?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      ref.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      const all = ref.current?.querySelectorAll<HTMLElement>('[role="option"]');
      all?.[all.length - 1]?.focus();
    }
  };

  if (items.length === 0) {
    return <div className={cn(styles.empty, className)}>{emptyMessage}</div>;
  }

  return (
    <ul
      ref={ref}
      role="listbox"
      className={cn(styles.root, className)}
      data-size={size}
      onKeyDown={onKey}
    >
      {items.map((item) => (
        <li
          key={item.id}
          role="option"
          tabIndex={item.selected ? 0 : -1}
          aria-selected={item.selected}
          aria-disabled={item.disabled}
          data-selected={item.selected || undefined}
          className={cn(styles.item, item.selected && styles.selected, item.disabled && styles.disabled)}
          onClick={() => { if (!item.disabled) item.onSelect?.(); }}
        >
          {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
          <span className={styles.body}>
            <span className={styles.label}>{item.label}</span>
            {item.description ? <span className={styles.description}>{item.description}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
