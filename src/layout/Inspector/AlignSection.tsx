import { useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { alignNodes, type AlignMode } from '@core/scene/alignNodes';
import { Icon, type IconName } from '@components/Icon';
import styles from './AlignSection.module.css';

const ALIGN_ACTIONS: { id: AlignMode; icon: IconName; label: string }[] = [
  { id: 'left',          icon: 'align-left',           label: 'Align Left' },
  { id: 'center-h',     icon: 'align-center',          label: 'Align Centers (H)' },
  { id: 'right',        icon: 'align-right',           label: 'Align Right' },
  { id: 'top',          icon: 'align-top',             label: 'Align Top' },
  { id: 'middle-v',     icon: 'align-middle',          label: 'Align Middles (V)' },
  { id: 'bottom',       icon: 'align-bottom',          label: 'Align Bottom' },
  { id: 'distribute-h', icon: 'distribute-horizontal', label: 'Distribute Horizontally' },
  { id: 'distribute-v', icon: 'distribute-vertical',   label: 'Distribute Vertically' },
];

export function AlignSection(): JSX.Element | null {
  const selectedIds = useSelectionStore((s) => s.ids);
  const [alignTo, setAlignTo] = useState<'selection' | 'composition'>('selection');

  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);

  if (selectedIds.length === 0) return null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>Align & Distribute</div>

      <div className={styles.targetRow}>
        <span className={styles.targetLabel}>Align Layers to:</span>
        <div className={styles.targetToggles}>
          <button
            type="button"
            className={alignTo === 'selection' ? styles.targetBtnActive : styles.targetBtn}
            onClick={() => setAlignTo('selection')}
            title="Align relative to selected layers bounding box"
          >
            <Icon name="select-all" size={12} />
            <span>Selection</span>
          </button>
          <button
            type="button"
            className={alignTo === 'composition' ? styles.targetBtnActive : styles.targetBtn}
            onClick={() => setAlignTo('composition')}
            title="Align relative to active composition canvas boundaries"
          >
            <Icon name="solid" size={12} />
            <span>Composition</span>
          </button>
        </div>
      </div>

      <div className={styles.grid}>
        {ALIGN_ACTIONS.map((a) => {
          const isDistribute = a.id.startsWith('distribute');
          const isDisabled = isDistribute
            ? (alignTo === 'composition' ? selectedIds.length < 2 : selectedIds.length < 3)
            : (alignTo === 'composition' ? selectedIds.length < 1 : selectedIds.length < 2);

          const titleTip = isDistribute
            ? `${a.label}${alignTo === 'composition' ? ' (select 2+ layers)' : ' (select 3+ layers)'}`
            : `${a.label}${alignTo === 'composition' ? '' : ' (select 2+ layers)'}`;

          return (
            <button
              key={a.id}
              type="button"
              className={styles.button}
              aria-label={a.label}
              title={titleTip}
              disabled={isDisabled}
              onClick={() => alignNodes([...selectedIds], a.id, alignTo, compWidth, compHeight)}
            >
              <Icon name={a.icon} size={14} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
