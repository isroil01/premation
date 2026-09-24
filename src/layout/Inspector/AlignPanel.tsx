import { useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveCompSize } from './inspectorMirror';
import { distributeMinimum, type AlignMode } from '@core/scene/alignNodes';
import { alignLayers } from './inspectorEdits';
import { Icon, type IconName } from '@components/Icon';
import { cn } from '@utils/cn';
import styles from './AlignSection.module.css';

const ALIGN_ACTIONS: { id: AlignMode; icon: IconName; label: string }[] = [
  { id: 'left',      icon: 'align-left',   label: 'Align Left' },
  { id: 'center-h',  icon: 'align-center', label: 'Align Horizontal Centers' },
  { id: 'right',     icon: 'align-right',  label: 'Align Right' },
  { id: 'top',       icon: 'align-top',    label: 'Align Top' },
  { id: 'middle-v',  icon: 'align-middle', label: 'Align Vertical Centers' },
  { id: 'bottom',    icon: 'align-bottom', label: 'Align Bottom' },
];

/**
 * AE's Distribute row: the six edge / centre buttons in AE's order, then the
 * two Distribute Spacing buttons. The edge buttons reuse the align glyph of the
 * edge they space (there is no separate distribute-by-edge glyph in the set);
 * the tooltips carry the distinction.
 */
const DISTRIBUTE_ACTIONS: { id: AlignMode; icon: IconName; label: string }[] = [
  { id: 'distribute-top',     icon: 'align-top',             label: 'Distribute Top Edges' },
  { id: 'distribute-v',       icon: 'align-middle',          label: 'Distribute Vertical Centers' },
  { id: 'distribute-bottom',  icon: 'align-bottom',          label: 'Distribute Bottom Edges' },
  { id: 'distribute-left',    icon: 'align-left',            label: 'Distribute Left Edges' },
  { id: 'distribute-h',       icon: 'align-center',          label: 'Distribute Horizontal Centers' },
  { id: 'distribute-right',   icon: 'align-right',           label: 'Distribute Right Edges' },
  { id: 'distribute-space-h', icon: 'distribute-horizontal', label: 'Distribute Horizontal Spacing' },
  { id: 'distribute-space-v', icon: 'distribute-vertical',   label: 'Distribute Vertical Spacing' },
];

/**
 * Align — two rows of flat icon buttons under one "relative to" switch.
 *
 * The buttons are ghost controls in a grid, not eight bordered boxes: a panel
 * whose every control is outlined reads as a form, and this is a toolbar.
 * Disabled buttons stay in place (dimmed) so the grid never reflows as the
 * selection changes.
 */
export function AlignPanel(): JSX.Element {
  const selectedIds = useSelectionStore((s) => s.ids);
  const [alignTo, setAlignTo] = useState<'selection' | 'composition'>('selection');

  const { width: compWidth, height: compHeight } = useActiveCompSize();

  const alignMin = alignTo === 'composition' ? 1 : 2;
  // B3-legacy: not a write — the ratchet's `distribute…` verb match on a pure count (rule false positive; belongs in NOT_WRITES).
  const distributeMin = distributeMinimum(alignTo);
  const count = selectedIds.length;

  const run = (mode: AlignMode): void => alignLayers(selectedIds, mode, alignTo, compWidth, compHeight);

  const renderButton = (a: { id: AlignMode; icon: IconName; label: string }, min: number): JSX.Element => {
    const disabled = count < min;
    const hint = disabled ? ` — select ${min}+ layers` : '';
    return (
      <button
        key={a.id}
        type="button"
        className={styles.button}
        aria-label={a.label}
        title={`${a.label}${hint}`}
        disabled={disabled}
        onClick={() => run(a.id)}
      >
        <Icon name={a.icon} size="md" />
      </button>
    );
  };

  return (
    <div className={styles.panelRoot}>
      <div className={styles.targetRow}>
        <span className={styles.groupLabel}>Relative to</span>
        <div className={styles.segmented} role="radiogroup" aria-label="Align relative to">
          <button
            type="button"
            role="radio"
            aria-checked={alignTo === 'selection'}
            className={cn(styles.segment, alignTo === 'selection' && styles.segmentActive)}
            onClick={() => setAlignTo('selection')}
            title="Align to the selection's bounding box"
          >
            Selection
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={alignTo === 'composition'}
            className={cn(styles.segment, alignTo === 'composition' && styles.segmentActive)}
            onClick={() => setAlignTo('composition')}
            title="Align to the composition frame"
          >
            Composition
          </button>
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Align</span>
        <div className={styles.grid} role="group" aria-label="Align">
          {ALIGN_ACTIONS.map((a) => renderButton(a, alignMin))}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Distribute</span>
        <div className={styles.grid} role="group" aria-label="Distribute">
          {DISTRIBUTE_ACTIONS.slice(0, 6).map((a) => renderButton(a, distributeMin))}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Distribute Spacing</span>
        <div className={styles.grid} role="group" aria-label="Distribute Spacing">
          {DISTRIBUTE_ACTIONS.slice(6).map((a) => renderButton(a, distributeMin))}
        </div>
      </div>

      <p className={styles.hint}>
        {count === 0
          ? 'Select layers on the canvas or in the timeline to align them.'
          : alignTo === 'selection'
            ? 'Aligns the selected layers to each other. Distribute needs three or more; the outermost two stay put.'
            : 'Aligns each selected layer to the composition frame. Distribute spreads them edge to edge across it.'}
      </p>
    </div>
  );
}
