import { useSelectionStore } from '@stores/selectionStore';
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

  // Alignment usually requires at least 2 layers, but let's show it if 1+ layer is selected
  if (selectedIds.length === 0) return null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>Align & Distribute</div>
      <div className={styles.grid}>
        {ALIGN_ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            className={styles.button}
            aria-label={a.label}
            title={`${a.label}${a.id.startsWith('distribute') ? (selectedIds.length < 3 ? ' (select 3+ layers)' : '') : (selectedIds.length < 2 ? ' (select 2+ layers)' : '')}`}
            disabled={a.id.startsWith('distribute') ? selectedIds.length < 3 : selectedIds.length < 2}
            onClick={() => alignNodes([...selectedIds], a.id)}
          >
            <Icon name={a.icon} size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}
