/**
 * Accordion — vertically stacked, independently collapsible sections.
 * Used by the Inspector for property groups.
 */

import { useId, useState, type ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Icon } from '@components/Icon';
import styles from './Accordion.module.css';

export interface AccordionItem {
  id: string;
  title: ReactNode;
  /** Optional icon for the header. */
  icon?: import('@components/Icon').IconName;
  /** Optional badge content on the right. */
  badge?: ReactNode;
  content: ReactNode;
  defaultOpen?: boolean;
  disabled?: boolean;
  /**
   * Render `content` only while the section is open (default: always mounted,
   * merely `hidden`). For sections whose MOUNT has side effects — e.g. Track
   * Motion arms the canvas overlay — staying mounted while collapsed runs
   * those effects for every selection.
   */
  mountOnOpen?: boolean;
}

export interface AccordionProps {
  items: ReadonlyArray<AccordionItem>;
  /** When true, only one item is open at a time. */
  exclusive?: boolean;
  className?: string;
}

export function Accordion({ items, exclusive = false, className }: AccordionProps): JSX.Element {
  const baseId = useId();
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>();
    items.forEach((i) => { if (i.defaultOpen) s.add(i.id); });
    return s;
  });

  const toggle = (id: string): void => {
    const next = new Set(open);
    if (exclusive) {
      if (next.has(id)) next.delete(id);
      else { next.clear(); next.add(id); }
    } else {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    setOpen(next);
  };

  return (
    <div className={cn(styles.root, className)}>
      {items.map((item) => {
        const isOpen = open.has(item.id);
        const panelId = `${baseId}-p-${item.id}`;
        const btnId = `${baseId}-b-${item.id}`;
        return (
          <div key={item.id} className={cn(styles.item, item.disabled && styles.disabled)}>
            <h3 className={styles.header}>
              <button
                id={btnId}
                type="button"
                className={styles.trigger}
                onClick={() => toggle(item.id)}
                aria-expanded={isOpen}
                aria-controls={panelId}
                aria-disabled={item.disabled}
                disabled={item.disabled}
              >
                <Icon
                  name={isOpen ? 'chevron-down' : 'chevron-right'}
                  size="sm"
                  className={styles.chevron}
                />
                {item.icon ? <Icon name={item.icon} size="md" className={styles.icon} /> : null}
                <span className={styles.title}>{item.title}</span>
                {item.badge ? <span className={styles.badge}>{item.badge}</span> : null}
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={btnId}
              hidden={!isOpen}
              className={styles.panel}
            >
              {item.mountOnOpen && !isOpen ? null : item.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}
