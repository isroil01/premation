/**
 * InspectorSection — the one shell every inspector section is drawn in.
 *
 * ## Why a wrapper rather than a convention
 *
 * The inspector had four idioms for the same thing. `TextAnimatorControls`,
 * `PathOpControls` and `ShapeEffects` each drew a `.head` strip with a title
 * and an add/remove control; `LayerStylesControls` and `AppearanceSection` drew
 * `.blendRow` label/value pairs with the label width decided per row; the
 * accordion drew a fifth header above all of them. Four answers to "where does
 * a section's name go, and where does its menu go" is four chances to disagree,
 * and they did — in gutter, in label column, and in which corner the kebab sat.
 *
 * This is the answer, and it is deliberately SMALL:
 *
 *   • a title row, optional — the accordion already names the section, so a
 *     section only draws one when it holds several cards that need naming
 *     (each path operator, each layer style);
 *   • an optional disclosure twisty, an optional enable checkbox, and one
 *     `actions` slot on the right for the kebab / add / move-remove controls,
 *     so those never migrate to the left or to the bottom of a card;
 *   • a content column with ONE gap token.
 *
 * ## What it deliberately does not do
 *
 * No outer padding. The gutter belongs to whatever hosts the section — the
 * accordion's `.panel` already sets `--space-5` on the left and every section
 * inherits it, so adding a second inset here would put sections two gutters in
 * from the search box above them. That mismatch is the exact bug the accordion
 * comment upstream records; this must not reintroduce it one level down.
 *
 * Fully controlled and hook-free: `open` and `enabled` are props, never state.
 * A section that owns its own disclosure state keeps owning it.
 */

import type { ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import { Checkbox } from '@components/Checkbox';
import styles from './InspectorSection.module.css';

export interface InspectorSectionProps {
  /** Section name. Omitted → no title row at all (the accordion names it). */
  title?: ReactNode;
  /** Glyph left of the title. */
  icon?: IconName;
  /**
   * Disclosure state. Provide BOTH this and `onToggle` to get a twisty; the
   * content is then hidden (not unmounted) while closed, matching the
   * accordion — a card that unmounts loses any in-flight edit inside it.
   */
  open?: boolean;
  onToggle?: (next: boolean) => void;
  /** Enable checkbox in the title row, for a section that can be switched off. */
  enabled?: boolean;
  onEnabledChange?: (next: boolean) => void;
  /** Accessible name for the enable checkbox. Defaults to the title. */
  enableLabel?: string;
  /** The right-hand slot: a kebab, an Add dropdown, move/remove buttons. */
  actions?: ReactNode;
  /**
   * A card INSIDE another section (one path operator, one layer style) rather
   * than a top-level section: a hairline above it and tighter rows.
   */
  nested?: boolean;
  children?: ReactNode;
  className?: string;
}

export function InspectorSection({
  title,
  icon,
  open,
  onToggle,
  enabled,
  onEnabledChange,
  enableLabel,
  actions,
  nested = false,
  children,
  className,
}: InspectorSectionProps): JSX.Element {
  const collapsible = onToggle !== undefined && open !== undefined;
  const isOpen = collapsible ? open === true : true;
  const titleText = typeof title === 'string' ? title : undefined;
  const hasHead = title !== undefined || actions !== undefined || onEnabledChange !== undefined;

  return (
    <section className={cn(styles.section, nested && styles.nested, className)}>
      {hasHead && (
        <div className={styles.head}>
          {collapsible && (
            <button
              type="button"
              className={styles.twisty}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${titleText ?? 'section'}`}
              onClick={() => onToggle?.(!isOpen)}
            >
              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size="sm" />
            </button>
          )}
          {onEnabledChange && (
            <Checkbox
              checked={enabled === true}
              onChange={(e) => onEnabledChange(e.currentTarget.checked)}
              aria-label={enableLabel ?? (titleText ? `Enable ${titleText}` : 'Enable section')}
            />
          )}
          {icon && <Icon name={icon} size="sm" className={styles.icon} />}
          {title !== undefined && <span className={styles.title}>{title}</span>}
          {/* Always last, always right — the whole reason this slot exists is
              that a kebab which moves between cards cannot be aimed at. */}
          {actions !== undefined && <span className={styles.actions}>{actions}</span>}
        </div>
      )}
      <div className={styles.body} hidden={collapsible && !isOpen}>
        {children}
      </div>
    </section>
  );
}

export default InspectorSection;
