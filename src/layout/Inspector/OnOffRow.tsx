/**
 * OnOffRow — a property whose value is On or Off, as After Effects draws one
 * (Casts Shadows, Depth of Field): the name in the panel `label` role, then
 * the state as a VALUE you click — the value role and colour a ValueField
 * draws — with `aria-pressed` carrying it (2026-10-08).
 *
 * The panel grammar (typography.css, "Panel type roles") rules out the two
 * things this replaced: a checkbox in a twirl header (a group only opens and
 * closes) and a bare checkbox beside a label (a toggle reads as a value).
 */

import styles from './TransformSection.module.css';

export interface OnOffRowProps {
  /** The property's name; also the toggle's accessible name. */
  label: string;
  on: boolean;
  onToggle: () => void;
  /** What the property does — a tooltip, never a paragraph in the list. */
  title?: string;
}

export function OnOffRow({ label, on, onToggle, title }: OnOffRowProps): JSX.Element {
  return (
    <div className={styles.popoverRow}>
      <span className={styles.popoverLabel} title={title}>{label}</span>
      <button type="button" className={styles.onOffValue} aria-pressed={on} aria-label={label} title={title} onClick={onToggle}>
        {on ? 'On' : 'Off'}
      </button>
    </div>
  );
}

export default OnOffRow;
