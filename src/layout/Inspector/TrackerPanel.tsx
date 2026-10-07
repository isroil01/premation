import { useFootageSource } from '@hooks/useFootageSource';
import { TrackMotionSection } from './TrackMotionSection';
import styles from './CharacterPanel.module.css';

export function TrackerPanel(): JSX.Element {
  // The selected footage layer, else the one chosen below, else the first.
  const source = useFootageSource();
  const activeSourceId = source.activeId;

  if (!activeSourceId) {
    return (
      <div className={styles.root}>
        <div className={styles.emptyHint}>
          No video or footage layer found in composition. Import a video footage file to use Motion Tracking, Camera Tracking, or Warp Stabilization.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.col} style={{ marginBottom: 'var(--space-2)' }}>
        <span className={styles.sectionTitle}>Motion Source</span>
        <select
          aria-label="Motion Source"
          value={activeSourceId}
          onChange={(e) => source.choose(e.target.value)}
          className={styles.fontSelect}
        >
          {source.layers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} {l.id === source.selectedId ? '(Selected)' : ''}
            </option>
          ))}
        </select>
      </div>

      <TrackMotionSection nodeId={activeSourceId} />
    </div>
  );
}
