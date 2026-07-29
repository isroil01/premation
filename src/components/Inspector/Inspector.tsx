/**
 * Inspector — property editor panel layout.
 *
 * The Inspector is a list of Accordion sections, each describing a property
 * group (Transform, Material, Color,...). The contents are designed to be
 * supplied by future engines via the `groups` prop, so this component
 * itself contains zero property-rendering logic.
 *
 * It also provides a few utility row components (InspectorRow, InspectorField)
 * for engines to use when defining groups.
 */

import { type ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { Icon } from '@components/Icon';
import styles from './Inspector.module.css';

export interface InspectorGroup {
  id: string;
  title: ReactNode;
  icon?: import('@components/Icon').IconName;
  badge?: ReactNode;
  fields: ReactNode;
  defaultOpen?: boolean;
}

export interface InspectorProps {
  groups: ReadonlyArray<InspectorGroup>;
  className?: string;
  emptyMessage?: ReactNode;
}

export function Inspector({ groups, className, emptyMessage = 'No selection' }: InspectorProps): JSX.Element {
  if (groups.length === 0) {
    return (
      <div className={cn(styles.empty, className)}>
        <div className={styles.emptyInner}>
          <span className={styles.emptyIcon} aria-hidden>
            <Icon name="mouse-pointer" size={15} />
          </span>
          {emptyMessage}
        </div>
      </div>
    );
  }

  const items: AccordionItem[] = groups.map((g) => ({
    id: g.id,
    title: g.title,
    icon: g.icon,
    badge: g.badge,
    content: <div className={styles.fields}>{g.fields}</div>,
    defaultOpen: g.defaultOpen,
  }));

  return (
    <div className={cn(styles.root, className)}>
      <Accordion items={items} />
    </div>
  );
}

/** Single labeled row inside an Inspector group. */
export function InspectorRow({ label, children, className, align = 'baseline' }: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  align?: 'baseline' | 'center';
}): JSX.Element {
  return (
    <div className={cn(styles.row, className)} data-align={align}>
      <div className={styles.rowLabel}>{label}</div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

/** Field with an inline label and a control, used for compact two-line fields. */
export function InspectorField({ label, children, className }: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn(styles.field, className)}>
      <div className={styles.fieldLabel}>{label}</div>
      <div className={styles.fieldControl}>{children}</div>
    </div>
  );
}
