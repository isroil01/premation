import { useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { alignNodes, type AlignMode } from '@core/scene/alignNodes';
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

const DISTRIBUTE_ACTIONS: { id: AlignMode; icon: IconName; label: string }[] = [
  { id: 'distribute-h', icon: 'distribute-horizontal', label: 'Distribute Horizontally' },
  { id: 'distribute-v', icon: 'distribute-vertical',   label: 'Distribute Vertically' },
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

  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);

  const alignMin = alignTo === 'composition' ? 1 : 2;
  const distributeMin = alignTo === 'composition' ? 2 : 3;
  const count = selectedIds.length;

  const run = (mode: AlignMode): void => alignNodes([...selectedIds], mode, alignTo, compWidth, compHeight);

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
          {DISTRIBUTE_ACTIONS.map((a) => renderButton(a, distributeMin))}
        </div>
      </div>

      <p className={styles.hint}>
        {count === 0
          ? 'Select layers on the canvas or in the timeline to align them.'
          : alignTo === 'selection'
            ? 'Aligns the selected layers to each other. Distribute needs three or more.'
            : 'Aligns each selected layer to the composition frame.'}
      </p>
    </div>
  );
}
