/**
 * Tabs — segmented tab control with keyboard navigation.
 *
 * Accessibility:
 *   - role="tablist" on the container
 *   - role="tab" + aria-selected on triggers
 *   - role="tabpanel" + aria-labelledby on panels
 *   - Arrow Left/Right (or Up/Down for vertical) moves focus
 *   - Home/End jump to first/last
 */

import {
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '@utils/cn';
import styles from './Tabs.module.css';

export interface TabsProps {
  value: string;
  onChange: (value: string) => void;
  items: ReadonlyArray<{
    id: string;
    label: ReactNode;
    icon?: ReactNode;
    closable?: boolean;
    onClose?: () => void;
    /**
     * Accessible name for an ICON-ONLY tab. With `label: ''` the button has no
     * text and an unlabelled `<svg>`, so assistive tech announces nothing at
     * all — the sidebar rail reads as a column of anonymous buttons.
     */
    ariaLabel?: string;
  }>;
  size?: 'sm' | 'md';
  variant?: 'default' | 'bordered' | 'pill';
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

export function Tabs({
  value,
  onChange,
  items,
  size = 'md',
  variant = 'default',
  orientation = 'horizontal',
  className,
}: TabsProps): JSX.Element {
  const baseId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusIndex = (i: number): void => {
    const idx = (i + items.length) % items.length;
    onChange(items[idx]!.id);
    refs.current[idx]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, currentIndex: number): void => {
    const prevKey = orientation === 'horizontal' ? 'ArrowLeft'  : 'ArrowUp';
    const nextKey = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === prevKey) { e.preventDefault(); focusIndex(currentIndex - 1); }
    else if (e.key === nextKey) { e.preventDefault(); focusIndex(currentIndex + 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusIndex(0); }
    else if (e.key === 'End')  { e.preventDefault(); focusIndex(items.length - 1); }
  };

  return (
    <div
      role="tablist"
      aria-orientation={orientation}
      className={cn(styles.list, styles[variant], styles[size], styles[orientation], className)}
      data-variant={variant}
      data-size={size}
    >
      {items.map((item, i) => {
        const selected = item.id === value;
        const tabId = `${baseId}-tab-${item.id}`;
        return (
          <button
            key={item.id}
            ref={(el) => { refs.current[i] = el; }}
            id={tabId}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-label={item.ariaLabel}
            tabIndex={selected ? 0 : -1}
            data-selected={selected || undefined}
            className={cn(styles.tab, selected && styles.selected)}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
            {item.label ? <span className={styles.label}>{item.label}</span> : null}
            {item.closable ? (
              <span
                role="button"
                aria-label={`Close ${typeof item.label === 'string' ? item.label : item.id}`}
                className={styles.close}
                onClick={(e) => { e.stopPropagation(); item.onClose?.(); }}
              >
                ×
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Convenience wrapper for tab content panels. */
export function TabPanel({
  value,
  active,
  children,
  className,
}: {
  value: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}): JSX.Element | null {
  if (!active) return null;
  return (
    <div
      role="tabpanel"
      aria-labelledby={value}
      className={cn(styles.panel, className)}
    >
      {children}
    </div>
  );
}
