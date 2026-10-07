/**
 * TwirlGroup — one After Effects twirl-down inside a section: a 22px row with
 * ▶/▼, the group's name, a one-line summary of its state while closed, and
 * optional controls on the right (an enable box, a remove ✕, AE's Dashes + / −).
 *
 * It is how Contents reads like AE's timeline (2026-10-07): each fill and
 * stroke is one closed row that says what it is ("4.0 · Inside"), and Dashes,
 * Taper and Wave say "off" until opened, instead of every option of every
 * stroke being open at once.
 *
 * The open state is remembered in `preferenceStore.inspectorSections` under
 * `prefKey`, like Transform's "More": the section remounts on every selection
 * change, so component state would snap shut each time a layer is clicked.
 */

import type { ReactNode } from 'react';
import { usePreferenceStore } from '@stores/preferenceStore';
import styles from './TwirlGroup.module.css';

export interface TwirlGroupProps {
  /** Key into the remembered open/closed map. */
  prefKey: string;
  label: ReactNode;
  /** Used until the user twirls it once. */
  defaultOpen: boolean;
  /** Drawn after the label while closed. */
  summary?: ReactNode;
  /** Controls on the row's right, drawn open or closed. */
  trailing?: ReactNode;
  children: ReactNode;
}

export function TwirlGroup({ prefKey, label, defaultOpen, summary, trailing, children }: TwirlGroupProps): JSX.Element {
  const remembered = usePreferenceStore((s) => s.inspectorSections[prefKey]);
  const setPref = usePreferenceStore((s) => s.set);
  const open = remembered ?? defaultOpen;
  const toggle = (): void => {
    setPref('inspectorSections', { ...usePreferenceStore.getState().inspectorSections, [prefKey]: !open });
  };
  return (
    <div className={styles.group}>
      <div className={styles.head}>
        <button type="button" className={styles.twirl} aria-expanded={open} data-twirl="" onClick={toggle}>
          <span className={styles.arrow} aria-hidden>{open ? '▼' : '▶'}</span>
          <span className={styles.label}>{label}</span>
        </button>
        {!open && summary !== undefined && <span className={styles.summary}>{summary}</span>}
        {trailing !== undefined && <span className={styles.trailing}>{trailing}</span>}
      </div>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  );
}

/** A colour chip for a summary — the paint itself, as AE's swatch column shows it. */
export function SummaryChip({ color, stroke = false }: { color: string; stroke?: boolean }): JSX.Element {
  return (
    <span
      className={stroke ? styles.chipStroke : styles.chip}
      style={stroke ? { borderColor: color } : { background: color }}
      aria-hidden
    />
  );
}

export default TwirlGroup;
